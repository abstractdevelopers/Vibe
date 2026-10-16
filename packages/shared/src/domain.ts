/**
 * Shared domain vocabulary. These string unions mirror the spec's state
 * machines and are used by both the API and the client so a state name can
 * never drift between the two.
 */

export const CIRCLE_ROLES = ["owner", "admin", "moderator", "member"] as const;
export type CircleRole = (typeof CIRCLE_ROLES)[number];

export const CIRCLE_PRIVACY = ["private", "invite_only", "public_discoverable"] as const;
export type CirclePrivacy = (typeof CIRCLE_PRIVACY)[number];

export const POST_AUDIENCES = ["public", "connections", "circle", "private"] as const;
export type PostAudience = (typeof POST_AUDIENCES)[number];

export const ACTIVITY_STATES = [
  "draft",
  "scheduled",
  "open",
  "closed",
  "results_published",
  "cancelled",
  "under_review",
] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

export const PLAN_STATES = [
  "draft",
  "proposed",
  "confirming",
  "confirmed",
  "completed",
  "cancelled",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const RSVP_STATES = ["interested", "going", "waitlisted", "declined", "checked_in"] as const;
export type RsvpState = (typeof RSVP_STATES)[number];

/** Per-allocation expense status. "reported" and "verified" are distinct. */
export const ALLOCATION_STATUSES = [
  "proposed",
  "accepted",
  "due",
  "payment_reported",
  "payment_verified",
  "disputed",
  "settled",
  "waived",
  "cancelled",
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const SPLIT_MODES = ["equal", "custom", "percentage", "itemized"] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

/** Order lifecycle from the spec. Only provider-confirmed states are shown. */
export const ORDER_STATES = [
  "created",
  "awaiting_payment",
  "payment_processing",
  "paid",
  "seller_confirmed",
  "fulfilling",
  "completed",
  "cancelled",
  "failed",
  "refund_pending",
  "refunded",
  "disputed",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const CAMPAIGN_STATES = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "scheduled",
  "active",
  "paused",
  "completed",
  "rejected",
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const REPORT_STATUSES = [
  "open",
  "triaged",
  "actioned",
  "dismissed",
  "appealed",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const MODERATION_ACTIONS = [
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
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** Actionable feed item types. A card only shows actions valid for its type. */
export const POST_TYPES = [
  "text",
  "image",
  "video",
  "carousel",
  "poll",
  "debate",
  "quiz",
  "challenge",
  "plan",
  "product",
  "announcement",
  "memory",
] as const;
export type PostType = (typeof POST_TYPES)[number];

/** Event lifecycle (§4.5 / Phase 4). */
export const EVENT_STATES = ["draft", "published", "cancelled", "completed"] as const;
export type EventState = (typeof EVENT_STATES)[number];

/**
 * Vibe Pass status (§4.9). The pass is a revocable pointer to a server-side
 * identifier; the tag/QR itself carries no personal or payment data.
 */
export const PASS_STATES = ["active", "revoked", "expired"] as const;
export type PassState = (typeof PASS_STATES)[number];

export const LOYALTY_REDEMPTION_STATES = ["pending", "redeemed", "rejected", "expired"] as const;
export type LoyaltyRedemptionState = (typeof LOYALTY_REDEMPTION_STATES)[number];

/** Ad surface a campaign can be delivered to. */
export const AD_SURFACES = ["feed", "explore"] as const;
export type AdSurface = (typeof AD_SURFACES)[number];

/** Device platforms for push registration. */
export const DEVICE_PLATFORMS = ["ios", "android", "web"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
