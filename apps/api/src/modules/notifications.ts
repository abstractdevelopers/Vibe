import type { FastifyInstance } from "fastify";
import { queryMany, queryOne } from "../db.js";
import { newId } from "../ids.js";
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

/**
 * Emitted notification types use a dotted namespace ("plan.created"), while the
 * user's preference keys are coarse families ("plan_invite", "plan_change").
 * This table is the single source of truth for that mapping, so an opt-out is
 * enforced against the family the user actually sees in Settings.
 */
const NOTIFICATION_FAMILY: Record<string, string> = {
  "plan.created": "plan_invite",
  "plan.rsvp_updated": "plan_change",
  "plan.changed": "plan_change",
  "plan.cancelled": "plan_change",
  "poll.closed": "poll_closed",
  "expense.updated": "expense_update",
  "payment.reported": "payment_reported",
  "payment.verified": "payment_verified",
  "message.created": "message",
  "gift.received": "gift",
  "comment.reply": "comment_reply",
  "comment.mention": "mention",
  "follow.new": "follow",
  "post.reaction": "reaction",
  "wallet.received": "wallet",
  "game.joined": "game",
};

/**
 * Insert one notification per recipient, honouring each user's per-type opt-out.
 * Types use a dotted namespace (e.g. "plan.created"); the preference key is the
 * first segment's family, matched against the NOTIFICATION_TYPES allow-list in
 * modules/account.ts. A recipient who has switched a family off simply gets no
 * row, so quiet-by-choice is enforced server-side, not just in the UI.
 *
 * After the rows are written, each recipient who actually got one is told over
 * realtime, so their unread badge moves while they are looking at the app
 * instead of waiting for the next page load. Carry only the type and entity ids:
 * the row itself (with its payload) is fetched from GET /v1/notifications.
 */
export async function notifyUsers(
  ctx: AppContext,
  userIds: string[],
  type: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (userIds.length === 0) return;
  const family = NOTIFICATION_FAMILY[type] ?? type.split(".")[0] ?? type;
  const rows = await queryMany<{ id: string; notification_prefs: Record<string, boolean> | null }>(
    ctx.pool,
    "SELECT id, notification_prefs FROM users WHERE id = ANY($1::uuid[])",
    [userIds],
  );
  const notified: string[] = [];
  for (const row of rows) {
    const prefs = row.notification_prefs ?? {};
    // Opt-out only: absent means on. Accept either the family or the full type.
    if (prefs[family] === false || prefs[type] === false) continue;
    await ctx.pool.query(
      `INSERT INTO notifications (id, user_id, type, entity_type, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), row.id, type, entityType, entityId, JSON.stringify(payload)],
    );
    notified.push(row.id);
  }
  if (notified.length > 0) {
    ctx.hub.publishToUsers(notified, {
      type: "notification.created",
      entityId,
      payload: { type, entityType, entityId },
    });
  }
}
