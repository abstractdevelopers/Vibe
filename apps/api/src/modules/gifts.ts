import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { queryMany, queryOne } from "../db.js";
import { ApiError } from "../errors.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";
import { requirePostVisible } from "./feed.js";
import { notifyUsers } from "./notifications.js";

/**
 * Non-monetary social gifts.
 *
 * A gift is a small social gesture on a post — never money. There is no price,
 * balance, top-up, cash-out or redemption, because the spec forbids stored value
 * and P2P transfer in V1. The catalogue below is the single source of truth: the
 * server rejects any kind not in it, so a client can never invent a gift that
 * carries a value, and no gift row has a monetary column at all.
 *
 * Gifting is rate-limited to one of each kind per sender per post, which keeps
 * it a gesture rather than a grind and blocks simple spam.
 */
export const GIFT_KINDS = [
  { id: "sparkle", label: "Sparkle", hint: "You lit this up" },
  { id: "high_five", label: "High five", hint: "Nice one" },
  { id: "cheer", label: "Cheer", hint: "Rooting for you" },
  { id: "hug", label: "Hug", hint: "Sending warmth" },
  { id: "fire", label: "Fire", hint: "This is great" },
] as const;

const KIND_IDS = GIFT_KINDS.map((g) => g.id) as [string, ...string[]];

const giftSchema = z.object({
  kind: z.enum(KIND_IDS),
  note: z.string().max(140).optional(),
});

export function giftsRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/gifts/catalogue", async (req) => {
      await requireUser(ctx, req);
      return {
        gifts: GIFT_KINDS.map((g) => ({ ...g })),
        // Stated plainly so the client can surface it and no one mistakes this
        // for a paid feature.
        policy: "Gifts are free social gestures. They carry no money, balance or value.",
      };
    });

    app.get("/v1/posts/:id/gifts", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await requirePostVisible(ctx, id, user.id);

      const rows = await queryMany(
        ctx.pool,
        `SELECT g.kind, count(*)::int AS count
           FROM post_gifts g WHERE g.post_id = $1
          GROUP BY g.kind`,
        [id],
      );
      const byKind = new Map(rows.map((r) => [r.kind as string, Number(r.count)]));
      const mine = await queryMany<{ kind: string }>(
        ctx.pool,
        "SELECT kind FROM post_gifts WHERE post_id = $1 AND sender_id = $2",
        [id, user.id],
      );
      const mineSet = new Set(mine.map((m) => m.kind));
      const total = rows.reduce((sum, r) => sum + Number(r.count), 0);

      return {
        total,
        gifts: GIFT_KINDS.map((g) => ({
          ...g,
          count: byKind.get(g.id) ?? 0,
          viewerSent: mineSet.has(g.id),
        })),
      };
    });

    app.post("/v1/posts/:id/gifts", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(giftSchema, req.body);

      // Keep the explicit block answer (403) before the visibility check, which
      // deliberately reports anything it hides as 404.
      const existingPost = await queryOne<{ author_id: string }>(
        ctx.pool,
        "SELECT author_id FROM posts WHERE id = $1 AND status = 'published'",
        [id],
      );
      if (!existingPost) throw ApiError.notFound("Post not found");
      const blocked = await queryOne<{ one: number }>(
        ctx.pool,
        `SELECT 1 AS one FROM blocks
          WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
          LIMIT 1`,
        [user.id, existingPost.author_id],
      );
      if (blocked) throw ApiError.forbidden("You cannot gift this post");

      // Visibility also covers audience and mutes, so a private post's id is
      // not a key to its gift list either.
      const post = await requirePostVisible(ctx, id, user.id);
      if (post.author_id === user.id) throw ApiError.badRequest("You cannot gift your own post");

      // ON CONFLICT makes a repeat a no-op rather than a duplicate.
      const inserted = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO post_gifts (post_id, sender_id, recipient_id, kind, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (post_id, sender_id, kind) DO NOTHING
         RETURNING id`,
        [id, user.id, post.author_id, input.kind, input.note?.trim() || null],
      );

      if (inserted) {
        // `notifyUsers` writes the row and publishes it, and — unlike a raw
        // INSERT — honours the recipient's `gift` opt-out.
        await notifyUsers(ctx, [post.author_id], "gift.received", "post", id, {
          kind: input.kind,
          from: user.handle,
        });
      }

      reply.code(inserted ? 201 : 200);
      return { ok: true, alreadySent: !inserted };
    });

    /** A small inbox of gifts the viewer has received. */
    app.get("/v1/gifts/received", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT g.id, g.kind, g.note, g.created_at, g.post_id,
                u.id AS sender_id, u.handle, u.display_name, u.avatar_url, u.bio
           FROM post_gifts g JOIN users u ON u.id = g.sender_id
          WHERE g.recipient_id = $1
          ORDER BY g.created_at DESC LIMIT 50`,
        [user.id],
      );
      return {
        gifts: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          label: GIFT_KINDS.find((g) => g.id === r.kind)?.label ?? r.kind,
          note: r.note,
          postId: r.post_id,
          createdAt: r.created_at,
          from: publicUser(r as never),
        })),
      };
    });
  };
}
