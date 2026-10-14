import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";
import { trackSafe } from "./analytics.js";

/**
 * Account lifecycle: notification preferences, data export, and deletion.
 *
 * Spec §3 (profile & settings), §8 (data export/deletion workflows) and §13
 * (deletion/export must behave according to published policy). Deletion uses a
 * cooling-off window so a mis-tap is recoverable, and the workflow is recorded
 * rather than performed destructively and instantly.
 */

/** The notification types the app actually emits. */
export const NOTIFICATION_TYPES = [
  "circle_invite",
  "circle_join",
  "plan_invite",
  "plan_change",
  "poll_closed",
  "expense_update",
  "payment_reported",
  "payment_verified",
  "mention",
  "comment_reply",
  "message",
  "gift",
  "system",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Deletion is not instant: this is the cooling-off window, in hours. */
export const DELETION_COOLING_OFF_HOURS = 24;

const notificationPrefsSchema = z.object({
  types: z.record(z.boolean()).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: z.number().int().min(0).max(23).nullable().optional(),
  quietHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
});

function normalisePrefs(row: Record<string, unknown>) {
  const raw = (row.notification_prefs as Record<string, boolean>) ?? {};
  const types: Record<string, boolean> = {};
  for (const type of NOTIFICATION_TYPES) {
    // Default to on unless the user has explicitly opted out.
    types[type] = raw[type] !== false;
  }
  return {
    types,
    quietHoursEnabled: Boolean(row.quiet_hours_enabled),
    quietHoursStart: (row.quiet_hours_start as number | null) ?? null,
    quietHoursEnd: (row.quiet_hours_end as number | null) ?? null,
  };
}

export function accountRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/me/notification-prefs", async (req) => {
      const user = await requireUser(ctx, req);
      const row = await queryOne<Record<string, unknown>>(
        ctx.pool,
        `SELECT notification_prefs, quiet_hours_enabled, quiet_hours_start, quiet_hours_end
           FROM users WHERE id = $1`,
        [user.id],
      );
      return normalisePrefs(row!);
    });

    app.patch("/v1/me/notification-prefs", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(notificationPrefsSchema, req.body);

      const existing = await queryOne<{ notification_prefs: Record<string, boolean> }>(
        ctx.pool,
        "SELECT notification_prefs FROM users WHERE id = $1",
        [user.id],
      );
      const merged = { ...(existing!.notification_prefs ?? {}) };
      let optedOut = false;
      if (input.types) {
        for (const [type, enabled] of Object.entries(input.types)) {
          if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) continue;
          merged[type] = enabled;
          if (!enabled) optedOut = true;
        }
      }

      const sets: string[] = ["notification_prefs = $2", "updated_at = now()"];
      const values: unknown[] = [user.id, JSON.stringify(merged)];
      if (input.quietHoursEnabled !== undefined) {
        values.push(input.quietHoursEnabled);
        sets.push(`quiet_hours_enabled = $${values.length}`);
      }
      if (input.quietHoursStart !== undefined) {
        values.push(input.quietHoursStart);
        sets.push(`quiet_hours_start = $${values.length}`);
      }
      if (input.quietHoursEnd !== undefined) {
        values.push(input.quietHoursEnd);
        sets.push(`quiet_hours_end = $${values.length}`);
      }

      const row = await queryOne<Record<string, unknown>>(
        ctx.pool,
        `UPDATE users SET ${sets.join(", ")} WHERE id = $1
         RETURNING notification_prefs, quiet_hours_enabled, quiet_hours_start, quiet_hours_end`,
        values,
      );
      if (optedOut) trackSafe(ctx.pool, { name: "notification_opted_out", userId: user.id });
      return normalisePrefs(row!);
    });

    /**
     * Data export. Returns a machine-readable copy of everything the account
     * owns, without other people's private content. Deliberately excludes
     * password hashes, session tokens, and other users' message bodies.
     */
    app.get("/v1/me/export", async (req) => {
      const user = await requireUser(ctx, req);
      const profile = await queryOne<Record<string, unknown>>(
        ctx.pool,
        `SELECT id, email, handle, display_name, bio, avatar_url, interests, city, area,
                discoverable, profile_audience, activity_visibility, read_receipts,
                location_enabled, contacts_sync_enabled, notification_prefs,
                quiet_hours_enabled, quiet_hours_start, quiet_hours_end, created_at
           FROM users WHERE id = $1`,
        [user.id],
      );
      const [posts, comments, reactions, circles, plans, expenses, events] = await Promise.all([
        queryMany(ctx.pool, "SELECT id, body, audience, status, created_at FROM posts WHERE author_id = $1 ORDER BY created_at DESC", [user.id]),
        queryMany(ctx.pool, "SELECT id, post_id, body, created_at FROM comments WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC", [user.id]),
        queryMany(ctx.pool, "SELECT post_id, kind, created_at FROM reactions WHERE user_id = $1 ORDER BY created_at DESC", [user.id]),
        queryMany(
          ctx.pool,
          `SELECT c.id, c.name, c.privacy, cm.role FROM circle_members cm
             JOIN circles c ON c.id = cm.circle_id WHERE cm.user_id = $1`,
          [user.id],
        ),
        queryMany(ctx.pool, "SELECT id, title, state, starts_at, created_at FROM plans WHERE organizer_id = $1 ORDER BY created_at DESC", [user.id]),
        queryMany(ctx.pool, "SELECT id, description, amount_minor, currency, created_at FROM expenses WHERE creator_id = $1 ORDER BY created_at DESC", [user.id]),
        queryMany(ctx.pool, "SELECT name, properties, created_at FROM analytics_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000", [user.id]),
      ]);

      return {
        exportedAt: new Date().toISOString(),
        formatVersion: 1,
        profile: {
          ...publicUser(profile as never),
          email: profile!.email,
          interests: profile!.interests ?? [],
          city: profile!.city ?? null,
          area: profile!.area ?? null,
          createdAt: profile!.created_at,
          privacy: {
            discoverable: profile!.discoverable,
            profileAudience: profile!.profile_audience,
            activityVisibility: profile!.activity_visibility,
            readReceipts: profile!.read_receipts,
            locationEnabled: profile!.location_enabled,
            contactsSyncEnabled: profile!.contacts_sync_enabled,
          },
          notificationPrefs: normalisePrefs(profile!),
        },
        posts,
        comments,
        reactions,
        circles,
        plansOrganised: plans,
        expensesCreated: expenses,
        analyticsEvents: events,
      };
    });

    /** Request deletion. Starts the cooling-off window. */
    app.post("/v1/me/delete", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const existing = await queryOne<{ id: string; execute_after: Date }>(
        ctx.pool,
        "SELECT id, execute_after FROM account_deletion_requests WHERE user_id = $1 AND status = 'pending'",
        [user.id],
      );
      if (existing) {
        return {
          status: "pending",
          requestedAt: existing.execute_after,
          executeAfter: existing.execute_after,
          alreadyPending: true,
        };
      }
      const row = await queryOne<{ id: string; requested_at: Date; execute_after: Date }>(
        ctx.pool,
        `INSERT INTO account_deletion_requests (id, user_id, execute_after)
         VALUES ($1, $2, now() + ($3 || ' hours')::interval)
         RETURNING id, requested_at, execute_after`,
        [newId(), user.id, String(DELETION_COOLING_OFF_HOURS)],
      );
      reply.code(202);
      return {
        status: "pending",
        requestedAt: row!.requested_at,
        executeAfter: row!.execute_after,
        coolingOffHours: DELETION_COOLING_OFF_HOURS,
      };
    });

    /** Cancel a pending deletion during the cooling-off window. */
    app.post("/v1/me/delete/cancel", async (req) => {
      const user = await requireUser(ctx, req);
      const result = await ctx.pool.query(
        `UPDATE account_deletion_requests SET status = 'cancelled'
          WHERE user_id = $1 AND status = 'pending'`,
        [user.id],
      );
      if ((result.rowCount ?? 0) === 0) throw ApiError.notFound("No pending deletion request");
      return { status: "cancelled" };
    });

    app.get("/v1/me/delete", async (req) => {
      const user = await requireUser(ctx, req);
      const row = await queryOne<{ status: string; requested_at: Date; execute_after: Date }>(
        ctx.pool,
        `SELECT status, requested_at, execute_after FROM account_deletion_requests
          WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1`,
        [user.id],
      );
      if (!row) return { status: "none" };
      return {
        status: row.status,
        requestedAt: row.requested_at,
        executeAfter: row.execute_after,
        coolingOffHours: DELETION_COOLING_OFF_HOURS,
      };
    });

    /**
     * Execute a deletion whose cooling-off window has elapsed. Soft-deletes the
     * account: the row is retained for referential integrity but is no longer
     * discoverable, can no longer log in, and its public content is removed.
     */
    app.post("/v1/me/delete/execute", async (req) => {
      const user = await requireUser(ctx, req);
      const request = await queryOne<{ id: string; execute_after: Date }>(
        ctx.pool,
        `SELECT id, execute_after FROM account_deletion_requests
          WHERE user_id = $1 AND status = 'pending'`,
        [user.id],
      );
      if (!request) throw ApiError.notFound("No pending deletion request");
      if (request.execute_after.getTime() > Date.now()) {
        throw ApiError.badRequest("The cooling-off window has not elapsed yet");
      }
      await withTransaction(ctx.pool, async (tx) => {
        await tx.query(
          `UPDATE users SET deleted_at = now(),
                            discoverable = false,
                            profile_audience = 'private',
                            bio = NULL,
                            avatar_url = NULL
            WHERE id = $1`,
          [user.id],
        );
        await tx.query("UPDATE posts SET status = 'removed', updated_at = now() WHERE author_id = $1", [user.id]);
        await tx.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
        await tx.query(
          "UPDATE account_deletion_requests SET status = 'completed', completed_at = now() WHERE id = $1",
          [request.id],
        );
      });
      return { status: "completed" };
    });
  };
}
