import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";
import { newId } from "../ids.js";
import { walletBalance, postBattleStake, postBattlePayout, postBattleRefund } from "../money/ledger.js";
import { trackSafe } from "./analytics.js";

/**
 * Brand Battles.
 *
 * A battle is a time-bounded contest between two sides. Voting is the score and
 * a vote is one per user, enforced by a primary key — not a counter — so a
 * retried request cannot inflate a result.
 *
 * Money is optional and secondary. A battle created with stake 0 needs no
 * wallet at all; a staked battle moves each backer's Yens into the shared pot
 * and, when it closes, pays the whole pot to the winning side. The platform
 * takes no rake, and no one can buy a vote: a stake decides what you win, never
 * who wins. That keeps a battle entertainment rather than a betting market.
 */

const STAKE_MAX_MINOR = 5_000_000; // ₦50,000, a guard rail, not a product limit

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  topic: z.string().trim().max(400).optional(),
  sideA: z.string().trim().min(1).max(40),
  sideB: z.string().trim().min(1).max(40),
  circleId: z.string().uuid().optional(),
  stakeMinor: z.number().int().min(0).max(STAKE_MAX_MINOR).default(0),
  endsAt: z.string().datetime().optional(),
});

const voteSchema = z.object({ side: z.enum(["a", "b"]) });

interface BattleRow {
  id: string;
  host_id: string;
  circle_id: string | null;
  title: string;
  topic: string | null;
  side_a: string;
  side_b: string;
  status: "open" | "closed" | "cancelled";
  stake_minor: string;
  currency: string;
  pot_minor: string;
  winner: "a" | "b" | "tie" | null;
  ends_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
}

interface SideTally {
  side: "a" | "b";
  votes: number;
  backers: number;
  stakedMinor: number;
}

function num(v: string | number | null): number {
  return v === null ? 0 : Number(v);
}

/** The tallies for both sides, computed from the vote and stake rows. */
async function tallies(ctx: AppContext, battleId: string): Promise<{ a: SideTally; b: SideTally }> {
  const rows = await queryMany<{ side: string; votes: string; backers: string; staked: string }>(
    ctx.pool,
    `SELECT s.side,
            COALESCE(v.votes, '0') AS votes,
            COALESCE(p.backers, '0') AS backers,
            COALESCE(p.staked, '0') AS staked
       FROM (SELECT 'a' AS side UNION SELECT 'b') s
       LEFT JOIN (SELECT side, COUNT(*)::text AS votes FROM battle_votes WHERE battle_id = $1 GROUP BY side) v ON v.side = s.side
       LEFT JOIN (SELECT side, COUNT(*)::text AS backers, COALESCE(SUM(stake_minor),0)::text AS staked
                    FROM battle_participants WHERE battle_id = $1 AND stake_minor > 0 GROUP BY side) p ON p.side = s.side`,
    [battleId],
  );
  const byside: Record<string, SideTally> = {};
  for (const r of rows) {
    byside[r.side] = { side: r.side as "a" | "b", votes: Number(r.votes), backers: Number(r.backers), stakedMinor: Number(r.staked) };
  }
  return { a: byside.a ?? { side: "a", votes: 0, backers: 0, stakedMinor: 0 }, b: byside.b ?? { side: "b", votes: 0, backers: 0, stakedMinor: 0 } };
}

async function battleView(ctx: AppContext, row: BattleRow, viewerId: string) {
  const t = await tallies(ctx, row.id);
  const mine = await queryOne<{ side: string; stake_minor: string; payout_minor: string }>(
    ctx.pool,
    "SELECT side, stake_minor, payout_minor FROM battle_participants WHERE battle_id = $1 AND user_id = $2",
    [row.id, viewerId],
  );
  const host = await queryOne<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
    ctx.pool,
    "SELECT id, handle, display_name, avatar_url FROM users WHERE id = $1",
    [row.host_id],
  );
  return {
    id: row.id,
    title: row.title,
    topic: row.topic,
    sides: { a: row.side_a, b: row.side_b },
    status: row.status,
    winner: row.winner,
    stakeMinor: num(row.stake_minor),
    currency: row.currency,
    potMinor: num(row.pot_minor),
    endsAt: row.ends_at,
    createdAt: row.created_at,
    tally: { a: t.a.votes, b: t.b.votes },
    backing: { a: t.a, b: t.b },
    host: host ? publicUser(host) : null,
    // What the viewer did, so the UI can show "you backed A" rather than guess.
    mySide: mine?.side ?? null,
    myStakeMinor: num(mine?.stake_minor ?? null),
    myPayoutMinor: num(mine?.payout_minor ?? null),
  };
}

/** Resolve the winning side, then pay the pot to the backers of that side. */
async function settle(ctx: AppContext, battle: BattleRow, winner: "a" | "b" | "tie"): Promise<void> {
  await withTransaction(ctx.pool, async (tx) => {
    // Lock the row so two concurrent closes cannot both pay out.
    const locked = await tx.query<BattleRow>(
      "SELECT * FROM battles WHERE id = $1 AND status = 'open' FOR UPDATE",
      [battle.id],
    );
    const row = locked.rows[0];
    if (!row) return; // already settled by another request

    const pot = num(row.pot_minor);
    if (pot > 0 && winner !== "tie") {
      const backers = await tx.query<{ user_id: string; stake_minor: string }>(
        "SELECT user_id, stake_minor FROM battle_participants WHERE battle_id = $1 AND side = $2 AND stake_minor > 0",
        [row.id, winner],
      );
      const winningTotal = backers.rows.reduce((s, b) => s + num(b.stake_minor), 0);
      if (winningTotal > 0) {
        // Split the pot pro-rata. Round down and give the remainder to the
        // largest staker so the entries always sum to the pot exactly — the
        // journal must balance to the minor unit.
        const payouts = backers.rows.map((b) => ({
          userId: b.user_id,
          amountMinor: Math.floor((num(b.stake_minor) / winningTotal) * pot),
        }));
        const paid = payouts.reduce((s, p) => s + p.amountMinor, 0);
        const remainder = pot - paid;
        if (remainder > 0) {
          payouts.sort((x, y) => y.amountMinor - x.amountMinor);
          payouts[0]!.amountMinor += remainder;
        }
        await postBattlePayout(tx, {
          reference: `BATTLEPAY-${row.id}`,
          currency: row.currency,
          payouts,
        });
        for (const p of payouts) {
          await tx.query(
            "UPDATE battle_participants SET payout_minor = $3 WHERE battle_id = $1 AND user_id = $2",
            [row.id, p.userId, p.amountMinor],
          );
        }
      }
    } else if (pot > 0 && winner === "tie") {
      // A tie refunds every stake; nobody wins, nobody loses.
      const all = await tx.query<{ user_id: string; stake_minor: string }>(
        "SELECT user_id, stake_minor FROM battle_participants WHERE battle_id = $1 AND stake_minor > 0",
        [row.id],
      );
      for (const b of all.rows) {
        const amount = num(b.stake_minor);
        await postBattleRefund(tx, {
          reference: `BATTLEREFUND-${row.id}-${b.user_id}`,
          userId: b.user_id,
          amountMinor: amount,
          currency: row.currency,
        });
        await tx.query(
          "UPDATE battle_participants SET payout_minor = $3 WHERE battle_id = $1 AND user_id = $2",
          [row.id, b.user_id, amount],
        );
      }
    }

    await tx.query("UPDATE battles SET status = 'closed', winner = $2, closed_at = now() WHERE id = $1", [row.id, winner]);
  });
}

export function battleRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/battles", async (req) => {
      await requireUser(ctx, req);
      const q = parse(z.object({ status: z.enum(["open", "closed"]).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
      const rows = await queryMany<BattleRow>(
        ctx.pool,
        `SELECT * FROM battles
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY (status = 'open') DESC, created_at DESC
          LIMIT $2`,
        [q.status ?? null, q.limit],
      );
      return { battles: await Promise.all(rows.map((r) => battleView(ctx, r, (req as unknown as { user: { id: string } }).user?.id ?? ""))) };
    });

    app.post("/v1/battles", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createSchema, req.body);
      if (input.sideA.toLowerCase() === input.sideB.toLowerCase()) {
        throw ApiError.badRequest("The two sides must be different");
      }
      if (input.stakeMinor > 0 && !ctx.config.WALLET_ENABLED) {
        throw ApiError.badRequest("Staked battles are not available right now");
      }
      const id = newId();
      await withTransaction(ctx.pool, async (tx) => {
        if (input.stakeMinor > 0) {
          const balance = await walletBalance(tx as unknown as AppContext["pool"], user.id, "NGN");
          if (balance.balanceMinor < input.stakeMinor) throw ApiError.badRequest("Not enough Vibe Yens for this stake");
        }
        await tx.query(
          `INSERT INTO battles (id, host_id, circle_id, title, topic, side_a, side_b, stake_minor, currency, pot_minor, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'NGN',$9,$10)`,
          [id, user.id, input.circleId ?? null, input.title, input.topic ?? null, input.sideA, input.sideB,
           input.stakeMinor, input.stakeMinor, input.endsAt ? new Date(input.endsAt) : null],
        );
        // The host picks a side and backs it immediately, so their stake leaves
        // the wallet now rather than waiting for a join that may never come.
        if (input.stakeMinor > 0) {
          await tx.query(
            "INSERT INTO battle_participants (battle_id, user_id, side, stake_minor) VALUES ($1,$2,'a',$3)",
            [id, user.id, input.stakeMinor],
          );
          await postBattleStake(tx, {
            reference: `BATTLESTAKE-${id}-${user.id}`,
            userId: user.id,
            amountMinor: input.stakeMinor,
            currency: "NGN",
          });
        }
      });
      trackSafe(ctx.pool, { name: "battle_created", userId: user.id, properties: { entityType: "battle", entityId: id } });
      reply.code(201);
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      return { battle: await battleView(ctx, row!, user.id) };
    });

    // Pick a side and, on a staked battle, back it. Idempotent: re-picking the
    // same side is a no-op, and switching sides is refused once you have staked.
    app.post("/v1/battles/:id/join", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(voteSchema, req.body);
      await withTransaction(ctx.pool, async (tx) => {
        const res = await tx.query<BattleRow>("SELECT * FROM battles WHERE id = $1 FOR UPDATE", [id]);
        const battle = res.rows[0];
        if (!battle) throw ApiError.notFound("That battle does not exist");
        if (battle.status !== "open") throw ApiError.badRequest("This battle is closed");
        if (battle.ends_at && new Date(battle.ends_at).getTime() < Date.now()) {
          throw ApiError.badRequest("This battle has ended");
        }
        const existing = await tx.query<{ side: string; stake_minor: string }>(
          "SELECT side, stake_minor FROM battle_participants WHERE battle_id = $1 AND user_id = $2",
          [id, user.id],
        );
        const prior = existing.rows[0];
        const stake = num(battle.stake_minor);
        if (prior && num(prior.stake_minor) > 0 && prior.side !== input.side) {
          throw ApiError.badRequest("You have already staked on the other side");
        }
        if (prior) {
          await tx.query("UPDATE battle_participants SET side = $3 WHERE battle_id = $1 AND user_id = $2", [id, user.id, input.side]);
        } else if (stake > 0) {
          const balance = await walletBalance(tx as unknown as AppContext["pool"], user.id, "NGN");
          if (balance.balanceMinor < stake) throw ApiError.badRequest("Not enough Vibe Yens for this stake");
          await tx.query(
            "INSERT INTO battle_participants (battle_id, user_id, side, stake_minor) VALUES ($1,$2,$3,$4)",
            [id, user.id, input.side, stake],
          );
          await postBattleStake(tx, {
            reference: `BATTLESTAKE-${id}-${user.id}`,
            userId: user.id,
            amountMinor: stake,
            currency: battle.currency,
          });
          await tx.query("UPDATE battles SET pot_minor = pot_minor + $2 WHERE id = $1", [id, stake]);
        } else {
          await tx.query(
            "INSERT INTO battle_participants (battle_id, user_id, side, stake_minor) VALUES ($1,$2,$3,0)",
            [id, user.id, input.side],
          );
        }
      });
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      return { battle: await battleView(ctx, row!, user.id) };
    });

    // Vote. One vote per user, enforced by the primary key, and it is free —
    // a stake never buys a vote.
    app.post("/v1/battles/:id/vote", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(voteSchema, req.body);
      await withTransaction(ctx.pool, async (tx) => {
        const res = await tx.query<BattleRow>("SELECT status, ends_at FROM battles WHERE id = $1", [id]);
        const battle = res.rows[0];
        if (!battle) throw ApiError.notFound("That battle does not exist");
        if (battle.status !== "open") throw ApiError.badRequest("This battle is closed");
        if (battle.ends_at && new Date(battle.ends_at).getTime() < Date.now()) {
          throw ApiError.badRequest("This battle has ended");
        }
        // A vote is a choice; a re-vote simply changes it, which the upsert does.
        await tx.query(
          `INSERT INTO battle_votes (battle_id, user_id, side) VALUES ($1,$2,$3)
           ON CONFLICT (battle_id, user_id) DO UPDATE SET side = EXCLUDED.side, created_at = now()`,
          [id, user.id, input.side],
        );
      });
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      return { battle: await battleView(ctx, row!, user.id) };
    });

    app.get("/v1/battles/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      if (!row) throw ApiError.notFound("That battle does not exist");
      return { battle: await battleView(ctx, row, user.id) };
    });

    // Close and settle. The host may close early; anyone may close once the end
    // time has passed. The winner is whoever has more votes; a tie refunds.
    app.post("/v1/battles/:id/close", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      if (!row) throw ApiError.notFound("That battle does not exist");
      if (row.status !== "open") throw ApiError.badRequest("This battle is already closed");
      const expired = row.ends_at ? new Date(row.ends_at).getTime() <= Date.now() : false;
      if (row.host_id !== user.id && !expired) {
        throw ApiError.forbidden("Only the host can close this battle before it ends");
      }
      const t = await tallies(ctx, id);
      const winner: "a" | "b" | "tie" = t.a.votes === t.b.votes ? "tie" : t.a.votes > t.b.votes ? "a" : "b";
      await settle(ctx, row, winner);
      const settled = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      return { battle: await battleView(ctx, settled!, user.id) };
    });

    // Cancel: every stake comes back. Only the host, and only while open.
    app.post("/v1/battles/:id/cancel", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      if (!row) throw ApiError.notFound("That battle does not exist");
      if (row.host_id !== user.id) throw ApiError.forbidden("Only the host can cancel this battle");
      if (row.status !== "open") throw ApiError.badRequest("This battle is not open");
      await withTransaction(ctx.pool, async (tx) => {
        const locked = await tx.query<BattleRow>("SELECT * FROM battles WHERE id = $1 AND status = 'open' FOR UPDATE", [id]);
        const b = locked.rows[0];
        if (!b) return;
        const all = await tx.query<{ user_id: string; stake_minor: string }>(
          "SELECT user_id, stake_minor FROM battle_participants WHERE battle_id = $1 AND stake_minor > 0",
          [id],
        );
        for (const p of all.rows) {
          await postBattleRefund(tx, {
            reference: `BATTLEREFUND-${id}-${p.user_id}`,
            userId: p.user_id,
            amountMinor: num(p.stake_minor),
            currency: b.currency,
          });
        }
        await tx.query("UPDATE battles SET status = 'cancelled', closed_at = now() WHERE id = $1", [id]);
      });
      const cancelled = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      return { battle: await battleView(ctx, cancelled!, user.id) };
    });
  };
}
