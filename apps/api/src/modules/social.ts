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
      return {
        ...publicUser(row),
        interests: row.interests,
        profileAudience: row.profile_audience,
        followerCount: followerCount?.count ?? 0,
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
  };
}
