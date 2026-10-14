import type { FastifyInstance } from "fastify";
import { queryMany, queryOne } from "../db.js";
import { requireUser, type AppContext } from "../http.js";

export function notificationsRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/notifications", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, type, entity_type, entity_id, payload, read_at, created_at
           FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [user.id],
      );
      return { notifications: rows };
    });

    app.post("/v1/notifications/read", async (req, reply) => {
      const user = await requireUser(ctx, req);
      await ctx.pool.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [
        user.id,
      ]);
      reply.code(204);
      return null;
    });

    app.post("/v1/notifications/:id/read", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await ctx.pool.query(
        "UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2",
        [id, user.id],
      );
      return { ok: true };
    });

    app.get("/v1/notifications/unread-count", async (req) => {
      const user = await requireUser(ctx, req);
      const row = await queryOne<{ count: number }>(
        ctx.pool,
        "SELECT count(*) AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        [user.id],
      );
      return { unread: row?.count ?? 0 };
    });
  };
}
