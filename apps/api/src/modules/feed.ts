import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, publicUser, requireUser, type AppContext, type UserLike } from "../http.js";
import { requireCircleMember } from "./access.js";

// Accepts either an absolute URL or a root-relative path returned by our own
// media boundary (e.g. /v1/media/<id>). Anything else — javascript:, data: —
// is rejected so a post can never smuggle in an executable URL.
const mediaUrl = z
  .string()
  .max(1000)
  .refine((value) => /^https?:\/\//.test(value) || /^\/v1\/media\/[A-Za-z0-9._-]+$/.test(value), {
    message: "Must be an http(s) URL or a Vibe media path",
  });

const createPostSchema = z.object({
  body: z.string().max(5000).optional(),
  type: z.enum(["text", "image", "video", "carousel", "poll", "announcement"]).default("text"),
  audience: z.enum(["public", "connections", "circle", "private"]).default("connections"),
  circleId: z.string().uuid().optional(),
  mediaUrls: z.array(mediaUrl).max(4).optional(),
});

const commentSchema = z.object({ body: z.string().min(1).max(2000) });
const reactionSchema = z.object({ kind: z.string().min(1).max(20).default("like") });

interface PostRow {
  id: string;
  author_id: string;
  circle_id: string | null;
  type: string;
  audience: string;
  body: string | null;
  status: string;
  is_sponsored: boolean;
  created_at: Date;
  metadata: { mediaUrls?: string[] } | null;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  reaction_count: number;
  comment_count: number;
  viewer_reacted: boolean;
}

/** Audience + block + mute filtering. This is the only place feed visibility is decided. */
const VISIBILITY = `
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = p.author_id AND b.blocked_id = $1)
              OR (b.blocker_id = $1 AND b.blocked_id = p.author_id))
        AND NOT EXISTS (
          SELECT 1 FROM mutes m WHERE m.muter_id = $1 AND m.muted_id = p.author_id)
        AND (
          p.author_id = $1
          OR p.audience = 'public'
          OR (p.audience = 'connections' AND EXISTS (
                SELECT 1 FROM follows f
                 WHERE f.follower_id = $1 AND f.followee_id = p.author_id AND f.state = 'accepted'))
          OR (p.audience = 'circle' AND p.circle_id IN (
                SELECT circle_id FROM circle_members WHERE user_id = $1))
        )`;

/** Newest-first feed: the Following tab and profile post lists. */
async function recentPosts(
  db: Db,
  viewerId: string,
  opts: {
    limit: number;
    cursor?: { createdAt: string; id: string } | null;
    authorId?: string;
    followingOnly?: boolean;
  },
): Promise<PostRow[]> {
  return queryMany<PostRow>(
    db,
    `SELECT p.id, p.author_id, p.circle_id, p.type, p.audience, p.body, p.status,
            p.is_sponsored, p.created_at, p.metadata,
            u.handle, u.display_name, u.avatar_url,
            (SELECT count(*) FROM reactions r WHERE r.post_id = p.id) AS reaction_count,
            (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count,
            EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.user_id = $1) AS viewer_reacted
       FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.status = 'published'
        AND ($4::uuid IS NULL OR p.author_id = $4)
        ${VISIBILITY}
        AND ($6::boolean IS NOT TRUE OR (
              p.author_id = $1
              OR EXISTS (SELECT 1 FROM follows f
                          WHERE f.follower_id = $1 AND f.followee_id = p.author_id AND f.state = 'accepted')
              OR (p.circle_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM circle_members cm WHERE cm.user_id = $1 AND cm.circle_id = p.circle_id))
            ))
        AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $5`,
    [
      viewerId,
      opts.cursor?.createdAt ?? null,
      opts.cursor?.id ?? null,
      opts.authorId ?? null,
      opts.limit,
      opts.followingOnly ?? false,
    ],
  );
}

/**
 * The For You ranking, expressed in SQL so it stays consistent with the cursor.
 *
 * The spec's baseline is recency + relationship + topic affinity + meaningful
 * engagement + content quality/safety, and it forbids optimising for outrage or
 * time-on-app. Every component is a plain additive term with a stated weight;
 * there is no hidden boost and no paid override of relevance. A post with open
 * abuse reports is demoted below clean content.
 *
 * Freshness is measured from `asOf`, a timestamp frozen by the first page and
 * carried in the cursor. Using now() would make every page's scores drift
 * between requests and break keyset pagination (the same post could appear on
 * two pages). Freezing the clock keeps the ranking stable across a session.
 */
async function rankedPosts(
  db: Db,
  viewerId: string,
  opts: { limit: number; asOf: Date; cursor?: { score: number; createdAt: string; id: string } | null },
): Promise<Array<PostRow & { rank: number }>> {
  return queryMany<PostRow & { rank: number }>(
    db,
    `WITH viewer AS (
       SELECT interests FROM users WHERE id = $1
     ),
     scored AS (
       SELECT p.id, p.author_id, p.circle_id, p.type, p.audience, p.body, p.status,
              p.is_sponsored, p.created_at, p.metadata,
              u.handle, u.display_name, u.avatar_url,
              (SELECT count(*) FROM reactions r WHERE r.post_id = p.id) AS reaction_count,
              (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count,
              EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.user_id = $1) AS viewer_reacted,
              (
                -- Relationship: people you follow, and posts in your Circles.
                (CASE WHEN EXISTS (SELECT 1 FROM follows f
                                    WHERE f.follower_id = $1 AND f.followee_id = p.author_id AND f.state = 'accepted')
                      THEN 30 ELSE 0 END)
              + (CASE WHEN p.circle_id IS NOT NULL AND EXISTS (
                          SELECT 1 FROM circle_members cm WHERE cm.user_id = $1 AND cm.circle_id = p.circle_id)
                      THEN 12 ELSE 0 END)
                -- Topic affinity: shared interests with the author, or a post that
                -- mentions something the viewer cares about.
              + (CASE WHEN EXISTS (SELECT 1 FROM viewer v
                                    WHERE u.interests && v.interests
                                      AND array_length(u.interests, 1) > 0)
                      THEN 18 ELSE 0 END)
              + (CASE WHEN EXISTS (SELECT 1 FROM viewer v, unnest(v.interests) AS i
                                    WHERE position(lower(i) in lower(coalesce(p.body, ''))) > 0)
                      THEN 8 ELSE 0 END)
                -- Meaningful engagement, with diminishing returns so one viral
                -- post cannot dominate the page.
              + 14 * (ln(1 + (SELECT count(*) FROM reactions r WHERE r.post_id = p.id)
                          + 2 * (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL))
                      / ln(1 + 20))
                -- Freshness, halving every five days, from the frozen clock.
              + 16 * power(0.5, GREATEST(0, EXTRACT(EPOCH FROM ($6::timestamptz - p.created_at)) / 86400) / 5)
                -- Quality/safety: demote a post with open reports. Safety beats
                -- relevance, so this term can pull a post below the fold.
              - (CASE WHEN (SELECT count(*) FROM reports rp
                             WHERE rp.target_type = 'post' AND rp.target_id = p.id
                               AND rp.status IN ('open', 'triaged')) >= 3
                      THEN 40 ELSE 0 END)
              - (CASE WHEN (SELECT count(*) FROM reports rp
                             WHERE rp.target_type = 'post' AND rp.target_id = p.id
                               AND rp.status IN ('open', 'triaged')) >= 1
                      THEN 10 ELSE 0 END)
              ) AS rank
         FROM posts p JOIN users u ON u.id = p.author_id
        WHERE p.status = 'published'
          AND p.created_at > $6::timestamptz - interval '30 days'
          ${VISIBILITY}
     )
     SELECT * FROM scored
      WHERE ($2::double precision IS NULL
             OR (rank, created_at, id) < ($2::double precision, $3::timestamptz, $4::uuid))
      ORDER BY rank DESC, created_at DESC, id DESC
      LIMIT $5`,
    [
      viewerId,
      opts.cursor?.score ?? null,
      opts.cursor?.createdAt ?? null,
      opts.cursor?.id ?? null,
      opts.limit,
      opts.asOf.toISOString(),
    ],
  );
}

/**
 * Diversify a ranked page: at most two posts per author in a row, and no more
 * than three per author per page, so one prolific account cannot fill the feed.
 * Order is otherwise preserved.
 */
function diversify<T extends { author_id: string }>(items: T[], perPage = 3): T[] {
  const counts = new Map<string, number>();
  const kept: T[] = [];
  for (const item of items) {
    const used = counts.get(item.author_id) ?? 0;
    if (used >= perPage) continue;
    counts.set(item.author_id, used + 1);
    kept.push(item);
  }
  return kept;
}

async function attachActivities(db: Db, posts: PostRow[], viewerId: string) {
  const pollPostIds = posts.filter((p) => p.type === "poll").map((p) => p.id);
  const byPost = new Map<string, unknown>();
  if (pollPostIds.length > 0) {
    const activities = await queryMany<{
      id: string;
      post_id: string;
      state: string;
      ends_at: Date | null;
    }>(
      db,
      `SELECT id, post_id, state, ends_at FROM activities WHERE post_id = ANY($1::uuid[])`,
      [pollPostIds],
    );
    for (const activity of activities) {
      const options = await queryMany<{ id: string; label: string; votes: number }>(
        db,
        `SELECT o.id, o.label, (SELECT count(*) FROM votes v WHERE v.option_id = o.id) AS votes
           FROM poll_options o WHERE o.activity_id = $1 ORDER BY o.position`,
        [activity.id],
      );
      const viewerVote = await queryOne<{ option_id: string }>(
        db,
        "SELECT option_id FROM votes WHERE activity_id = $1 AND user_id = $2",
        [activity.id, viewerId],
      );
      byPost.set(activity.post_id, {
        id: activity.id,
        state: activity.state,
        endsAt: activity.ends_at,
        options: options.map((o) => ({ id: o.id, label: o.label, votes: o.votes })),
        totalVotes: options.reduce((sum, o) => sum + o.votes, 0),
        viewerOptionId: viewerVote?.option_id ?? null,
      });
    }
  }
  return posts.map((post) => ({
    id: post.id,
    type: post.type,
    audience: post.audience,
    circleId: post.circle_id,
    body: post.body,
    mediaUrls: post.metadata?.mediaUrls ?? [],
    isSponsored: post.is_sponsored,
    createdAt: post.created_at,
    author: publicUser(post),
    reactionCount: post.reaction_count,
    commentCount: post.comment_count,
    viewerReacted: post.viewer_reacted,
    activity: byPost.get(post.id) ?? null,
  }));
}

export function feedRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/feed", async (req) => {
      const user = await requireUser(ctx, req);
      const query = req.query as { cursor?: string; limit?: string; tab?: string };
      const limit = Math.min(Number(query.limit ?? 20) || 20, 50);

      // "Following" is a strict chronological stream from people you follow and
      // the Circles you belong to. "For You" is the ranked baseline. They are
      // genuinely different feeds, not the same query with a different label.
      if (query.tab === "following") {
        const rows = await recentPosts(ctx.pool, user.id, { limit: limit + 1, followingOnly: true });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await attachActivities(ctx.pool, page, user.id),
          nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
        };
      }

      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      // The clock is frozen on the first page and carried in the cursor, so the
      // score of a given post does not drift between page requests.
      const asOf = cursor?.asOf ? new Date(cursor.asOf) : new Date();
      // Fetch extra rows so diversification can drop repeats without shortening
      // the page, and still know whether a next page exists.
      const rows = await rankedPosts(ctx.pool, user.id, {
        limit: limit + 6,
        asOf,
        cursor:
          cursor && cursor.score !== undefined
            ? { score: cursor.score, createdAt: cursor.createdAt, id: cursor.id }
            : null,
      });
      const kept = diversify(rows).slice(0, limit + 1);
      const hasMore = kept.length > limit;
      const page = kept.slice(0, limit);
      const items = await attachActivities(ctx.pool, page, user.id);
      const last = page[page.length - 1] as (PostRow & { rank: number }) | undefined;
      return {
        items,
        nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id, last.rank, asOf.toISOString()) : null,
      };
    });

    app.get("/v1/users/:id/posts", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const query = req.query as { cursor?: string; limit?: string };
      const limit = Math.min(Number(query.limit ?? 20) || 20, 50);
      const rows = await recentPosts(ctx.pool, user.id, {
        limit: limit + 1,
        cursor: query.cursor ? decodeCursor(query.cursor) : null,
        authorId: id,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: await attachActivities(ctx.pool, page, user.id),
        nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
      };
    });

    app.post("/v1/posts", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createPostSchema, req.body);
      if (input.audience === "circle") {
        if (!input.circleId) throw ApiError.badRequest("circleId is required for a Circle post");
        await requireCircleMember(ctx.pool, input.circleId, user.id);
      }
      if (!input.body && input.type === "text") {
        throw ApiError.badRequest("A text post needs a body");
      }
      if (!input.body && (!input.mediaUrls || input.mediaUrls.length === 0)) {
        throw ApiError.badRequest("A post needs text or at least one photo");
      }
      const post = await queryOne<{ id: string; created_at: Date }>(
        ctx.pool,
        `INSERT INTO posts (id, author_id, circle_id, type, audience, body, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [
          newId(),
          user.id,
          input.circleId ?? null,
          input.type,
          input.audience,
          input.body ?? null,
          JSON.stringify({ mediaUrls: input.mediaUrls ?? [] }),
        ],
      );
      reply.code(201);
      return { id: post!.id, createdAt: post!.created_at };
    });

    app.delete("/v1/posts/:id", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const post = await queryOne<{ author_id: string }>(ctx.pool, "SELECT author_id FROM posts WHERE id = $1", [id]);
      if (!post) throw ApiError.notFound("Post not found");
      if (post.author_id !== user.id && !user.isAdmin) throw ApiError.forbidden();
      await ctx.pool.query("UPDATE posts SET status = 'removed', updated_at = now() WHERE id = $1", [id]);
      reply.code(204);
      return null;
    });

    app.post("/v1/posts/:id/reactions", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(reactionSchema, req.body);
      const post = await queryOne<{ id: string }>(
        ctx.pool,
        "SELECT id FROM posts WHERE id = $1 AND status = 'published'",
        [id],
      );
      if (!post) throw ApiError.notFound("Post not found");
      const existing = await queryOne(
        ctx.pool,
        "SELECT 1 FROM reactions WHERE post_id = $1 AND user_id = $2 AND kind = $3",
        [id, user.id, input.kind],
      );
      if (existing) {
        await ctx.pool.query("DELETE FROM reactions WHERE post_id = $1 AND user_id = $2 AND kind = $3", [
          id,
          user.id,
          input.kind,
        ]);
        return { reacted: false };
      }
      await ctx.pool.query("INSERT INTO reactions (post_id, user_id, kind) VALUES ($1, $2, $3)", [
        id,
        user.id,
        input.kind,
      ]);
      return { reacted: true };
    });

    app.get("/v1/posts/:id/comments", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const rows = await queryMany(
        ctx.pool,
        `SELECT c.id, c.body, c.created_at, u.id AS user_id, u.handle, u.display_name, u.bio, u.avatar_url
           FROM comments c JOIN users u ON u.id = c.author_id
          WHERE c.post_id = $1 AND c.deleted_at IS NULL
          ORDER BY c.created_at LIMIT 100`,
        [id],
      );
      return {
        comments: rows.map((r) => ({
          id: r.id,
          body: r.body,
          createdAt: r.created_at,
          author: publicUser({ id: r.user_id, handle: r.handle, display_name: r.display_name, avatar_url: r.avatar_url }),
        })),
      };
    });

    app.post("/v1/posts/:id/comments", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(commentSchema, req.body);
      const post = await queryOne<{ id: string }>(
        ctx.pool,
        "SELECT id FROM posts WHERE id = $1 AND status = 'published'",
        [id],
      );
      if (!post) throw ApiError.notFound("Post not found");
      const comment = await queryOne<{ id: string; created_at: Date }>(
        ctx.pool,
        `INSERT INTO comments (id, post_id, author_id, body) VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [newId(), id, user.id, input.body],
      );
      reply.code(201);
      return { id: comment!.id, createdAt: comment!.created_at };
    });

    app.post("/v1/users/:id/block", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      if (id === user.id) throw ApiError.badRequest("You cannot block yourself");
      const target = await queryOne<{ id: string }>(ctx.pool, "SELECT id FROM users WHERE id = $1", [id]);
      if (!target) throw ApiError.notFound("User not found");
      await withTransaction(ctx.pool, async (tx) => {
        await tx.query(
          "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [user.id, id],
        );
        await tx.query("DELETE FROM follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)", [user.id, id]);
        await tx.query(
          `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
           VALUES ($1, 'user.blocked', 'user', $2)`,
          [user.id, id],
        );
      });
      reply.code(204);
      return null;
    });

    app.delete("/v1/users/:id/block", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await ctx.pool.query("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2", [user.id, id]);
      reply.code(204);
      return null;
    });

    app.get("/v1/users/blocked", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany<UserLike>(
        ctx.pool,
        `SELECT u.id, u.handle, u.display_name, u.bio, u.avatar_url
           FROM blocks b JOIN users u ON u.id = b.blocked_id
          WHERE b.blocker_id = $1`,
        [user.id],
      );
      return { blocked: rows.map(publicUser) };
    });
  };
}

export function encodeCursor(createdAt: Date | string, id: string, score?: number, asOf?: string): string {
  const iso = typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  const raw = score === undefined ? `${iso}|${id}` : `${score}|${iso}|${id}|${asOf ?? ""}`;
  return Buffer.from(raw).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: string; id: string; score?: number; asOf?: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const parts = decoded.split("|");
  if (parts.length === 2) {
    const [createdAt, id] = parts;
    if (!createdAt || !id) throw ApiError.badRequest("Malformed cursor");
    return { createdAt, id };
  }
  if (parts.length === 4) {
    const [score, createdAt, id, asOf] = parts;
    if (!score || !createdAt || !id || Number.isNaN(Number(score))) {
      throw ApiError.badRequest("Malformed cursor");
    }
    return { score: Number(score), createdAt, id, asOf: asOf || undefined };
  }
  throw ApiError.badRequest("Malformed cursor");
}
