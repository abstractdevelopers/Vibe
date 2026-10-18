import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne } from "../db.js";
import { parse, publicUser, requireUser, type AppContext, type UserLike } from "../http.js";

const followSchema = z.object({ followeeId: z.string().uuid() });

export function socialRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/follows", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(followSchema, req.body);
      if (input.followeeId === user.id) throw ApiError.badRequest("You cannot follow yourself");
      const target = await queryOne<{ id: string; profile_audience: string }>(
        ctx.pool,
        "SELECT id, profile_audience FROM users WHERE id = $1 AND deleted_at IS NULL",
        [input.followeeId],
      );
      if (!target) throw ApiError.notFound("User not found");
      const blocked = await queryOne(
        ctx.pool,
        `SELECT 1 FROM blocks
          WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [user.id, input.followeeId],
      );
      if (blocked) throw ApiError.forbidden("You cannot follow this account");
      // Private profiles require approval before the follow becomes accepted.
      const state = target.profile_audience === "private" ? "pending" : "accepted";
      await ctx.pool.query(
        `INSERT INTO follows (follower_id, followee_id, state) VALUES ($1, $2, $3)
         ON CONFLICT (follower_id, followee_id) DO UPDATE SET state = EXCLUDED.state`,
        [user.id, input.followeeId, state],
      );
      reply.code(201);
      return { state };
    });

    app.delete("/v1/follows/:followeeId", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { followeeId } = req.params as { followeeId: string };
      await ctx.pool.query("DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2", [
        user.id,
        followeeId,
      ]);
      reply.code(204);
      return null;
    });

    app.get("/v1/users/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const row = await queryOne<{
        id: string;
        handle: string;
        display_name: string;
        bio: string | null;
        avatar_url: string | null;
        interests: string[];
        discoverable: boolean;
        profile_audience: string;
      }>(
        ctx.pool,
        `SELECT id, handle, display_name, bio, avatar_url, interests, discoverable, profile_audience
           FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (!row) throw ApiError.notFound("User not found");
      if (!row.discoverable && row.id !== user.id) throw ApiError.notFound("User not found");
      const followerCount = await queryOne<{ count: number }>(
        ctx.pool,
        "SELECT count(*) AS count FROM follows WHERE followee_id = $1 AND state = 'accepted'",
        [id],
      );
      // The viewer's own relationship to this profile, so the buttons can show
      // the true state (Followed / Blocked) instead of always offering the
      // action again.
      const viewerFollows = await queryOne<{ state: string }>(
        ctx.pool,
        "SELECT state FROM follows WHERE follower_id = $1 AND followee_id = $2",
        [user.id, id],
      );
      const viewerHasBlocked = await queryOne(
        ctx.pool,
        "SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2",
        [user.id, id],
      );
      return {
        ...publicUser(row),
        interests: row.interests,
        profileAudience: row.profile_audience,
        followerCount: followerCount?.count ?? 0,
        viewerFollows: Boolean(viewerFollows && viewerFollows.state === "accepted"),
        viewerRequested: Boolean(viewerFollows && viewerFollows.state === "pending"),
        viewerHasBlocked: Boolean(viewerHasBlocked),
      };
    });

    app.get("/v1/search/users", async (req) => {
      const user = await requireUser(ctx, req);
      const q = String((req.query as { q?: string }).q ?? "").trim();
      if (q.length < 2) return { users: [] };
      const rows = await queryMany<UserLike>(
        ctx.pool,
        `SELECT id, handle, display_name, bio, avatar_url
           FROM users
          WHERE deleted_at IS NULL AND discoverable
            AND (handle ILIKE $1 OR display_name ILIKE $1)
          ORDER BY handle LIMIT 20`,
        [`%${q}%`],
      );
      return { users: rows.map(publicUser) };
    });

    // People worth following, for the feed's discovery rail. This is deliberately
    // people the viewer does NOT already follow — a "people to follow" rail that
    // shows people you follow is noise. Ranked by real signal only: how many
    // people follow them, and whether they share an interest with the viewer.
    // Someone who is private, blocked, muted or already followed is excluded.
    app.get("/v1/discover/creators", async (req) => {
      const user = await requireUser(ctx, req);
      const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 12) || 12, 30);
      const rows = await queryMany<UserLike & { follower_count: string }>(
        ctx.pool,
        `SELECT u.id, u.handle, u.display_name, u.bio, u.avatar_url,
                (SELECT count(*) FROM follows f2
                  WHERE f2.followee_id = u.id AND f2.state = 'accepted') AS follower_count
           FROM users u
           LEFT JOIN follows f
             ON f.followee_id = u.id AND f.follower_id = $1
          WHERE u.id <> $1
            AND u.deleted_at IS NULL
            AND u.discoverable
            AND u.profile_audience <> 'private'
            AND f.follower_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM blocks b
                             WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                                OR (b.blocker_id = u.id AND b.blocked_id = $1))
            AND NOT EXISTS (SELECT 1 FROM mutes m WHERE m.muter_id = $1 AND m.muted_id = u.id)
          ORDER BY
            -- Shared interests first, then reach. Both are real signals; neither
            -- is a paid placement.
            (CASE WHEN EXISTS (SELECT 1 FROM users me
                                WHERE me.id = $1
                                  AND me.interests && u.interests
                                  AND array_length(u.interests, 1) > 0)
                  THEN 0 ELSE 1 END),
            follower_count DESC,
            u.created_at DESC
          LIMIT $2`,
        [user.id, limit],
      );
      return { users: rows.map((r) => ({ ...publicUser(r), followerCount: Number(r.follower_count) })) };
    });
  };
}
