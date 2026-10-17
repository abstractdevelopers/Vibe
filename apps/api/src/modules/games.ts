import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";
import { requireCircleMember } from "./access.js";
import { trackSafe } from "./analytics.js";
import { notifyUsers } from "./notifications.js";
import { walletBalance, postGameStake, postGamePayout, postGameRefund } from "../money/ledger.js";
import {
  applyWhotMove,
  createWhotState,
  whotView,
  type WhotState,
  type WhotMove,
} from "../games/whot.js";

/**
 * Games: live multiplayer inside Vibe.
 *
 * The server is the referee. A session stores its full engine state in
 * `game_sessions.state`; a move is validated against that state, persisted with
 * a monotonically increasing sequence, and only then broadcast. A client can
 * therefore never invent a win, and a replayed move (same sequence) is refused.
 *
 * Staking is optional and off by default per game. When on, each stake moves
 * real wallet Yens into the session's escrow account, and the pot is paid to the
 * winner with the platform's rake credited to revenue — all ordinary ledger
 * journals, so a game cannot create or destroy Yens. A game that is cancelled
 * before it starts refunds every stake exactly.
 */

/** Vibe's cut of a staked pot, in basis points (5%). */
export const GAME_RAKE_BPS = 500;

const createSessionSchema = z.object({
  gameId: z.string().min(1).max(40),
  scope: z.enum(["circle", "followers", "friends", "strangers", "invite"]).default("invite"),
  circleId: z.string().uuid().optional(),
  stakeMinor: z.number().int().nonnegative().max(100_000_000).default(0),
});

const moveSchema = z.object({
  move: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("play"),
      card: z.object({
        shape: z.enum(["circle", "triangle", "cross", "square", "star", "whot"]),
        number: z.number().int().min(1).max(20),
      }),
      callShape: z.enum(["circle", "triangle", "cross", "square", "star"]).optional(),
    }),
    z.object({ type: z.literal("draw") }),
  ]),
});

interface SessionRow {
  id: string; game_id: string; host_id: string; circle_id: string | null;
  scope: string; status: string; stake_minor: string; rake_bps: number;
  currency: string; pot_minor: string; winner_id: string | null; state: WhotState | null;
  journal_id: string | null;
}

async function loadSession(pool: AppContext["pool"], id: string): Promise<SessionRow | null> {
  return queryOne<SessionRow>(pool, "SELECT * FROM game_sessions WHERE id = $1", [id]);
}

/** The public shape of a session, with the viewer's own slice of the state. */
async function sessionView(ctx: AppContext, session: SessionRow, viewerId: string) {
  const players = await queryMany<{
    user_id: string; seat: number; status: string; staked_minor: string;
    handle: string; display_name: string; avatar_url: string | null;
  }>(
    ctx.pool,
    `SELECT p.user_id, p.seat, p.status, p.staked_minor, u.handle, u.display_name, u.avatar_url
       FROM game_players p JOIN users u ON u.id = p.user_id
      WHERE p.session_id = $1 ORDER BY p.seat`,
    [session.id],
  );
  const game = await queryOne<{ name: string; category: string; engine: string | null; min_players: number; max_players: number; stake_enabled: boolean; availability: string }>(
    ctx.pool,
    "SELECT name, category, engine, min_players, max_players, stake_enabled, availability FROM game_catalog WHERE id = $1",
    [session.game_id],
  );
  return {
    id: session.id,
    gameId: session.game_id,
    gameName: game?.name ?? session.game_id,
    category: game?.category ?? "other",
    engine: game?.engine ?? null,
    availability: game?.availability ?? "planned",
    minPlayers: game?.min_players ?? 2,
    maxPlayers: game?.max_players ?? 8,
    stakeEnabled: game?.stake_enabled ?? false,
    hostId: session.host_id,
    scope: session.scope,
    status: session.status,
    stakeMinor: Number(session.stake_minor),
    rakeBps: session.rake_bps,
    potMinor: Number(session.pot_minor),
    currency: session.currency,
    winnerId: session.winner_id,
    players: players.map((p) => ({
      ...publicUser({ id: p.user_id, handle: p.handle, display_name: p.display_name, avatar_url: p.avatar_url }),
      seat: p.seat,
      status: p.status,
      stakedMinor: Number(p.staked_minor),
    })),
    // Only a player sees the engine state, and only their own hand.
    state: session.state && players.some((p) => p.user_id === viewerId)
      ? whotView(session.state, viewerId)
      : null,
  };
}

/** Move the session's pot for a finished or cancelled game, exactly once. */
async function settleGame(
  tx: import("pg").PoolClient,
  session: SessionRow,
  outcome: { winnerId: string | null; refund: boolean },
): Promise<void> {
  const pot = Number(session.pot_minor);
  if (pot <= 0 || session.journal_id) return;
  const reference = `GAME-${session.id}`;
  if (outcome.refund) {
    const players = await queryMany<{ user_id: string; staked_minor: string }>(
      tx as unknown as AppContext["pool"],
      "SELECT user_id, staked_minor FROM game_players WHERE session_id = $1 AND staked_minor > 0",
      [session.id],
    );
    for (const p of players) {
      await postGameRefund(tx, {
        reference: `${reference}-${p.user_id}`,
        userId: p.user_id,
        amountMinor: Number(p.staked_minor),
        currency: session.currency,
      });
    }
    await tx.query("UPDATE game_sessions SET journal_id = NULL WHERE id = $1", [session.id]);
    return;
  }
  if (!outcome.winnerId) return;
  const rakeMinor = Math.floor((pot * session.rake_bps) / 10000);
  const journalId = await postGamePayout(tx, {
    reference,
    winnerId: outcome.winnerId,
    potMinor: pot,
    rakeMinor,
    currency: session.currency,
  });
  await tx.query("UPDATE game_sessions SET journal_id = $2 WHERE id = $1", [session.id, journalId]);
}

export function gameRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // ---- Catalogue ----
    app.get("/v1/games", async (req) => {
      await requireUser(ctx, req);
      const rows = await queryMany<{
        id: string; name: string; category: string; blurb: string; min_players: number;
        max_players: number; stake_enabled: boolean; availability: string; icon: string | null;
      }>(
        ctx.pool,
        `SELECT id, name, category, blurb, min_players, max_players, stake_enabled, availability, icon
           FROM game_catalog ORDER BY sort_order`,
      );
      return {
        games: rows.map((g) => ({
          id: g.id,
          name: g.name,
          category: g.category,
          blurb: g.blurb,
          minPlayers: g.min_players,
          maxPlayers: g.max_players,
          stakeEnabled: g.stake_enabled,
          availability: g.availability,
          icon: g.icon,
        })),
        rakeBps: GAME_RAKE_BPS,
        note: "Games marked 'planned' are listed but not yet playable; only 'playable' games can be started.",
      };
    });

    // ---- Open games to join ----
    app.get("/v1/games/sessions", async (req) => {
      const user = await requireUser(ctx, req);
      const q = req.query as { gameId?: string };
      const rows = await queryMany<SessionRow>(
        ctx.pool,
        `SELECT * FROM game_sessions
          WHERE status IN ('lobby', 'active')
            AND ($1::text IS NULL OR game_id = $1)
          ORDER BY created_at DESC LIMIT 50`,
        [q.gameId ?? null],
      );
      return { sessions: await Promise.all(rows.map((s) => sessionView(ctx, s, user.id))) };
    });

    app.post("/v1/games/sessions", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createSessionSchema, req.body);
      const game = await queryOne<{ availability: string; stake_enabled: boolean; min_players: number }>(
        ctx.pool,
        "SELECT availability, stake_enabled, min_players FROM game_catalog WHERE id = $1",
        [input.gameId],
      );
      if (!game) throw ApiError.notFound("That game does not exist");
      if (game.availability !== "playable") {
        throw ApiError.badRequest("That game is listed but not yet playable");
      }
      if (input.stakeMinor > 0 && !game.stake_enabled) {
        throw ApiError.badRequest("This game cannot be played for stakes");
      }
      if (input.circleId) await requireCircleMember(ctx.pool, input.circleId, user.id);
      const id = newId();
      await withTransaction(ctx.pool, async (tx) => {
        // The host is in their own game from the start, so their stake leaves
        // the wallet now rather than waiting for a join that will never come.
        if (input.stakeMinor > 0) {
          const balance = await walletBalance(tx as unknown as AppContext["pool"], user.id, "NGN");
          if (balance.balanceMinor < input.stakeMinor) throw ApiError.badRequest("Not enough Vibe Yens for this stake");
        }
        await tx.query(
          `INSERT INTO game_sessions (id, game_id, host_id, circle_id, scope, stake_minor, rake_bps, currency, pot_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'NGN',$8)`,
          [id, input.gameId, user.id, input.circleId ?? null, input.scope, input.stakeMinor, GAME_RAKE_BPS, input.stakeMinor],
        );
        await tx.query(
          "INSERT INTO game_players (session_id, user_id, seat, status, staked_minor) VALUES ($1,$2,0,'ready',$3)",
          [id, user.id, input.stakeMinor],
        );
        if (input.stakeMinor > 0) {
          await postGameStake(tx, {
            reference: `GAMESTAKE-${id}-${user.id}`,
            userId: user.id,
            amountMinor: input.stakeMinor,
            currency: "NGN",
          });
        }
      });
      trackSafe(ctx.pool, { name: "game_created", userId: user.id, properties: { entityType: "game_session", entityId: id, gameId: input.gameId } });
      reply.code(201);
      return { session: await sessionView(ctx, (await loadSession(ctx.pool, id))!, user.id) };
    });

    app.post("/v1/games/sessions/:id/join", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const session = await loadSession(ctx.pool, id);
      if (!session) throw ApiError.notFound("Game not found");
      if (session.status !== "lobby") throw ApiError.badRequest("This game has already started");
      const already = await queryOne<{ user_id: string }>(
        ctx.pool,
        "SELECT user_id FROM game_players WHERE session_id = $1 AND user_id = $2",
        [id, user.id],
      );
      if (already) return { session: await sessionView(ctx, session, user.id), joined: true };

      const game = await queryOne<{ max_players: number }>(ctx.pool, "SELECT max_players FROM game_catalog WHERE id = $1", [session.game_id]);
      const seated = await queryOne<{ n: string }>(ctx.pool, "SELECT count(*) AS n FROM game_players WHERE session_id = $1", [id]);
      if (Number(seated?.n ?? 0) >= (game?.max_players ?? 8)) throw ApiError.badRequest("This game is full");
      if (session.circle_id && session.scope === "circle") await requireCircleMember(ctx.pool, session.circle_id, user.id);

      const stake = Number(session.stake_minor);
      await withTransaction(ctx.pool, async (tx) => {
        // Re-read under lock so two joins cannot seat the same spot or overfill.
        const locked = await queryOne<{ stake_minor: string; status: string }>(
          tx as unknown as AppContext["pool"],
          "SELECT stake_minor, status FROM game_sessions WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!locked || locked.status !== "lobby") throw ApiError.badRequest("This game has already started");
        if (stake > 0) {
          const balance = await walletBalance(tx as unknown as AppContext["pool"], user.id, session.currency);
          if (balance.balanceMinor < stake) throw ApiError.badRequest("Not enough Vibe Yens for this stake");
          await postGameStake(tx, {
            reference: `GAMESTAKE-${id}-${user.id}`,
            userId: user.id,
            amountMinor: stake,
            currency: session.currency,
          });
        }
        const seatRow = await queryOne<{ next: string }>(
          tx as unknown as AppContext["pool"],
          "SELECT COALESCE(MAX(seat) + 1, 0) AS next FROM game_players WHERE session_id = $1",
          [id],
        );
        await tx.query(
          "INSERT INTO game_players (session_id, user_id, seat, status, staked_minor) VALUES ($1,$2,$3,'ready',$4)",
          [id, user.id, Number(seatRow?.next ?? 0), stake],
        );
        await tx.query("UPDATE game_sessions SET pot_minor = pot_minor + $2, updated_at = now() WHERE id = $1", [id, stake]);
      });
      await notifyUsers(ctx.pool, [session.host_id], "game.joined", "game_session", id, { from: user.handle });
      trackSafe(ctx.pool, { name: "game_joined", userId: user.id, properties: { entityType: "game_session", entityId: id } });
      reply.code(201);
      return { session: await sessionView(ctx, (await loadSession(ctx.pool, id))!, user.id), joined: true };
    });

    app.post("/v1/games/sessions/:id/start", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const session = await loadSession(ctx.pool, id);
      if (!session) throw ApiError.notFound("Game not found");
      if (session.host_id !== user.id) throw ApiError.forbidden("Only the host can start the game");
      if (session.status !== "lobby") throw ApiError.badRequest("This game has already started");
      const game = await queryOne<{ min_players: number; engine: string | null }>(
        ctx.pool,
        "SELECT min_players, engine FROM game_catalog WHERE id = $1",
        [session.game_id],
      );
      const players = await queryMany<{ user_id: string }>(
        ctx.pool,
        "SELECT user_id FROM game_players WHERE session_id = $1 AND status != 'left' ORDER BY seat",
        [id],
      );
      if (players.length < (game?.min_players ?? 2)) {
        throw ApiError.badRequest(`This game needs at least ${game?.min_players ?? 2} players`);
      }
      if (game?.engine !== "whot") throw ApiError.badRequest("That game has no engine yet");
      const order = players.map((p) => p.user_id);
      const seed = Math.floor(Date.now() % 2147483647) + order.length;
      const state = createWhotState(order, seed);
      await ctx.pool.query(
        "UPDATE game_sessions SET status = 'active', state = $2, updated_at = now() WHERE id = $1",
        [id, JSON.stringify(state)],
      );
      trackSafe(ctx.pool, { name: "game_started", userId: user.id, properties: { entityType: "game_session", entityId: id } });
      return { session: await sessionView(ctx, (await loadSession(ctx.pool, id))!, user.id) };
    });

    app.post("/v1/games/sessions/:id/move", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(moveSchema, req.body);
      const result = await withTransaction(ctx.pool, async (tx) => {
        const session = await queryOne<SessionRow>(
          tx as unknown as AppContext["pool"],
          "SELECT * FROM game_sessions WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!session) throw ApiError.notFound("Game not found");
        if (session.status !== "active") throw ApiError.badRequest("This game is not active");
        const isPlayer = await queryOne<{ user_id: string }>(
          tx as unknown as AppContext["pool"],
          "SELECT user_id FROM game_players WHERE session_id = $1 AND user_id = $2",
          [id, user.id],
        );
        if (!isPlayer) throw ApiError.forbidden("You are not in this game");
        let state = session.state!;
        try {
          state = applyWhotMove(state, user.id, input.move as WhotMove);
        } catch (err) {
          throw ApiError.badRequest(err instanceof Error ? err.message : "Illegal move");
        }
        const seqRow = await queryOne<{ next: string }>(
          tx as unknown as AppContext["pool"],
          "SELECT COALESCE(MAX(seq) + 1, 1) AS next FROM game_moves WHERE session_id = $1",
          [id],
        );
        const seq = Number(seqRow?.next ?? 1);
        await tx.query(
          "INSERT INTO game_moves (session_id, seq, user_id, move) VALUES ($1,$2,$3,$4)",
          [id, seq, user.id, JSON.stringify(input.move)],
        );
        if (state.finished) {
          await settleGame(tx, session, { winnerId: state.winnerId, refund: false });
          await tx.query(
            "UPDATE game_sessions SET status = 'finished', state = $2, winner_id = $3, ended_at = now(), updated_at = now() WHERE id = $1",
            [id, JSON.stringify(state), state.winnerId],
          );
        } else {
          await tx.query("UPDATE game_sessions SET state = $2, updated_at = now() WHERE id = $1", [id, JSON.stringify(state)]);
        }
        return { state, finished: state.finished, winnerId: state.winnerId };
      });
      ctx.hub.publishToRoom(id, { type: "game.updated", entityId: id, payload: { finished: result.finished } });
      trackSafe(ctx.pool, { name: "game_move", userId: user.id, properties: { entityType: "game_session", entityId: id } });
      if (result.finished) {
        trackSafe(ctx.pool, { name: "game_finished", userId: user.id, properties: { entityType: "game_session", entityId: id } });
      }
      const session = await loadSession(ctx.pool, id);
      return { session: await sessionView(ctx, session!, user.id) };
    });

    app.get("/v1/games/sessions/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const session = await loadSession(ctx.pool, id);
      if (!session) throw ApiError.notFound("Game not found");
      return { session: await sessionView(ctx, session, user.id) };
    });

    app.post("/v1/games/sessions/:id/leave", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const session = await loadSession(ctx.pool, id);
      if (!session) throw ApiError.notFound("Game not found");
      if (session.status === "active") {
        // Leaving mid-game forfeits the stake to the remaining players.
        await ctx.pool.query(
          "UPDATE game_players SET status = 'left' WHERE session_id = $1 AND user_id = $2",
          [id, user.id],
        );
        return { left: true, forfeited: Number(session.stake_minor) > 0 };
      }
      if (session.status === "lobby") {
        await withTransaction(ctx.pool, async (tx) => {
          const player = await queryOne<{ staked_minor: string }>(
            tx as unknown as AppContext["pool"],
            "SELECT staked_minor FROM game_players WHERE session_id = $1 AND user_id = $2",
            [id, user.id],
          );
          const stake = Number(player?.staked_minor ?? 0);
          if (stake > 0) {
            await postGameRefund(tx, {
              reference: `GAMEREFUND-${id}-${user.id}`,
              userId: user.id,
              amountMinor: stake,
              currency: session.currency,
            });
            await tx.query("UPDATE game_sessions SET pot_minor = GREATEST(pot_minor - $2, 0), updated_at = now() WHERE id = $1", [id, stake]);
          }
          await tx.query("DELETE FROM game_players WHERE session_id = $1 AND user_id = $2", [id, user.id]);
        });
        return { left: true, refunded: Number(session.stake_minor) > 0 };
      }
      throw ApiError.badRequest("This game has already finished");
    });
  };
}
