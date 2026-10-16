import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireAdmin, requireUser, type AppContext } from "../http.js";
import { trackSafe } from "./analytics.js";

/**
 * Advertising manager (§4.8). A campaign is created as a draft, submitted for
 * review, then approved or rejected by an operator. Only approved campaigns can
 * run. Regulated categories are refused outright: they need explicit policy and
 * legal review, which this build does not have.
 */

const REGULATED_CATEGORIES = ["financial", "health", "alcohol", "gambling", "political", "crypto", "tobacco"];

const campaignSchema = z.object({
  name: z.string().min(1).max(160),
  objective: z.string().min(1).max(80),
  creative: z.string().min(1).max(2000),
  creativeTitle: z.string().max(120).optional(),
  creativeBody: z.string().max(400).optional(),
  creativeCta: z.string().max(40).optional(),
  // A banner image: the same contract as a profile avatar, so it reuses the
  // media upload path rather than trusting a new one.
  creativeImageUrl: z
    .string()
    .max(1000)
    .regex(/^(https?:\/\/|\/v1\/media\/[A-Za-z0-9._-]+)/, "Must be an image URL or an uploaded media path")
    .nullable()
    .optional(),
  destinationUrl: z.string().url().max(1000),
  // Delivery only happens for a verified business, so a campaign must name the
  // merchant it lands on.
  merchantId: z.string().uuid(),
  audience: z.record(z.unknown()).default({}),
  geography: z.string().max(80).optional(),
  budgetMinor: z.number().int().min(0),
  currency: z.string().length(3),
  scheduleStart: z.string().datetime().optional(),
  scheduleEnd: z.string().datetime().optional(),
  frequencyCap: z.number().int().positive().max(20).default(3),
  category: z.string().max(40).default("general"),
});

const reviewSchema = z.object({
  decision: z.enum(["approved", "rejected", "under_review"]),
  reason: z.string().max(500).optional(),
});

export function advertisingRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/campaigns", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(campaignSchema, req.body);
      // Restricted categories are disabled by default until reviewed.
      if (REGULATED_CATEGORIES.includes(input.category)) {
        throw ApiError.badRequest(
          `The "${input.category}" category is not supported; it requires policy and legal review before it can be advertised.`,
        );
      }
      // The advertiser must own the business the campaign lands on, and the
      // business must at least exist. Delivery additionally requires it to be
      // verified, so an unverified merchant can prepare a campaign but not run.
      const merchant = await queryOne<{ owner_id: string }>(
        ctx.pool,
        "SELECT owner_id FROM merchants WHERE id = $1",
        [input.merchantId],
      );
      if (!merchant) throw ApiError.badRequest("Unknown merchant");
      if (merchant.owner_id !== user.id) {
        throw ApiError.forbidden("You can only advertise for a business you own");
      }
      const created = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO campaigns (id, advertiser_id, merchant_id, landing_merchant_id, name, objective, creative,
                                creative_title, creative_body, creative_cta, creative_image_url,
                                destination_url, audience,
                                geography, budget_minor, currency, schedule_start, schedule_end, frequency_cap, category)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [
          newId(), user.id, input.merchantId, input.name, input.objective, input.creative,
          input.creativeTitle ?? null, input.creativeBody ?? null, input.creativeCta ?? null,
          input.creativeImageUrl ?? null,
          input.destinationUrl, JSON.stringify(input.audience), input.geography ?? null,
          input.budgetMinor, input.currency.toUpperCase(),
          input.scheduleStart ?? null, input.scheduleEnd ?? null, input.frequencyCap, input.category,
        ],
      );
      trackSafe(ctx.pool, { name: "campaign_created", userId: user.id, properties: { entityType: "campaign", entityId: created!.id } });
      reply.code(201);
      return { id: created!.id, status: "draft" };
    });

    app.post("/v1/campaigns/:id/submit", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const c = await queryOne<{ advertiser_id: string; status: string }>(
        ctx.pool,
        "SELECT advertiser_id, status FROM campaigns WHERE id = $1",
        [id],
      );
      if (!c) throw ApiError.notFound("Campaign not found");
      if (c.advertiser_id !== user.id) throw ApiError.forbidden("Only the advertiser can submit this campaign");
      if (c.status !== "draft") throw ApiError.badRequest(`A campaign in "${c.status}" cannot be submitted`);
      await ctx.pool.query("UPDATE campaigns SET status = 'submitted', updated_at = now() WHERE id = $1", [id]);
      return { id, status: "submitted" };
    });

    /** Operator review. Only an approved campaign is eligible to run. */
    app.post("/v1/admin/campaigns/:id/review", async (req) => {
      const user = await requireUser(ctx, req);
      requireAdmin(user);
      const { id } = req.params as { id: string };
      const input = parse(reviewSchema, req.body);
      const c = await queryOne<{ id: string }>(ctx.pool, "SELECT id FROM campaigns WHERE id = $1", [id]);
      if (!c) throw ApiError.notFound("Campaign not found");
      const next = input.decision === "approved" ? "approved" : input.decision === "rejected" ? "rejected" : "under_review";
      await withTransaction(ctx.pool, async (tx) => {
        await tx.query("UPDATE campaigns SET status = $2, moderation_reason = $3, updated_at = now() WHERE id = $1", [
          id, next, input.reason ?? null,
        ]);
        await tx.query(
          `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
           VALUES ($1, 'campaign.reviewed', 'campaign', $2, $3)`,
          [user.id, id, JSON.stringify({ decision: next, reason: input.reason ?? null })],
        );
      });
      if (next === "approved") {
        trackSafe(ctx.pool, { name: "campaign_approved", userId: user.id, properties: { entityType: "campaign", entityId: id } });
      }
      return { id, status: next };
    });

    /** An operator's queue: campaigns awaiting review, oldest first. */
    app.get("/v1/admin/campaigns", async (req) => {
      const user = await requireUser(ctx, req);
      requireAdmin(user);
      const rows = await queryMany(
        ctx.pool,
        `SELECT c.id, c.name, c.status, c.objective, c.category, c.creative_title,
                c.budget_minor, c.currency, c.moderation_reason, c.created_at,
                u.handle AS advertiser_handle, u.display_name AS advertiser_name,
                m.name AS merchant_name, m.verification_status AS merchant_verification
           FROM campaigns c
           JOIN users u ON u.id = c.advertiser_id
           LEFT JOIN merchants m ON m.id = c.landing_merchant_id
          WHERE c.status IN ('submitted', 'under_review')
          ORDER BY c.created_at ASC`,
      );
      return {
        campaigns: rows.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          objective: c.objective,
          category: c.category,
          creativeTitle: c.creative_title,
          budgetMinor: c.budget_minor,
          currency: c.currency,
          moderationReason: c.moderation_reason,
          createdAt: c.created_at,
          advertiserHandle: c.advertiser_handle,
          advertiserName: c.advertiser_name,
          merchantName: c.merchant_name,
          merchantVerification: c.merchant_verification,
        })),
      };
    });

    app.get("/v1/campaigns", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany<{
        id: string; name: string; status: string; objective: string; category: string;
        budget_minor: number; currency: string; created_at: string; creative_title: string | null;
      }>(
        ctx.pool,
        `SELECT id, name, status, objective, category, budget_minor, currency, created_at, creative_title
           FROM campaigns WHERE advertiser_id = $1 ORDER BY created_at DESC`,
        [user.id],
      );
      return {
        campaigns: rows.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          objective: c.objective,
          category: c.category,
          budgetMinor: c.budget_minor,
          currency: c.currency,
          creativeTitle: c.creative_title,
          createdAt: c.created_at,
        })),
      };
    });

    app.get("/v1/campaigns/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const c = await queryOne<{
        id: string; advertiser_id: string; name: string; status: string; objective: string;
        creative: string; creative_title: string | null; creative_body: string | null; creative_cta: string | null;
        creative_image_url: string | null;
        destination_url: string; geography: string | null; budget_minor: number;
        currency: string; frequency_cap: number; category: string; moderation_reason: string | null;
        landing_merchant_id: string | null;
      }>(ctx.pool, "SELECT * FROM campaigns WHERE id = $1", [id]);
      if (!c) throw ApiError.notFound("Campaign not found");
      if (c.advertiser_id !== user.id && !user.isAdmin) throw ApiError.forbidden("You cannot view this campaign");
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        creative: c.creative,
        creativeTitle: c.creative_title,
        creativeBody: c.creative_body,
        creativeCta: c.creative_cta,
        creativeImageUrl: c.creative_image_url,
        destinationUrl: c.destination_url,
        geography: c.geography,
        budgetMinor: c.budget_minor,
        currency: c.currency,
        frequencyCap: c.frequency_cap,
        category: c.category,
        moderationReason: c.moderation_reason,
        merchantId: c.landing_merchant_id,
      };
    });
  };
}
