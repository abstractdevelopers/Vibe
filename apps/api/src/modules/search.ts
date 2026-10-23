import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { queryMany } from "../db.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";
import { VISIBILITY } from "./feed.js";

/**
 * Post search (§6, "PostgreSQL full-text initially").
 *
 * Authorization is applied in the query, never after the fact: a searcher only
 * sees public posts, their own posts, and posts in Circles they belong to. A
 * removed or limited post is excluded. This mirrors the feed's visibility rule
 * so search cannot become a side channel into private content.
 */

const searchSchema = z.object({
  q: z.string().min(1).max(120),
  limit: z.coerce.number().int().positive().max(50).default(20),
  cursor: z.string().optional(),
});

export function searchRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/search/posts", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(searchSchema, req.query);

      const rows = await queryMany<{
        id: string; body: string | null; type: string; audience: string; circle_id: string | null;
        created_at: Date; author_id: string; handle: string; display_name: string; avatar_url: string | null;
        rank: number;
      }>(
        ctx.pool,
        `SELECT p.id, p.body, p.type, p.audience, p.circle_id, p.created_at,
                u.id AS author_id, u.handle, u.display_name, u.avatar_url,
                ts_rank(p.search_vector, websearch_to_tsquery('english', $2)) AS rank
           FROM posts p JOIN users u ON u.id = p.author_id
          WHERE p.search_vector @@ websearch_to_tsquery('english', $2)
            AND p.status = 'published'
            -- The feed's one visibility clause: audience, blocks and mutes.
            -- $1 is the viewer, which is what VISIBILITY expects.
            ${VISIBILITY}
          ORDER BY rank DESC, p.created_at DESC
          LIMIT $3`,
        [user.id, input.q, input.limit],
      );

      return {
        items: rows.map((p) => ({
          id: p.id,
          body: p.body,
          type: p.type,
          audience: p.audience,
          circleId: p.circle_id,
          createdAt: p.created_at,
          author: publicUser({ id: p.author_id, handle: p.handle, display_name: p.display_name, avatar_url: p.avatar_url }),
        })),
      };
    });
  };
}
