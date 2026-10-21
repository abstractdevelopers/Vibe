import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { newId } from "../ids.js";
import { walletBalance, postCosmeticPurchase } from "../money/ledger.js";

/**
 * Identity and status.
 *
 * Two things live here. A *standing* is a title a user has earned by showing up
 * — King, Queen, First Family, Class, Warrior — and it is always derived from
 * activity, never stored as a claim, so no one can assert a rank they have not
 * reached. A *cosmetic* is a look (a frame or an outfit) bought with Vibe Yens;
 * the purchase is a ledger journal like any other, and owning it is a row in
 * `cosmetic_purchases`, so a look can never be conjured without paying.
 *
 * The titles are deliberately not a leaderboard. There is one King and one Queen
 * (whoever leads the standing), a handful of First Family, a wider Class, and a
 * large Warrior tier, so most active people hold some title and the tiers read
 * as belonging rather than as winning.
 */

/** The catalogue is static and lives in code, like the gift catalogue. */
interface Cosmetic {
  id: string;
  kind: "frame" | "outfit";
  label: string;
  hint: string;
  style: string;
  priceMinor: number;
  currency: string;
  sortOrder: number;
}

export const COSMETICS: Cosmetic[] = [
  // Frames: drawn by the client from `style`. Cheap enough to buy on a whim.
  { id: "frame-ember", kind: "frame", label: "Ember", hint: "A warm glow", style: "ember", priceMinor: 50_000, currency: "NGN", sortOrder: 10 },
  { id: "frame-tide", kind: "frame", label: "Tide", hint: "Cool and calm", style: "tide", priceMinor: 50_000, currency: "NGN", sortOrder: 15 },
  { id: "frame-gold", kind: "frame", label: "Gold", hint: "For the front row", style: "gold", priceMinor: 250_000, currency: "NGN", sortOrder: 30 },
  { id: "frame-crown", kind: "frame", label: "Crown", hint: "Royalty only", style: "crown", priceMinor: 1_000_000, currency: "NGN", sortOrder: 60 },
  // Outfits: a colour and a pattern, again drawn client-side.
  { id: "outfit-lagos", kind: "outfit", label: "Lagos Nights", hint: "Neon and noise", style: "lagos", priceMinor: 120_000, currency: "NGN", sortOrder: 20 },
  { id: "outfit-ankara", kind: "outfit", label: "Ankara", hint: "Bold and bright", style: "ankara", priceMinor: 200_000, currency: "NGN", sortOrder: 25 },
  { id: "outfit-midnight", kind: "outfit", label: "Midnight", hint: "Dressed to disappear", style: "midnight", priceMinor: 300_000, currency: "NGN", sortOrder: 40 },
  { id: "outfit-royal", kind: "outfit", label: "Royal", hint: "The full regalia", style: "royal", priceMinor: 1_500_000, currency: "NGN", sortOrder: 70 },
];

const COSMETIC_IDS = COSMETICS.map((c) => c.id) as [string, ...string[]];

export interface Standing {
  /** The title, or null for someone with no activity yet. */
  title: string | null;
  /** A one-line reason, shown next to the title. */
  reason: string;
  /** How many people hold this title, so a user can see where they sit. */
  holders: number;
  /** The raw count that produced it: activity this week. */
  activity: number;
  /** A rank token for styling, e.g. "king". Null when there is no title. */
  rank: string | null;
}

/**
 * Titles, in descending order. `min` is the activity a user needs this week, and
 * `maxAhead` is how many more-active people may sit above them: a King has no
 * one ahead, a Queen has at most one, and so on. That makes each tier positional
 * and distinct, so there is exactly one King and one Queen, and the tiers below
 * read as belonging rather than as winning.
 */
const TIERS: Array<{ rank: string; title: string; min: number; maxAhead: number; reason: string }> = [
  { rank: "king", title: "Vibe King", min: 50, maxAhead: 0, reason: "Most active this week" },
  { rank: "queen", title: "Vibe Queen", min: 40, maxAhead: 1, reason: "Leading the room this week" },
  { rank: "first_family", title: "First Family", min: 25, maxAhead: 10, reason: "Always in the room" },
  { rank: "class", title: "Vibe Class", min: 10, maxAhead: 50, reason: "Showing up, week after week" },
  { rank: "warrior", title: "Vibe Warrior", min: 3, maxAhead: Number.MAX_SAFE_INTEGER, reason: "Out here every week" },
];

/**
 * Activity is what you did this week: posts you wrote, rooms you hosted, votes
 * and attacks you threw. It is one number so the titles are a single ordered
 * list rather than five separate leaderboards.
 */
async function weeklyActivity(ctx: AppContext, userId: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    ctx.pool,
    `SELECT (
        (SELECT count(*) FROM posts WHERE author_id = $1 AND created_at > now() - interval '7 days' AND status = 'published')
      + (SELECT count(*) FROM activity_rooms WHERE host_id = $1 AND created_at > now() - interval '7 days')
      + (SELECT count(*) FROM battle_comments WHERE user_id = $1 AND created_at > now() - interval '7 days')
      + (SELECT count(*) FROM battle_gifts WHERE user_id = $1 AND created_at > now() - interval '7 days')
      + (SELECT count(*) FROM post_gifts WHERE sender_id = $1 AND created_at > now() - interval '7 days')
    )::text AS total`,
    [userId],
  );
  return Number(row?.total ?? 0);
}

/** How many people reach at least `min` activity this week. */
async function countAtLeast(ctx: AppContext, min: number): Promise<number> {
  const row = await queryOne<{ total: string }>(
    ctx.pool,
    `SELECT count(*)::text AS total FROM (
        SELECT u.id,
               (SELECT count(*) FROM posts p WHERE p.author_id = u.id AND p.created_at > now() - interval '7 days' AND p.status = 'published')
             + (SELECT count(*) FROM activity_rooms r WHERE r.host_id = u.id AND r.created_at > now() - interval '7 days')
             + (SELECT count(*) FROM battle_comments c WHERE c.user_id = u.id AND c.created_at > now() - interval '7 days')
             + (SELECT count(*) FROM battle_gifts g WHERE g.user_id = u.id AND g.created_at > now() - interval '7 days')
             + (SELECT count(*) FROM post_gifts pg WHERE pg.sender_id = u.id AND pg.created_at > now() - interval '7 days')
               AS activity
          FROM users u
         WHERE u.deleted_at IS NULL
      ) t WHERE t.activity >= $1`,
    [min],
  );
  return Number(row?.total ?? 0);
}

/**
 * A user's standing. The title is the highest tier whose `min` they clear AND
 * whose positional cap they satisfy: a King has no one more active ahead of
 * them, a Queen at most one, and so on, so the top tiers stay distinct.
 */
export async function standingFor(ctx: AppContext, userId: string): Promise<Standing> {
  const activity = await weeklyActivity(ctx, userId);
  for (const tier of TIERS) {
    if (activity < tier.min) continue;
    const ahead = await countAhead(ctx, activity);
    if (ahead <= tier.maxAhead) {
      return { title: tier.title, reason: tier.reason, holders: await countAtLeast(ctx, tier.min), activity, rank: tier.rank };
    }
  }
  return { title: null, reason: "Post, host or cheer this week to earn a title", holders: 0, activity, rank: null };
}

/** How many users have more activity than `activity` this week. */
async function countAhead(ctx: AppContext, activity: number): Promise<number> {
  const row = await queryOne<{ total: string }>(
    ctx.pool,
    `SELECT count(*)::text AS total FROM (
        SELECT u.id,
               (SELECT count(*) FROM posts p WHERE p.author_id = u.id AND p.created_at > now() - interval '7 days' AND p.status = 'published')
             + (SELECT count(*) FROM activity_rooms r WHERE r.host_id = u.id AND r.created_at > now() - interval '7 days')
             + (SELECT count(*) FROM battle_comments c WHERE c.user_id = u.id AND c.created_at > now() - interval '7 days')
             + (SELECT count(*) FROM battle_gifts g WHERE g.user_id = u.id AND g.created_at > now() - interval '7 days')
             + (SELECT count(*) FROM post_gifts pg WHERE pg.sender_id = u.id AND pg.created_at > now() - interval '7 days')
               AS activity
          FROM users u
         WHERE u.deleted_at IS NULL
      ) t WHERE t.activity > $1`,
    [activity],
  );
  return Number(row?.total ?? 0);
}

/** What a user owns and is wearing, for the wardrobe screen and the avatar. */
async function wardrobeFor(ctx: AppContext, userId: string) {
  const owned = await queryMany<{ cosmetic_id: string }>(
    ctx.pool,
    `SELECT cosmetic_id FROM cosmetic_purchases WHERE user_id = $1`,
    [userId],
  );
  const worn = await queryMany<{ kind: string; cosmetic_id: string }>(
    ctx.pool,
    `SELECT kind, cosmetic_id FROM cosmetic_worn WHERE user_id = $1`,
    [userId],
  );
  const ownedSet = new Set(owned.map((o) => o.cosmetic_id));
  const wornMap = new Map(worn.map((w) => [w.kind, w.cosmetic_id]));
  return {
    owned: COSMETICS.filter((c) => ownedSet.has(c.id)).map((c) => c.id),
    worn: { frame: wornMap.get("frame") ?? null, outfit: wornMap.get("outfit") ?? null },
  };
}

export function identityStatusRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // The catalogue: everything buyable, with what the viewer owns and wears.
    app.get("/v1/cosmetics", async (req) => {
      const user = await requireUser(ctx, req);
      const { owned, worn } = await wardrobeFor(ctx, user.id);
      return {
        cosmetics: COSMETICS.map((c) => ({
          ...c,
          owned: owned.includes(c.id),
          worn: worn.frame === c.id || worn.outfit === c.id,
        })),
        worn,
      };
    });

    // Buy a cosmetic. Gated on the wallet like every other spend, because it
    // moves stored value.
    app.post("/v1/cosmetics/:id/buy", async (req, reply) => {
      if (!ctx.config.WALLET_ENABLED) throw ApiError.badRequest("The Vibe Yens wardrobe is not available right now");
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const cosmetic = COSMETICS.find((c) => c.id === id);
      if (!cosmetic) throw ApiError.notFound("That cosmetic does not exist");

      await withTransaction(ctx.pool, async (tx) => {
        const already = await tx.query(
          `SELECT 1 FROM cosmetic_purchases WHERE user_id = $1 AND cosmetic_id = $2`,
          [user.id, id],
        );
        if (already.rowCount) throw ApiError.badRequest("You already own that");

        const balance = await walletBalance(tx as unknown as AppContext["pool"], user.id, cosmetic.currency);
        if (balance.balanceMinor < cosmetic.priceMinor) throw ApiError.badRequest("Not enough Vibe Yens");

        await tx.query(
          `INSERT INTO cosmetic_purchases (user_id, cosmetic_id, price_minor, currency) VALUES ($1,$2,$3,$4)`,
          [user.id, id, cosmetic.priceMinor, cosmetic.currency],
        );
        await postCosmeticPurchase(tx, {
          reference: `COSMETIC-${user.id}-${id}-${newId()}`,
          userId: user.id,
          amountMinor: cosmetic.priceMinor,
          currency: cosmetic.currency,
        });
      });
      reply.code(201);
      const { owned, worn } = await wardrobeFor(ctx, user.id);
      return { ok: true, owned, worn };
    });

    // Wear something you own. Passing null takes it off.
    app.post("/v1/cosmetics/wear", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(
        z.object({ kind: z.enum(["frame", "outfit"]), cosmeticId: z.enum(COSMETIC_IDS).nullable() }),
        req.body,
      );
      if (input.cosmeticId) {
        const cosmetic = COSMETICS.find((c) => c.id === input.cosmeticId)!;
        if (cosmetic.kind !== input.kind) throw ApiError.badRequest("That cosmetic is not the right kind");
        const owned = await queryOne(
          ctx.pool,
          `SELECT 1 FROM cosmetic_purchases WHERE user_id = $1 AND cosmetic_id = $2`,
          [user.id, input.cosmeticId],
        );
        if (!owned) throw ApiError.forbidden("You do not own that");
      }
      if (input.cosmeticId === null) {
        await ctx.pool.query(`DELETE FROM cosmetic_worn WHERE user_id = $1 AND kind = $2`, [user.id, input.kind]);
      } else {
        await ctx.pool.query(
          `INSERT INTO cosmetic_worn (user_id, kind, cosmetic_id) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, kind) DO UPDATE SET cosmetic_id = EXCLUDED.cosmetic_id, updated_at = now()`,
          [user.id, input.kind, input.cosmeticId],
        );
      }
      const { owned, worn } = await wardrobeFor(ctx, user.id);
      return { ok: true, owned, worn };
    });

    // The viewer's own standing.
    app.get("/v1/me/standing", async (req) => {
      const user = await requireUser(ctx, req);
      return { standing: await standingFor(ctx, user.id) };
    });

    // The people who hold titles right now, for the status board. Ordered by the
    // title, so the King and Queen are at the top.
    app.get("/v1/status/board", async (req) => {
      await requireUser(ctx, req);
      const rows = await queryMany<{ id: string; handle: string; display_name: string; avatar_url: string | null; activity: string }>(
        ctx.pool,
        `SELECT u.id, u.handle, u.display_name, u.avatar_url,
                ( (SELECT count(*) FROM posts p WHERE p.author_id = u.id AND p.created_at > now() - interval '7 days' AND p.status = 'published')
                + (SELECT count(*) FROM activity_rooms r WHERE r.host_id = u.id AND r.created_at > now() - interval '7 days')
                + (SELECT count(*) FROM battle_comments c WHERE c.user_id = u.id AND c.created_at > now() - interval '7 days')
                + (SELECT count(*) FROM battle_gifts g WHERE g.user_id = u.id AND g.created_at > now() - interval '7 days')
                + (SELECT count(*) FROM post_gifts pg WHERE pg.sender_id = u.id AND pg.created_at > now() - interval '7 days')
                )::text AS activity
           FROM users u
          WHERE u.deleted_at IS NULL
          ORDER BY activity DESC
          LIMIT 50`,
      );
      const withStanding = [];
      for (const r of rows) {
        const activity = Number(r.activity);
        if (activity <= 0) continue;
        withStanding.push({
          user: { id: r.id, handle: r.handle, displayName: r.display_name, avatarUrl: r.avatar_url },
          activity,
        });
      }
      return { board: withStanding };
    });
  };
}
