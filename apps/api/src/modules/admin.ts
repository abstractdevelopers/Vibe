import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { parse, publicUser, requireAdmin, requireUser, type AppContext } from "../http.js";

/**
 * Operator console (§9). Admin surfaces are required by the spec, not optional.
 *
 * Every mutating action here writes an audit event, and the account actions
 * actually take effect: `requireUser` refuses a suspended or banned account, so
 * a status change is not merely a label. Admin access to private content is
 * deliberately not offered — the console exposes reports and metadata, never
 * message bodies, so staff cannot read private messages through it.
 */

const accountActionSchema = z.object({
  action: z.enum(["warn", "restrict", "suspend", "ban", "restore"]),
  reason: z.string().min(1).max(1000),
  // Only meaningful for a time-boxed suspension.
  days: z.number().int().positive().max(3650).optional(),
});

const STATUS_FOR_ACTION: Record<string, string> = {
  warn: "warned",
  restrict: "restricted",
  suspend: "suspended",
  ban: "banned",
  restore: "active",
};

export function adminRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    /** Look up a user by handle or email. Audited, because it is staff access. */
    app.get("/v1/admin/users", async (req) => {
      const actor = await requireUser(ctx, req);
      requireAdmin(actor);
      const q = (req.query as { q?: string }).q?.trim();
      if (!q) throw ApiError.badRequest("A search term is required");
      const rows = await queryMany<{
        id: string; handle: string; display_name: string; email: string; avatar_url: string | null;
        moderation_status: string; created_at: Date;
      }>(
        ctx.pool,
        `SELECT id, handle, display_name, email, avatar_url, moderation_status, created_at
           FROM users
          WHERE deleted_at IS NULL AND (handle ILIKE $1 OR email ILIKE $1)
          ORDER BY created_at DESC LIMIT 25`,
        [`%${q}%`],
      );
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'admin.user_lookup', 'user', $2, $3)`,
        [actor.id, actor.id, JSON.stringify({ query: q })],
      );
      return {
        users: rows.map((u) => ({
          id: u.id,
          handle: u.handle,
          displayName: u.display_name,
          email: u.email,
          avatarUrl: u.avatar_url,
          moderationStatus: u.moderation_status,
          createdAt: u.created_at,
        })),
      };
    });

    /** Apply an account action. Enforced, not cosmetic. */
    app.post("/v1/admin/users/:id/action", async (req) => {
      const actor = await requireUser(ctx, req);
      requireAdmin(actor);
      const { id } = req.params as { id: string };
      const input = parse(accountActionSchema, req.body);
      const target = await queryOne<{ id: string }>(ctx.pool, "SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [id]);
      if (!target) throw ApiError.notFound("User not found");
      if (id === actor.id && input.action !== "restore") {
        throw ApiError.badRequest("You cannot action your own account");
      }
      const status = STATUS_FOR_ACTION[input.action]!;
      const until = input.action === "suspend" && input.days
        ? new Date(Date.now() + input.days * 86_400_000)
        : null;
      await withTransaction(ctx.pool, async (tx) => {
        await tx.query(
          `UPDATE users SET moderation_status = $2, moderation_until = $3, moderation_reason = $4, updated_at = now()
            WHERE id = $1`,
          [id, status, until, input.reason],
        );
        await tx.query(
          `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
           VALUES ($1, $2, 'user', $3, $4)`,
          [actor.id, `account.${input.action}`, id, JSON.stringify({ reason: input.reason, until })],
        );
        // A ban is terminal, so end live sessions too. A suspension is
        // reversible and is already enforced on every request by requireUser,
        // so the account works again the moment it is restored.
        if (status === "banned") {
          await tx.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
        }
      });
      return { id, moderationStatus: status, until };
    });

    /** Merchant queue: businesses awaiting verification. */
    app.get("/v1/admin/merchants", async (req) => {
      const actor = await requireUser(ctx, req);
      requireAdmin(actor);
      const status = (req.query as { status?: string }).status ?? "unverified";
      const rows = await queryMany(
        ctx.pool,
        `SELECT m.id, m.name, m.category, m.description, m.verification_status, m.created_at,
                u.handle AS owner_handle, u.display_name AS owner_name
           FROM merchants m JOIN users u ON u.id = m.owner_id
          WHERE m.verification_status = $1
          ORDER BY m.created_at ASC LIMIT 100`,
        [status],
      );
      return {
        merchants: rows.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          description: m.description,
          verificationStatus: m.verification_status,
          createdAt: m.created_at,
          ownerHandle: m.owner_handle,
          ownerName: m.owner_name,
        })),
      };
    });

    /**
     * An operator's view of one report, with the target resolved to a short
     * summary. Message bodies are never included; a reported comment shows only
     * its id and author so staff must use the policy-governed path for content.
     */
    app.get("/v1/admin/reports/:id", async (req) => {
      const actor = await requireUser(ctx, req);
      requireAdmin(actor);
      const { id } = req.params as { id: string };
      const r = await queryOne<{
        id: string; target_type: string; target_id: string; reason: string; details: string | null;
        status: string; created_at: Date; reporter_id: string; reporter_handle: string;
      }>(
        ctx.pool,
        `SELECT r.*, u.handle AS reporter_handle
           FROM reports r JOIN users u ON u.id = r.reporter_id
          WHERE r.id = $1`,
        [id],
      );
      if (!r) throw ApiError.notFound("Report not found");
      const actions = await queryMany(
        ctx.pool,
        `SELECT id, actor_id, action, reason, created_at FROM moderation_actions
          WHERE report_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return {
        report: {
          id: r.id,
          targetType: r.target_type,
          targetId: r.target_id,
          reason: r.reason,
          details: r.details,
          status: r.status,
          createdAt: r.created_at,
          reporter: { id: r.reporter_id, handle: r.reporter_handle },
        },
        actions,
      };
    });

    /** Abuse/rate-limit dashboard: recent report volume by target type. */
    app.get("/v1/admin/overview", async (req) => {
      const actor = await requireUser(ctx, req);
      requireAdmin(actor);
      const openReports = await queryOne<{ n: number }>(
        ctx.pool,
        "SELECT count(*) AS n FROM reports WHERE status IN ('open', 'triaged')",
      );
      const pendingMerchants = await queryOne<{ n: number }>(
        ctx.pool,
        "SELECT count(*) AS n FROM merchants WHERE verification_status = 'unverified'",
      );
      const pendingCampaigns = await queryOne<{ n: number }>(
        ctx.pool,
        "SELECT count(*) AS n FROM campaigns WHERE status IN ('submitted', 'under_review')",
      );
      const byType = await queryMany<{ target_type: string; n: number }>(
        ctx.pool,
        `SELECT target_type, count(*) AS n FROM reports
          WHERE created_at > now() - interval '7 days'
          GROUP BY target_type ORDER BY n DESC`,
      );
      const actions7d = await queryOne<{ n: number }>(
        ctx.pool,
        "SELECT count(*) AS n FROM moderation_actions WHERE created_at > now() - interval '7 days'",
      );
      return {
        openReports: openReports?.n ?? 0,
        pendingMerchants: pendingMerchants?.n ?? 0,
        pendingCampaigns: pendingCampaigns?.n ?? 0,
        actions7d: actions7d?.n ?? 0,
        reportsByType: byType,
      };
    });
  };
}

export { publicUser };
