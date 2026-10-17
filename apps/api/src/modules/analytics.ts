import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { queryMany } from "../db.js";
import { requireUser, type AppContext } from "../http.js";

/**
 * Privacy-conscious analytics.
 *
 * The spec (§10) defines the event names and is explicit that payloads must not
 * carry message bodies, payment data, or unnecessary personal information. Two
 * rules keep that true here:
 *
 *   1. Only names on the allow-list are accepted. An unknown name is dropped,
 *      so a caller cannot smuggle in an arbitrary event.
 *   2. Only allow-listed scalar properties are stored, and they are truncated.
 *      A caller cannot attach a message body or a card number even by accident.
 *
 * The user id is stored as a pseudonymous reference (the row id), never an
 * email, handle, or display name. Retention is enforced by pruning (below).
 */

/** The event names the spec enumerates. Anything else is rejected. */
export const ANALYTICS_EVENTS = [
  "signup_started",
  "signup_completed",
  "onboarding_completed",
  "feed_viewed",
  "post_created",
  "post_viewed",
  "post_reacted",
  "comment_created",
  "share_created",
  "circle_created",
  "circle_invite_sent",
  "circle_invite_accepted",
  "circle_message_sent",
  "activity_created",
  "activity_joined",
  "vote_submitted",
  "activity_completed",
  "plan_created",
  "rsvp_updated",
  "checkin_completed",
  "expense_created",
  "allocation_viewed",
  "payment_reported",
  "payment_verified",
  "expense_settled",
  "payout_destination_added",
  "payout_requested",
  "merchant_viewed",
  "product_viewed",
  "checkout_started",
  "payment_confirmed",
  "order_completed",
  "order_transition",
  "campaign_created",
  "campaign_approved",
  "ad_impression",
  "ad_click",
  "offer_redeemed",
  "report_submitted",
  "block_created",
  "notification_opened",
  "notification_opted_out",
  "post_deleted",
  "post_restored",
  "comment_deleted",
  "comment_restored",
  "comment_edited",
  // Immersive activities addendum: the viral loop and repeat engagement.
  "activity_link_opened",
  "activity_link_converted",
  "room_joined",
  "room_left",
  "room_message_sent",
  "room_reminder_set",
  "host_post_created",
  "spoiler_revealed",
  "location_enabled",
  "location_cleared",
  // Vibe Yens (stored balance). Gated behind WALLET_ENABLED; the event names
  // are allow-listed here so the ledger surface reports consistently when on.
  "wallet_topup_started",
  "wallet_topup_settled",
  "wallet_sent",
  "wallet_received",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

const EVENT_SET = new Set<string>(ANALYTICS_EVENTS);

/** Scalar properties only, short, and never free text that could hold a secret. */
const ALLOWED_PROPERTY_KEYS = new Set([
  "entityType",
  "entityId",
  "audience",
  "kind",
  "surface",
  "tab",
  "result",
  "reason",
  "count",
]);

const MAX_PROPERTY_LENGTH = 120;

export interface TrackInput {
  name: string;
  userId?: string | null;
  properties?: Record<string, unknown>;
  appVersion?: string | null;
  source?: string | null;
  consent?: boolean;
}

function sanitiseProperties(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_PROPERTY_KEYS.has(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_PROPERTY_LENGTH);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * Record one event. Unknown names and non-allow-listed properties are dropped
 * rather than raising, so instrumentation can never break a user action.
 */
export async function track(pool: pg.Pool, input: TrackInput): Promise<void> {
  if (!EVENT_SET.has(input.name)) return;
  await pool.query(
    `INSERT INTO analytics_events (name, user_id, properties, app_version, source, consent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.name,
      input.userId ?? null,
      JSON.stringify(sanitiseProperties(input.properties)),
      input.appVersion?.slice(0, 40) ?? null,
      input.source?.slice(0, 40) ?? null,
      input.consent ?? true,
    ],
  );
}

/** Fire-and-forget: analytics must never fail a user-facing request. */
export function trackSafe(pool: pg.Pool, input: TrackInput): void {
  void track(pool, input).catch(() => undefined);
}

/** Delete events older than the retention window. Returns rows removed. */
export async function pruneAnalytics(pool: pg.Pool, retentionDays = 90): Promise<number> {
  const result = await pool.query(
    `DELETE FROM analytics_events WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
  return result.rowCount ?? 0;
}

const ingestSchema = z.object({
  events: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        properties: z.record(z.unknown()).optional(),
        source: z.string().max(40).optional(),
      }),
    )
    .max(50),
  appVersion: z.string().max(40).optional(),
});

export function analyticsRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * Client-side events. Names and properties are filtered by the same
     * allow-list as server events, so a tampered client cannot store more than
     * a legitimate one could.
     */
    app.post("/v1/analytics/events", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = ingestSchema.parse(req.body);
      for (const event of input.events) {
        if (!EVENT_SET.has(event.name)) continue;
        await ctx.pool.query(
          `INSERT INTO analytics_events (name, user_id, properties, app_version, source, consent)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [
            event.name,
            user.id,
            JSON.stringify(sanitiseProperties(event.properties)),
            input.appVersion?.slice(0, 40) ?? null,
            event.source?.slice(0, 40) ?? "client",
          ],
        );
      }
      reply.code(202);
      return { accepted: input.events.filter((e) => EVENT_SET.has(e.name)).length };
    });

    /** A user's own recent events, for the data-export workflow. */
    app.get("/v1/analytics/me", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT name, properties, created_at FROM analytics_events
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`,
        [user.id],
      );
      return { events: rows };
    });
  };
}
