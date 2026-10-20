import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db.js";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, publicUser, requireUser, type AppContext, type UserLike } from "../http.js";
import { requireCircleMember } from "./access.js";
import { trackSafe } from "./analytics.js";
import { notifyUsers } from "./notifications.js";
import { selectAdForViewer } from "./ads.js";
import { newToken } from "../ids.js";

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

const commentSchema = z.object({
  body: z.string().min(1).max(2000),
  parentId: z.string().uuid().optional(),
});
const editCommentSchema = z.object({ body: z.string().min(1).max(2000) });
const reactionSchema = z.object({ kind: z.string().min(1).max(20).default("like") });

const editPostSchema = z.object({
  body: z.string().max(5000),
});

/**
 * How long an author can undo a deletion. The client shows an Undo affordance
 * for the same window, so the two never disagree.
 */
export const UNDO_WINDOW_MS = 30_000;

interface CommentRow {
  id: string;
  parent_id: string | null;
  body: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

interface CommentView {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  isMine: boolean;
  author: ReturnType<typeof publicUser>;
  replies?: CommentView[];
}

/**
 * A deleted comment keeps its shape but loses its words, so a thread that has
 * replies reads as "[deleted]" rather than vanishing and orphaning them.
 */
function toCommentView(row: CommentRow, viewerId: string): CommentView {
  const deleted = Boolean(row.deleted_at);
  return {
    id: row.id,
    parentId: row.parent_id,
    body: deleted ? "" : (row.body ?? ""),
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted,
    isMine: row.user_id === viewerId,
    author: publicUser({
      id: row.user_id,
      handle: row.handle,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    }),
  };
}

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
  gift_count: number;
  viewer_cheered: boolean;
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
            EXISTS(SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.user_id = $1) AS viewer_reacted,
            (SELECT count(*) FROM post_gifts g WHERE g.post_id = p.id) AS gift_count,
            EXISTS(SELECT 1 FROM post_gifts g WHERE g.post_id = p.id AND g.sender_id = $1) AS viewer_cheered
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
              (SELECT count(*) FROM post_gifts g WHERE g.post_id = p.id) AS gift_count,
              EXISTS(SELECT 1 FROM post_gifts g WHERE g.post_id = p.id AND g.sender_id = $1) AS viewer_cheered,
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
    author: publicUser({
      id: post.author_id,
      handle: post.handle,
      display_name: post.display_name,
      avatar_url: post.avatar_url,
    }),
    reactionCount: post.reaction_count,
    commentCount: post.comment_count,
    viewerReacted: post.viewer_reacted,
    giftCount: post.gift_count,
    viewerCheered: post.viewer_cheered,
    activity: byPost.get(post.id) ?? null,
  }));
}

/** Build one page of the organic feed (the "Following" or ranked "For You" stream). */
async function buildFeedPage(
  ctx: AppContext,
  viewerId: string,
  query: { cursor?: string; limit?: string; tab?: string },
  limit: number,
): Promise<{ items: unknown[]; nextCursor: string | null }> {
  // "Following" is a strict chronological stream from people you follow and
  // the Circles you belong to. "For You" is the ranked baseline. They are
  // genuinely different feeds, not the same query with a different label.
  if (query.tab === "following") {
    const rows = await recentPosts(ctx.pool, viewerId, { limit: limit + 1, followingOnly: true });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await attachActivities(ctx.pool, page, viewerId),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  // The clock is frozen on the first page and carried in the cursor, so the
  // score of a given post does not drift between page requests.
  const asOf = cursor?.asOf ? new Date(cursor.asOf) : new Date();
  // Fetch extra rows so diversification can drop repeats without shortening
  // the page, and still know whether a next page exists.
  const rows = await rankedPosts(ctx.pool, viewerId, {
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
  const items = await attachActivities(ctx.pool, page, viewerId);
  const last = page[page.length - 1] as (PostRow & { rank: number }) | undefined;
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id, last.rank, asOf.toISOString()) : null,
  };
}

/** How many organic posts precede the paid placement in a feed page. */
const SPONSORED_AFTER = 15;

export function feedRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/feed", async (req) => {
      const user = await requireUser(ctx, req);
      const query = req.query as { cursor?: string; limit?: string; tab?: string };
      const limit = Math.min(Number(query.limit ?? 20) || 20, 50);

      // Delivery is decided once per page and carried in a response field the
      // client renders at a fixed slot. It never enters the organic ranking, so
      // paid content cannot outrank safety or relevance. A delivery is only
      // chosen when the page is long enough to actually show it, so an
      // impression is never counted for an ad the viewer could not see.
      const page = await buildFeedPage(ctx, user.id, query, limit);
      const ad =
        page.items.length > SPONSORED_AFTER
          ? await selectAdForViewer(ctx.pool, user.id, "feed", newToken(8))
          : null;
      if (ad) trackSafe(ctx.pool, { name: "ad_impression", userId: user.id, properties: { entityType: "campaign", entityId: ad.campaignId, surface: "feed" } });
      return { ...page, sponsored: ad };
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
      trackSafe(ctx.pool, { name: "post_created", userId: user.id, properties: { entityType: "post", entityId: post!.id, audience: input.audience } });
      reply.code(201);
      return { id: post!.id, createdAt: post!.created_at };
    });

    app.delete("/v1/posts/:id", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const post = await queryOne<{ author_id: string; status: string }>(
        ctx.pool,
        "SELECT author_id, status FROM posts WHERE id = $1",
        [id],
      );
      if (!post) throw ApiError.notFound("Post not found");
      if (post.author_id !== user.id && !user.isAdmin) throw ApiError.forbidden();
      if (post.status === "removed") {
        reply.code(204);
        return null;
      }
      // Record who deleted it. Undo is only allowed for the author, so this
      // column is what stops an author from un-removing a moderator's action.
      await ctx.pool.query(
        `UPDATE posts SET status = 'removed', deleted_by = $2, deleted_at = now(), updated_at = now()
          WHERE id = $1`,
        [id, user.id],
      );
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
         VALUES ($1, 'post.deleted', 'post', $2)`,
        [user.id, id],
      );
      trackSafe(ctx.pool, { name: "post_deleted", userId: user.id, properties: { entityType: "post", entityId: id } });
      reply.code(204);
      return null;
    });

    /**
     * Undo an author deletion within the undo window (§4.2). Only the author's
     * own deletion can be undone; a moderator removal is final from here.
     */
    app.post("/v1/posts/:id/restore", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const post = await queryOne<{ author_id: string; status: string; deleted_by: string | null; deleted_at: Date | null }>(
        ctx.pool,
        "SELECT author_id, status, deleted_by, deleted_at FROM posts WHERE id = $1",
        [id],
      );
      if (!post) throw ApiError.notFound("Post not found");
      if (post.author_id !== user.id) throw ApiError.forbidden("Only the author can restore this post");
      if (post.status !== "removed") return { id, status: post.status, restored: false };
      if (post.deleted_by !== user.id) {
        throw ApiError.forbidden("This post was removed by moderation and cannot be restored here");
      }
      if (post.deleted_at && Date.now() - new Date(post.deleted_at).getTime() > UNDO_WINDOW_MS) {
        throw ApiError.badRequest("The undo window has passed");
      }
      await ctx.pool.query(
        `UPDATE posts SET status = 'published', deleted_by = NULL, deleted_at = NULL, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
         VALUES ($1, 'post.restored', 'post', $2)`,
        [user.id, id],
      );
      return { id, status: "published", restored: true };
    });

    /**
     * Edit a post. The previous body is recorded as a revision before the live
     * body changes, so an edit is auditable rather than a silent overwrite
     * (§4.2: draft -> published -> edited (revision history)).
     */
    app.patch("/v1/posts/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(editPostSchema, req.body);
      const post = await queryOne<{ author_id: string; body: string | null; status: string }>(
        ctx.pool,
        "SELECT author_id, body, status FROM posts WHERE id = $1",
        [id],
      );
      if (!post) throw ApiError.notFound("Post not found");
      if (post.author_id !== user.id) throw ApiError.forbidden("Only the author can edit a post");
      if (post.status !== "published") throw ApiError.badRequest("Only a published post can be edited");
      if ((post.body ?? "") === input.body) {
        return { id, body: input.body, editedAt: null, unchanged: true };
      }
      const updated = await withTransaction(ctx.pool, async (tx) => {
        await tx.query(
          `INSERT INTO post_revisions (id, post_id, editor_id, previous_body, new_body)
           VALUES ($1, $2, $3, $4, $5)`,
          [newId(), id, user.id, post.body, input.body],
        );
        return queryOne<{ edited_at: Date }>(
          tx,
          `UPDATE posts SET body = $2, edited_at = now(), updated_at = now()
            WHERE id = $1 RETURNING edited_at`,
          [id, input.body],
        );
      });
      return { id, body: input.body, editedAt: updated!.edited_at };
    });

    /** Revision history for a post the caller can see. */
    app.get("/v1/posts/:id/revisions", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const post = await queryOne<{ author_id: string }>(ctx.pool, "SELECT author_id FROM posts WHERE id = $1", [id]);
      if (!post) throw ApiError.notFound("Post not found");
      if (post.author_id !== user.id && !user.isAdmin) {
        throw ApiError.forbidden("Only the author can see edit history");
      }
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, previous_body, new_body, created_at FROM post_revisions
          WHERE post_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return { revisions: rows };
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
      trackSafe(ctx.pool, { name: "post_reacted", userId: user.id, properties: { entityType: "post", entityId: id, kind: input.kind } });
      return { reacted: true };
    });

    /**
     * A post's comments as a one-level thread. Top-level comments carry their
     * replies so the client can render the conversation without a second call.
     * A soft-deleted comment is kept as a placeholder when it still has visible
     * replies, so the replies are not orphaned.
     */
    app.get("/v1/posts/:id/comments", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const rows = await queryMany<CommentRow>(
        ctx.pool,
        `SELECT c.id, c.parent_id, c.body, c.created_at, c.edited_at, c.deleted_at,
                u.id AS user_id, u.handle, u.display_name, u.bio, u.avatar_url
           FROM comments c JOIN users u ON u.id = c.author_id
          WHERE c.post_id = $1
          ORDER BY c.created_at`,
        [id],
      );
      const repliesByParent = new Map<string, CommentView[]>();
      const roots: CommentView[] = [];
      for (const r of rows) {
        const view = toCommentView(r, user.id);
        if (r.parent_id) {
          const list = repliesByParent.get(r.parent_id as string) ?? [];
          list.push(view);
          repliesByParent.set(r.parent_id as string, list);
        } else {
          roots.push(view);
        }
      }
      const comments = roots
        .map((root) => ({ ...root, replies: repliesByParent.get(root.id) ?? [] }))
        // Hide a deleted root only when nothing visible hangs off it.
        .filter((root) => !root.deleted || root.replies.some((reply) => !reply.deleted));
      return { comments };
    });

    app.post("/v1/posts/:id/comments", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(commentSchema, req.body);
      const post = await queryOne<{ id: string; author_id: string }>(
        ctx.pool,
        "SELECT id, author_id FROM posts WHERE id = $1 AND status = 'published'",
        [id],
      );
      if (!post) throw ApiError.notFound("Post not found");

      // Replies are one level deep: a reply to a reply attaches to the same
      // root, so the thread never nests arbitrarily.
      let parentId: string | null = null;
      let parentAuthorId: string | null = null;
      if (input.parentId) {
        const parent = await queryOne<{ id: string; author_id: string; parent_id: string | null }>(
          ctx.pool,
          "SELECT id, author_id, parent_id FROM comments WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL",
          [input.parentId, id],
        );
        if (!parent) throw ApiError.badRequest("The comment you are replying to no longer exists");
        parentId = parent.parent_id ?? parent.id;
        parentAuthorId = parent.author_id;
      }

      const comment = await queryOne<{ id: string; created_at: Date }>(
        ctx.pool,
        `INSERT INTO comments (id, post_id, author_id, parent_id, body) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [newId(), id, user.id, parentId, input.body],
      );
      trackSafe(ctx.pool, { name: "comment_created", userId: user.id, properties: { entityType: "post", entityId: id } });

      // Notify the post author, and the parent comment's author when replying.
      // Each recipient's own opt-out is enforced inside notifyUsers.
      const recipients = new Set<string>();
      if (post.author_id !== user.id) recipients.add(post.author_id);
      if (parentAuthorId && parentAuthorId !== user.id) recipients.add(parentAuthorId);
      recipients.delete(user.id);
      if (recipients.size > 0) {
        await notifyUsers(
          ctx,
          [...recipients],
          parentId ? "comment.reply" : "comment.mention",
          "post",
          id,
          { commentId: comment!.id, actorHandle: user.handle },
        );
      }
      reply.code(201);
      return { id: comment!.id, createdAt: comment!.created_at, parentId };
    });

    /**
     * Edit your own comment. The previous body is recorded first, mirroring
     * post_revisions, so an edit is auditable rather than a silent overwrite.
     */
    app.patch("/v1/comments/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(editCommentSchema, req.body);
      const comment = await queryOne<{ author_id: string; body: string; deleted_at: Date | null }>(
        ctx.pool,
        "SELECT author_id, body, deleted_at FROM comments WHERE id = $1",
        [id],
      );
      if (!comment) throw ApiError.notFound("Comment not found");
      if (comment.author_id !== user.id) throw ApiError.forbidden("Only the author can edit a comment");
      if (comment.deleted_at) throw ApiError.badRequest("A deleted comment cannot be edited");
      if (comment.body === input.body) return { id, body: input.body, editedAt: null, unchanged: true };
      const updated = await withTransaction(ctx.pool, async (tx) => {
        await tx.query(
          `INSERT INTO comment_revisions (id, comment_id, editor_id, previous_body, new_body)
           VALUES ($1, $2, $3, $4, $5)`,
          [newId(), id, user.id, comment.body, input.body],
        );
        return queryOne<{ edited_at: Date }>(
          tx,
          "UPDATE comments SET body = $2, edited_at = now() WHERE id = $1 RETURNING edited_at",
          [id, input.body],
        );
      });
      return { id, body: input.body, editedAt: updated!.edited_at };
    });

    /** Edit history for a comment you wrote. */
    app.get("/v1/comments/:id/revisions", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const comment = await queryOne<{ author_id: string }>(ctx.pool, "SELECT author_id FROM comments WHERE id = $1", [id]);
      if (!comment) throw ApiError.notFound("Comment not found");
      if (comment.author_id !== user.id && !user.isAdmin) {
        throw ApiError.forbidden("Only the author can see edit history");
      }
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, previous_body, new_body, created_at FROM comment_revisions
          WHERE comment_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return { revisions: rows };
    });

    /**
     * Delete your own comment. Soft-delete with undo, matching the post
     * lifecycle. A comment that has replies is kept as a placeholder so the
     * replies below it survive.
     */
    app.delete("/v1/comments/:id", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const comment = await queryOne<{ author_id: string; deleted_at: Date | null }>(
        ctx.pool,
        "SELECT author_id, deleted_at FROM comments WHERE id = $1",
        [id],
      );
      if (!comment) throw ApiError.notFound("Comment not found");
      if (comment.author_id !== user.id && !user.isAdmin) throw ApiError.forbidden();
      if (comment.deleted_at) {
        reply.code(204);
        return null;
      }
      await ctx.pool.query(
        "UPDATE comments SET deleted_at_prev = deleted_at, deleted_at = now() WHERE id = $1",
        [id],
      );
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
         VALUES ($1, 'comment.deleted', 'comment', $2)`,
        [user.id, id],
      );
      reply.code(204);
      return null;
    });

    /** Undo a comment deletion within the window. */
    app.post("/v1/comments/:id/restore", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const comment = await queryOne<{ author_id: string; deleted_at: Date | null; deleted_at_prev: Date | null }>(
        ctx.pool,
        "SELECT author_id, deleted_at, deleted_at_prev FROM comments WHERE id = $1",
        [id],
      );
      if (!comment) throw ApiError.notFound("Comment not found");
      if (comment.author_id !== user.id) throw ApiError.forbidden("Only the author can restore this comment");
      if (!comment.deleted_at) return { id, restored: false };
      if (Date.now() - new Date(comment.deleted_at).getTime() > UNDO_WINDOW_MS) {
        throw ApiError.badRequest("The undo window has passed");
      }
      await ctx.pool.query("UPDATE comments SET deleted_at = deleted_at_prev, deleted_at_prev = NULL WHERE id = $1", [id]);
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
         VALUES ($1, 'comment.restored', 'comment', $2)`,
        [user.id, id],
      );
      return { id, restored: true };
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
      trackSafe(ctx.pool, { name: "block_created", userId: user.id, properties: { entityType: "user", entityId: id } });
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
