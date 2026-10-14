import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireAdmin, requireUser, type AppContext } from "../http.js";
import { trackSafe } from "./analytics.js";
const reportSchema = z.object({
  targetType: z.enum(["user", "post", "comment", "activity", "circle", "ad"]),
  targetId: z.string().uuid(),
  reason: z.string().min(1).max(120),
  details: z.string().max(2000).optional(),
});

const actionSchema = z.object({
  action: z.enum([
    "none",
    "label",
    "limit_reach",
    "remove",
    "age_restrict",
    "warn",
    "restrict",
    "suspend",
    "ban",
    "restore",
  ]),
  reason: z.string().max(1000).optional(),
});

const resolveSchema = z.object({ resolution: z.string().min(1).max(1000) });

export function moderationRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/reports", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(reportSchema, req.body);
      const report = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [newId(), user.id, input.targetType, input.targetId, input.reason, input.details ?? null],
      );
      trackSafe(ctx.pool, { name: "report_submitted", userId: user.id, properties: { entityType: input.targetType, entityId: input.targetId, reason: input.reason } });
      reply.code(201);
      return { id: report!.id, status: "open" };
    });

    // --- Admin surfaces. Every action is role-checked and audited. ---

    app.get("/v1/admin/reports", async (req) => {
      const user = await requireUser(ctx, req);
      requireAdmin(user);
      const status = (req.query as { status?: string }).status ?? "open";
      const reports = await queryMany(
        ctx.pool,
        `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at,
                u.handle AS reporter_handle
           FROM reports r JOIN users u ON u.id = r.reporter_id
          WHERE r.status = $1 ORDER BY r.created_at LIMIT 100`,
        [status],
      );
      return { reports };
    });

    app.post("/v1/admin/reports/:id/action", async (req) => {
      const user = await requireUser(ctx, req);
      requireAdmin(user);
      const { id } = req.params as { id: string };
      const input = parse(actionSchema, req.body);
      const result = await withTransaction(ctx.pool, async (tx) => {
        const report = await queryOne<{ target_type: string; target_id: string; status: string }>(
          tx,
          "SELECT target_type, target_id, status FROM reports WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!report) throw ApiError.notFound("Report not found");

        const caseRow = await queryOne<{ id: string }>(
          tx,
          `INSERT INTO moderation_cases (id, report_id, assignee_id, status, resolution)
           VALUES ($1, $2, $3, 'resolved', $4) RETURNING id`,
          [newId(), id, user.id, `Action: ${input.action}`],
        );
        await tx.query(
          `INSERT INTO moderation_actions (id, case_id, actor_id, action, target_type, target_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newId(), caseRow!.id, user.id, input.action, report.target_type, report.target_id, input.reason ?? null],
        );

        // Content actions are applied to the underlying post where relevant.
        if (report.target_type === "post") {
          const postStatus =
            input.action === "remove" ? "removed" : input.action === "limit_reach" ? "limited" : input.action === "restore" ? "published" : null;
          if (postStatus) {
            await tx.query("UPDATE posts SET status = $1, updated_at = now() WHERE id = $2", [
              postStatus,
              report.target_id,
            ]);
          }
        }
        if (report.target_type === "activity") {
          const activityState = input.action === "remove" ? "under_review" : input.action === "restore" ? "open" : null;
          if (activityState) {
            await tx.query("UPDATE activities SET state = $1, updated_at = now() WHERE id = $2", [
              activityState,
              report.target_id,
            ]);
          }
        }

        await tx.query("UPDATE reports SET status = 'actioned', updated_at = now() WHERE id = $1", [id]);
        await tx.query(
          `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
           VALUES ($1, 'moderation.action', $2, $3, $4)`,
          [user.id, report.target_type, report.target_id, JSON.stringify({ action: input.action, reportId: id })],
        );
        return { caseId: caseRow!.id };
      });
      return { ok: true, ...result };
    });

    app.post("/v1/admin/reports/:id/dismiss", async (req) => {
      const user = await requireUser(ctx, req);
      requireAdmin(user);
      const { id } = req.params as { id: string };
      const input = parse(resolveSchema, req.body);
      const report = await queryOne<{ id: string }>(ctx.pool, "SELECT id FROM reports WHERE id = $1", [id]);
      if (!report) throw ApiError.notFound("Report not found");
      await withTransaction(ctx.pool, async (tx) => {
        await tx.query("UPDATE reports SET status = 'dismissed', updated_at = now() WHERE id = $1", [id]);
        await tx.query(
          `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
           VALUES ($1, 'moderation.dismiss', 'report', $2, $3)`,
          [user.id, id, JSON.stringify({ resolution: input.resolution })],
        );
      });
      return { ok: true };
    });

    app.get("/v1/admin/audit", async (req) => {
      const user = await requireUser(ctx, req);
      requireAdmin(user);
      const events = await queryMany(
        ctx.pool,
        `SELECT id, actor_id, action, entity_type, entity_id, metadata, created_at
           FROM audit_events ORDER BY created_at DESC LIMIT 200`,
      );
      return { events };
    });
  };
}
