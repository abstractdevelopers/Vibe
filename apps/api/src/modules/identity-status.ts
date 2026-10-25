import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { newId } from "../ids.js";
import { walletBalance, lockWalletAccount, postCosmeticPurchase } from "../money/ledger.js";

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
  /**
   * A numbered run. Omitted means unlimited: anyone may buy it at any time.
   * A finite run is what makes a look mean more than its price.
   */
  editionSize?: number;
}

export const COSMETICS: Cosmetic[] = [
  // Frames: drawn by the client from `style`. Cheap enough to buy on a whim.
  { id: "frame-ember", kind: "frame", label: "Ember", hint: "A warm glow", style: "ember", priceMinor: 50_000, currency: "NGN", sortOrder: 10 },
  { id: "frame-tide", kind: "frame", label: "Tide", hint: "Cool and calm", style: "tide", priceMinor: 50_000, currency: "NGN", sortOrder: 15 },
  { id: "frame-gold", kind: "frame", label: "Gold", hint: "For the front row", style: "gold", priceMinor: 250_000, currency: "NGN", sortOrder: 30 },
  { id: "frame-crown", kind: "frame", label: "Crown", hint: "Royalty only", style: "crown", priceMinor: 1_000_000, currency: "NGN", sortOrder: 60, editionSize: 100 },
  // Outfits: a colour and a pattern, again drawn client-side.
  { id: "outfit-lagos", kind: "outfit", label: "Lagos Nights", hint: "Neon and noise", style: "lagos", priceMinor: 120_000, currency: "NGN", sortOrder: 20 },
  { id: "outfit-ankara", kind: "outfit", label: "Ankara", hint: "Bold and bright", style: "ankara", priceMinor: 200_000, currency: "NGN", sortOrder: 25 },
  { id: "outfit-midnight", kind: "outfit", label: "Midnight", hint: "Dressed to disappear", style: "midnight", priceMinor: 300_000, currency: "NGN", sortOrder: 40 },
  { id: "outfit-royal", kind: "outfit", label: "Royal", hint: "The full regalia", style: "royal", priceMinor: 1_500_000, currency: "NGN", sortOrder: 70, editionSize: 50 },
];

/** A certified edition item as it is shown to a viewer. */
export interface WornCosmetic {
  id: string;
  kind: "frame" | "outfit";
  label: string;
  style: string;
  /** The holder's number in the run, or null for an open cosmetic. */
  serial: number | null;
  /** The run size, copied onto the purchase at the time it was bought. */
  editionSize: number | null;
}

/** Look up the catalogue entry for an owned id. */
function cosmeticById(id: string | null | undefined): Cosmetic | null {
  if (!id) return null;
  return COSMETICS.find((c) => c.id === id) ?? null;
}

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
  /** What the rank actually unlocks. Shown on the status screen. */
  privileges: Privileges;
  /** What the next rank would add, so the ladder has a visible next step. */
  next: { title: string; at: number; gains: string[] } | null;
}

/**
 * Titles, in descending order. `min` is the activity a user needs this week, and
 * `maxAhead` is how many more-active people may sit above them: a King has no
 * one ahead, a Queen has at most one, and so on. That makes each tier positional
 * and distinct, so there is exactly one King and one Queen, and the tiers below
 * read as belonging rather than as winning.
 *
 * A title is not decoration: each tier carries privileges that the product
 * actually enforces (`PRIVILEGES`), so climbing the ladder changes what you can
 * do, not just what you are called. That is the difference between a status
 * system and a leaderboard.
 */
const TIERS: Array<{ rank: string; title: string; min: number; maxAhead: number; reason: string }> = [
  { rank: "king", title: "Vibe King", min: 50, maxAhead: 0, reason: "Most active this week" },
  { rank: "queen", title: "Vibe Queen", min: 40, maxAhead: 1, reason: "Leading the room this week" },
  { rank: "first_family", title: "First Family", min: 25, maxAhead: 10, reason: "Always in the room" },
  { rank: "class", title: "Vibe Class", min: 10, maxAhead: 50, reason: "Showing up, week after week" },
  { rank: "warrior", title: "Vibe Warrior", min: 3, maxAhead: Number.MAX_SAFE_INTEGER, reason: "Out here every week" },
];

/**
 * What a rank unlocks.
 *
 * Every field is read by a route that enforces it, never trusted from the
 * client. The baseline has to clear the whole catalogue — the top gift is
 * 5,000.00 — or standing would silently break ordinary gifting. The ladder then
 * adds reach on top of "normal", never takes it away.
 */
export interface Privileges {
  /** Posts per day. */
  postsPerDay: number;
  /** Attendees a hosted Circle plan or room may have. */
  groupCap: number;
  /** Paid gifts can be sent up to this many Vibe Yens per gift. */
  giftCapMinor: number;
  /** The rake kept on a staked game the user hosts, in basis points. */
  rakeBps: number;
  /** Highlight the profile in discovery and the status board. */
  featuredProfile: boolean;
  /** A gold nameplate, wherever the name is shown. */
  goldNameplate: boolean;
  /** Included room theme, so a high rank's room looks like a high rank's room. */
  roomTheme: "default" | "accent" | "luxe";
}

const BASE: Privileges = {
  postsPerDay: 10,
  groupCap: 25,
  // The top of the gift catalogue, so no rank is punished
  // for sending what everyone else can send.
  giftCapMinor: 500_000,
  rakeBps: 500,
  featuredProfile: false,
  goldNameplate: false,
  roomTheme: "default",
};

const PRIVILEGES: Record<string, Partial<Privileges>> = {
  warrior: { postsPerDay: 15, groupCap: 40 },
  class: { postsPerDay: 20, groupCap: 75, giftCapMinor: 1_000_000, roomTheme: "accent" },
  first_family: { postsPerDay: 30, groupCap: 150, giftCapMinor: 2_000_000, rakeBps: 400, featuredProfile: true },
  queen: { postsPerDay: 40, groupCap: 300, giftCapMinor: 5_000_000, rakeBps: 300, featuredProfile: true, goldNameplate: true, roomTheme: "luxe" },
  king: { postsPerDay: 50, groupCap: 500, giftCapMinor: 10_000_000, rakeBps: 250, featuredProfile: true, goldNameplate: true, roomTheme: "luxe" },
};

/** The privileges a rank grants, falling back to the base ladder. */
export function privilegesFor(rank: string | null): Privileges {
  return { ...BASE, ...(rank ? PRIVILEGES[rank] ?? {} : {}) };
}

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
  for (let i = 0; i < TIERS.length; i += 1) {
    const tier = TIERS[i]!;
    if (activity < tier.min) continue;
    const ahead = await countAhead(ctx, activity);
    if (ahead <= tier.maxAhead) {
      const mine = privilegesFor(tier.rank);
      const above = TIERS[i - 1];
      // The next step up, with only the things it would actually add. Saying
      // "keep going" without saying what for is how a ladder loses people.
      const next = above
        ? {
            title: above.title,
            at: above.min,
            gains: describeGains(mine, privilegesFor(above.rank)),
          }
        : null;
      return {
        title: tier.title,
        reason: tier.reason,
        holders: await countAtLeast(ctx, tier.min),
        activity,
        rank: tier.rank,
        privileges: mine,
        next: next && next.gains.length > 0 ? next : null,
      };
    }
  }
  // Nothing yet: the first rung is the next step.
  const first = TIERS[TIERS.length - 1]!;
  return {
    title: null,
    reason: "Post, host or cheer this week to earn a title",
    holders: 0,
    activity,
    rank: null,
    privileges: privilegesFor(null),
    next: { title: first.title, at: first.min, gains: describeGains(privilegesFor(null), privilegesFor(first.rank)) },
  };
}

/** Human-readable differences between two privilege sets. */
function describeGains(from: Privileges, to: Privileges): string[] {
  const gains: string[] = [];
  if (to.postsPerDay > from.postsPerDay) gains.push(`${to.postsPerDay} posts a day`);
  if (to.groupCap > from.groupCap) gains.push(`rooms of ${to.groupCap}`);
  if (to.giftCapMinor > from.giftCapMinor) gains.push(`gifts up to ${(to.giftCapMinor / 100).toLocaleString()}`);
  if (to.rakeBps < from.rakeBps) gains.push(`${(to.rakeBps / 100).toFixed(1)}% rake instead of ${(from.rakeBps / 100).toFixed(1)}%`);
  if (to.featuredProfile && !from.featuredProfile) gains.push("featured in discovery");
  if (to.goldNameplate && !from.goldNameplate) gains.push("a gold nameplate");
  if (to.roomTheme !== from.roomTheme) gains.push(`the ${to.roomTheme} room theme`);
  return gains;
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
  const owned = await queryMany<{ cosmetic_id: string; serial: number | null }>(
    ctx.pool,
    `SELECT cosmetic_id, serial FROM cosmetic_purchases WHERE user_id = $1`,
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
    /** The holder's number in a limited run, keyed by cosmetic id. */
    serials: Object.fromEntries(owned.map((o) => [o.cosmetic_id, o.serial])),
  };
}

/** How many copies of each limited edition have been sold. */
async function soldCounts(ctx: AppContext, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await queryMany<{ cosmetic_id: string; sold: string }>(
    ctx.pool,
    `SELECT cosmetic_id, count(*)::text AS sold
       FROM cosmetic_purchases
      WHERE cosmetic_id = ANY($1::text[])
      GROUP BY cosmetic_id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.cosmetic_id, Number(r.sold)]));
}

/**
 * The looks a person is wearing, with their edition numbers. This is the
 * public half of the wardrobe: a nameplate shows the frame, not the receipt.
 */
async function wornLookFor(ctx: AppContext, userId: string): Promise<{ frame: WornCosmetic | null; outfit: WornCosmetic | null }> {
  const rows = await queryMany<{ kind: string; cosmetic_id: string; serial: number | null; edition_size: number | null }>(
    ctx.pool,
    `SELECT w.kind, w.cosmetic_id, p.serial, p.edition_size
       FROM cosmetic_worn w
       LEFT JOIN cosmetic_purchases p
              ON p.user_id = w.user_id AND p.cosmetic_id = w.cosmetic_id
      WHERE w.user_id = $1`,
    [userId],
  );
  const look: { frame: WornCosmetic | null; outfit: WornCosmetic | null } = { frame: null, outfit: null };
  for (const row of rows) {
    const c = cosmeticById(row.cosmetic_id);
    if (!c || (row.kind !== "frame" && row.kind !== "outfit")) continue;
    look[row.kind] = {
      id: c.id,
      kind: c.kind,
      label: c.label,
      style: c.style,
      serial: row.serial,
      editionSize: row.edition_size,
    };
  }
  return look;
}

export function identityStatusRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // The catalogue: everything buyable, with what the viewer owns and wears.
    app.get("/v1/cosmetics", async (req) => {
      const user = await requireUser(ctx, req);
      const { owned, worn, serials } = await wardrobeFor(ctx, user.id);
      const sold = await soldCounts(ctx, COSMETICS.filter((c) => c.editionSize).map((c) => c.id));
      return {
        cosmetics: COSMETICS.map((c) => {
          const soldNow = sold.get(c.id);
          return {
            ...c,
            owned: owned.includes(c.id),
            worn: worn.frame === c.id || worn.outfit === c.id,
            // A limited run reports what is left; an open cosmetic reports nulls
            // so the client never renders a "0 of 0" badge.
            serial: serials[c.id] ?? null,
            editionSize: c.editionSize ?? null,
            remaining: c.editionSize ? Math.max(0, c.editionSize - (soldNow ?? 0)) : null,
          };
        }),
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
        // Same stored-value rule as a wallet send: read and debit under one
        // lock, or two concurrent buys can both pass the balance check.
        await lockWalletAccount(tx, user.id, cosmetic.currency);
        const already = await tx.query(
          `SELECT 1 FROM cosmetic_purchases WHERE user_id = $1 AND cosmetic_id = $2`,
          [user.id, id],
        );
        if (already.rowCount) throw ApiError.badRequest("You already own that");

        const balance = await walletBalance(tx as unknown as AppContext["pool"], user.id, cosmetic.currency);
        if (balance.balanceMinor < cosmetic.priceMinor) throw ApiError.badRequest("Not enough Vibe Yens");

        // A limited run needs a number, and two buyers must never draw the same
        // one. The advisory lock serialises buyers of this cosmetic (not of every
        // cosmetic), and the highest number handed out so far is read inside the
        // same transaction. The unique index on (cosmetic_id, serial) is the
        // backstop if anything ever bypasses this path.
        let serial: number | null = null;
        if (cosmetic.editionSize) {
          await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cosmetic:${id}`]);
          const drawn = await tx.query<{ sold: string; highest: string | null }>(
            `SELECT count(*)::text AS sold, max(serial)::text AS highest
               FROM cosmetic_purchases WHERE cosmetic_id = $1`,
            [id],
          );
          const sold = Number(drawn.rows[0]?.sold ?? 0);
          if (sold >= cosmetic.editionSize) throw ApiError.conflict("That edition is sold out");
          serial = Number(drawn.rows[0]?.highest ?? 0) + 1;
        }

        await tx.query(
          `INSERT INTO cosmetic_purchases (user_id, cosmetic_id, price_minor, currency, serial, edition_size)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [user.id, id, cosmetic.priceMinor, cosmetic.currency, serial, cosmetic.editionSize ?? null],
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
      const rows = await queryMany<{
        id: string;
        handle: string;
        display_name: string;
        avatar_url: string | null;
        activity: string;
        frame_id: string | null;
        frame_serial: number | null;
        frame_edition: number | null;
        outfit_id: string | null;
        outfit_serial: number | null;
        outfit_edition: number | null;
      }>(
        ctx.pool,
        `SELECT u.id, u.handle, u.display_name, u.avatar_url,
                ( (SELECT count(*) FROM posts p WHERE p.author_id = u.id AND p.created_at > now() - interval '7 days' AND p.status = 'published')
                + (SELECT count(*) FROM activity_rooms r WHERE r.host_id = u.id AND r.created_at > now() - interval '7 days')
                + (SELECT count(*) FROM battle_comments c WHERE c.user_id = u.id AND c.created_at > now() - interval '7 days')
                + (SELECT count(*) FROM battle_gifts g WHERE g.user_id = u.id AND g.created_at > now() - interval '7 days')
                + (SELECT count(*) FROM post_gifts pg WHERE pg.sender_id = u.id AND pg.created_at > now() - interval '7 days')
                )::text AS activity,
                wf.cosmetic_id AS frame_id, pf.serial AS frame_serial, pf.edition_size AS frame_edition,
                wo.cosmetic_id AS outfit_id, po.serial AS outfit_serial, po.edition_size AS outfit_edition
           FROM users u
           LEFT JOIN cosmetic_worn wf ON wf.user_id = u.id AND wf.kind = 'frame'
           LEFT JOIN cosmetic_purchases pf ON pf.user_id = u.id AND pf.cosmetic_id = wf.cosmetic_id
           LEFT JOIN cosmetic_worn wo ON wo.user_id = u.id AND wo.kind = 'outfit'
           LEFT JOIN cosmetic_purchases po ON po.user_id = u.id AND po.cosmetic_id = wo.cosmetic_id
          WHERE u.deleted_at IS NULL
          ORDER BY activity DESC
          LIMIT 50`,
      );
      // Only the movers are on the board, but "ahead" is counted against the
      // whole board: a tie shares a tier, exactly as standingFor decides it.
      const movers = rows.map((r) => ({ row: r, activity: Number(r.activity) })).filter((m) => m.activity > 0);
      const withStanding = movers.map(({ row: r, activity }) => {
        const ahead = movers.filter((m) => m.activity > activity).length;
        const tier = TIERS.find((t) => activity >= t.min && ahead <= t.maxAhead) ?? null;
        const wired = (id: string | null, serial: number | null, edition: number | null): WornCosmetic | null => {
          const c = cosmeticById(id);
          if (!c) return null;
          return { id: c.id, kind: c.kind, label: c.label, style: c.style, serial, editionSize: edition };
        };
        return {
          user: { id: r.id, handle: r.handle, displayName: r.display_name, avatarUrl: r.avatar_url },
          activity,
          standing: tier ? { title: tier.title, rank: tier.rank } : null,
          look: {
            frame: wired(r.frame_id, r.frame_serial, r.frame_edition),
            outfit: wired(r.outfit_id, r.outfit_serial, r.outfit_edition),
          },
        };
      });
      return { board: withStanding };
    });

    // A nameplate: what a person has earned, what they bought, and the number
    // they hold. This is the one read that lets any surface - a room, a post, a
    // profile - show the same identity without each one inventing its own.
    app.get("/v1/nameplates/:handle", async (req) => {
      await requireUser(ctx, req);
      const { handle } = req.params as { handle: string };
      const row = await queryOne<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
        ctx.pool,
        `SELECT id, handle, display_name, avatar_url
           FROM users
          WHERE handle = $1 AND deleted_at IS NULL`,
        [handle.replace(/^@/, "")],
      );
      if (!row) throw ApiError.notFound("No such person");
      const [standing, look] = await Promise.all([standingFor(ctx, row.id), wornLookFor(ctx, row.id)]);
      return {
        nameplate: {
          user: { id: row.id, handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url },
          standing,
          look,
        },
      };
    });
  };
}
