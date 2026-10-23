import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";
import { newId } from "../ids.js";
import { walletBalance, lockWalletAccount, postBattleStake, postBattlePayout, postBattleRefund } from "../money/ledger.js";
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
  // Artwork. Same rule as an event image: an absolute http(s) URL or one of our
  // own media paths, so the upload endpoint's validation is the only gate.
  imageUrl: z
    .string()
    .max(500)
    .regex(/^(https?:\/\/|\/v1\/media\/[A-Za-z0-9._-]+$)/, "imageUrl must be an http(s) URL or a media path")
    .optional(),
  characterAUrl: z
    .string()
    .max(500)
    .regex(/^(https?:\/\/|\/v1\/media\/[A-Za-z0-9._-]+$)/, "characterAUrl must be an http(s) URL or a media path")
    .optional(),
  characterBUrl: z
    .string()
    .max(500)
    .regex(/^(https?:\/\/|\/v1\/media\/[A-Za-z0-9._-]+$)/, "characterBUrl must be an http(s) URL or a media path")
    .optional(),
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
  image_url: string | null;
  character_a_url: string | null;
  character_b_url: string | null;
}

interface SideTally {
  side: "a" | "b";
  votes: number;
  comments: number;
  /** Distinct people who commented; this is what the score counts. */
  commenters: number;
  gifts: number;
  points: number;
  backers: number;
  stakedMinor: number;
}

/** The reactions a bystander can throw at a side. Free, like a post gift. */
export const BATTLE_GIFT_KINDS = [
  { id: "fire", label: "Fire", points: 2 },
  { id: "clap", label: "Clap", points: 2 },
  { id: "shock", label: "Shock", points: 2 },
  { id: "crown", label: "Crown", points: 2 },
] as const;

const BATTLE_GIFT_IDS = BATTLE_GIFT_KINDS.map((g) => g.id) as [string, ...string[]];

interface BackerRow {
  id: string;
  side: "a" | "b";
  stake_minor: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

function num(v: string | number | null): number {
  return v === null ? 0 : Number(v);
}

/**
 * What a backer would take if their side wins, given the pot as it stands.
 *
 * The pot is split in proportion to what each winner staked, so a side with
 * many backers is a side with many winners: everyone who backed it gets a
 * slice. The share is a projection, not a promise — it moves as more people
 * stake, which is why the screen labels it as it stands right now.
 */
function projectedShare(myStake: number, sideStaked: number, pot: number): number {
  if (myStake <= 0 || sideStaked <= 0 || pot <= 0) return 0;
  return Math.floor((myStake / sideStaked) * pot);
}

/** The tallies for both sides, computed from the vote, stake, comment and gift rows. */
async function tallies(ctx: AppContext, battleId: string): Promise<{ a: SideTally; b: SideTally }> {
  const rows = await queryMany<{ side: string; votes: string; backers: string; staked: string; comments: string; commenters: string; gifts: string }>(
    ctx.pool,
    `SELECT s.side,
            COALESCE(v.votes, '0') AS votes,
            COALESCE(p.backers, '0') AS backers,
            COALESCE(p.staked, '0') AS staked,
            COALESCE(c.comments, '0') AS comments,
            COALESCE(c.commenters, '0') AS commenters,
            COALESCE(g.gifts, '0') AS gifts
       FROM (SELECT 'a' AS side UNION SELECT 'b') s
       LEFT JOIN (SELECT side, COUNT(*)::text AS votes FROM battle_votes WHERE battle_id = $1 GROUP BY side) v ON v.side = s.side
       LEFT JOIN (SELECT side, COUNT(*)::text AS backers, COALESCE(SUM(stake_minor),0)::text AS staked
                    FROM battle_participants WHERE battle_id = $1 AND stake_minor > 0 GROUP BY side) p ON p.side = s.side
       LEFT JOIN (SELECT side, COUNT(*)::text AS comments, COUNT(DISTINCT user_id)::text AS commenters
                    FROM battle_comments WHERE battle_id = $1 GROUP BY side) c ON c.side = s.side
       LEFT JOIN (SELECT side, COUNT(*)::text AS gifts FROM battle_gifts WHERE battle_id = $1 GROUP BY side) g ON g.side = s.side`,
    [battleId],
  );
  const byside: Record<string, SideTally> = {};
  for (const r of rows) {
    const votes = Number(r.votes);
    const comments = Number(r.comments);
    const commenters = Number(r.commenters);
    const gifts = Number(r.gifts);
    byside[r.side] = {
      side: r.side as "a" | "b",
      votes,
      comments,
      commenters,
      gifts,
      // The score the crowd moves: a vote is one point, each *person* who
      // comments is one, and a gift is two. Counting one user's repeated
      // comments would let a single account decide the winner.
      points: votes + commenters + gifts * 2,
      backers: Number(r.backers),
      stakedMinor: Number(r.staked),
    };
  }
  return {
    a: byside.a ?? { side: "a", votes: 0, comments: 0, commenters: 0, gifts: 0, points: 0, backers: 0, stakedMinor: 0 },
    b: byside.b ?? { side: "b", votes: 0, comments: 0, commenters: 0, gifts: 0, points: 0, backers: 0, stakedMinor: 0 },
  };
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
  // The first people behind the battle, so a large battle still shows who
  // showed up. This is deliberately ordered by time, not by stake: ranking by
  // money would let a bigger stake buy standing, and a stake must only ever
  // decide what you win, never who is seen.
  const backers = await queryMany<BackerRow>(
    ctx.pool,
    `SELECT bp.user_id AS id, bp.side, bp.stake_minor, u.handle, u.display_name, u.avatar_url
       FROM battle_participants bp
       JOIN users u ON u.id = bp.user_id
      WHERE bp.battle_id = $1
      ORDER BY bp.created_at ASC
      LIMIT 8`,
    [row.id],
  );
  const pot = num(row.pot_minor);
  const myStake = num(mine?.stake_minor ?? null);
  const mySide = (mine?.side as "a" | "b" | undefined) ?? null;
  const mySideStaked = mySide ? (mySide === "a" ? t.a.stakedMinor : t.b.stakedMinor) : 0;
  // The comment feed, newest first. A comment is an attack: it names the side it
  // backs and adds a point to it, so the feed is also the play-by-play.
  const comments = await queryMany<{
    id: string; side: "a" | "b"; body: string; created_at: Date;
    user_id: string; handle: string; display_name: string; avatar_url: string | null;
  }>(
    ctx.pool,
    `SELECT c.id, c.side, c.body, c.created_at, c.user_id, u.handle, u.display_name, u.avatar_url
       FROM battle_comments c JOIN users u ON u.id = c.user_id
      WHERE c.battle_id = $1
      ORDER BY c.created_at DESC
      LIMIT 50`,
    [row.id],
  );
  const myGifts = await queryMany<{ kind: string }>(
    ctx.pool,
    "SELECT kind FROM battle_gifts WHERE battle_id = $1 AND user_id = $2",
    [row.id, viewerId],
  );
  return {
    id: row.id,
    title: row.title,
    topic: row.topic,
    sides: { a: row.side_a, b: row.side_b },
    // Artwork, so a battle is something you look at rather than a bar you read.
    imageUrl: row.image_url,
    characters: { a: row.character_a_url, b: row.character_b_url },
    status: row.status,
    winner: row.winner,
    stakeMinor: num(row.stake_minor),
    currency: row.currency,
    potMinor: pot,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    // `tally` stays the raw vote counts so a vote never silently changes meaning;
    // `score` is the crowd's total, which is what decides a winner.
    tally: { a: t.a.votes, b: t.b.votes },
    score: { a: t.a.points, b: t.b.points },
    backing: { a: t.a, b: t.b },
    host: host ? publicUser(host) : null,
    // What the viewer did, so the UI can show "you backed A" rather than guess.
    mySide,
    myStakeMinor: myStake,
    myPayoutMinor: num(mine?.payout_minor ?? null),
    // What the viewer's stake is worth if their side wins as the pot stands.
    // Zero until they stake, and labelled as an estimate on the screen.
    myProjectedMinor: row.status === "open" ? projectedShare(myStake, mySideStaked, pot) : 0,
    myGifts: myGifts.map((g) => g.kind),
    comments: comments.map((c) => ({
      id: c.id,
      side: c.side,
      body: c.body,
      createdAt: c.created_at,
      author: publicUser({ id: c.user_id, handle: c.handle, display_name: c.display_name, avatar_url: c.avatar_url }),
    })),
    backers: backers.map((b) => ({
      side: b.side,
      staked: num(b.stake_minor) > 0,
      user: publicUser(b),
    })),
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
      const user = await requireUser(ctx, req);
      const q = parse(z.object({ status: z.enum(["open", "closed"]).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }), req.query);
      const rows = await queryMany<BattleRow>(
        ctx.pool,
        `SELECT * FROM battles
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY (status = 'open') DESC, created_at DESC
          LIMIT $2`,
        [q.status ?? null, q.limit],
      );
      return { battles: await Promise.all(rows.map((r) => battleView(ctx, r, user.id))) };
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
          await lockWalletAccount(tx, user.id, "NGN");
          const balance = await walletBalance(tx as unknown as AppContext["pool"], user.id, "NGN");
          if (balance.balanceMinor < input.stakeMinor) throw ApiError.badRequest("Not enough Vibe Yens for this stake");
        }
        await tx.query(
          `INSERT INTO battles (id, host_id, circle_id, title, topic, side_a, side_b, image_url, character_a_url, character_b_url, stake_minor, currency, pot_minor, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NGN',$12,$13)`,
          [id, user.id, input.circleId ?? null, input.title, input.topic ?? null, input.sideA, input.sideB,
           input.imageUrl ?? null, input.characterAUrl ?? null, input.characterBUrl ?? null,
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
          await lockWalletAccount(tx, user.id, "NGN");
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
        // Voting also records which side the viewer is on, so the screen can
        // light up their side without a second call. A staked backer cannot
        // vote for the other side — that would make their own stake ambiguous.
        const existing = await tx.query<{ side: string; stake_minor: string }>(
          "SELECT side, stake_minor FROM battle_participants WHERE battle_id = $1 AND user_id = $2",
          [id, user.id],
        );
        const prior = existing.rows[0];
        if (!prior) {
          await tx.query(
            "INSERT INTO battle_participants (battle_id, user_id, side, stake_minor) VALUES ($1,$2,$3,0)",
            [id, user.id, input.side],
          );
        } else if (num(prior.stake_minor) > 0 && prior.side !== input.side) {
          throw ApiError.badRequest("You have staked on the other side");
        } else if (num(prior.stake_minor) === 0) {
          await tx.query("UPDATE battle_participants SET side = $3 WHERE battle_id = $1 AND user_id = $2", [id, user.id, input.side]);
        }
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

    // Attack: drop a comment on a side. It is a point for that side, so the
    // comment feed is also the play-by-play. Anyone signed in can comment, and a
    // comment does not require having voted.
    app.post("/v1/battles/:id/comments", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(z.object({ side: z.enum(["a", "b"]), body: z.string().trim().min(1).max(400) }), req.body);
      const battle = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      if (!battle) throw ApiError.notFound("That battle does not exist");
      if (battle.status !== "open") throw ApiError.badRequest("This battle is closed");
      if (battle.ends_at && new Date(battle.ends_at).getTime() < Date.now()) {
        throw ApiError.badRequest("This battle has ended");
      }
      const commentId = newId();
      await ctx.pool.query(
        `INSERT INTO battle_comments (id, battle_id, user_id, side, body) VALUES ($1,$2,$3,$4,$5)`,
        [commentId, id, user.id, input.side, input.body],
      );
      trackSafe(ctx.pool, { name: "battle_commented", userId: user.id, properties: { entityType: "battle", entityId: id } });
      reply.code(201);
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      return { battle: await battleView(ctx, row!, user.id) };
    });

    // A reaction thrown at a side. One of each kind per user, so it is a gesture
    // and not a grind. It is worth two points — the loudest thing a bystander
    // can do without typing.
    app.post("/v1/battles/:id/gifts", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(z.object({ side: z.enum(["a", "b"]), kind: z.enum(BATTLE_GIFT_IDS) }), req.body);
      const battle = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      if (!battle) throw ApiError.notFound("That battle does not exist");
      if (battle.status !== "open") throw ApiError.badRequest("This battle is closed");
      if (battle.ends_at && new Date(battle.ends_at).getTime() < Date.now()) {
        throw ApiError.badRequest("This battle has ended");
      }
      const inserted = await queryOne<{ kind: string }>(
        ctx.pool,
        `INSERT INTO battle_gifts (battle_id, user_id, side, kind) VALUES ($1,$2,$3,$4)
         ON CONFLICT (battle_id, user_id, kind) DO NOTHING RETURNING kind`,
        [id, user.id, input.side, input.kind],
      );
      reply.code(inserted ? 201 : 200);
      const row = await queryOne<BattleRow>(ctx.pool, "SELECT * FROM battles WHERE id = $1", [id]);
      return { battle: await battleView(ctx, row!, user.id), alreadySent: !inserted };
    });

    // Close and settle. The host may close early; anyone may close once the end
    // time has passed. The winner is whoever has the higher crowd score; a tie refunds.
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
      // The crowd's score decides the winner: votes plus comments plus gifts.
      // A silent poll and a loud fight are not the same thing, and the loud one
      // should win. A genuine tie still refunds.
      const winner: "a" | "b" | "tie" = t.a.points === t.b.points ? "tie" : t.a.points > t.b.points ? "a" : "b";
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
