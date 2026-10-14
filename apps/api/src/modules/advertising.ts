import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireAdmin, requireUser, type AppContext } from "../http.js";

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
  destinationUrl: z.string().url().max(1000),
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
      const created = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO campaigns (id, advertiser_id, name, objective, creative, destination_url, audience,
                                geography, budget_minor, currency, schedule_start, schedule_end, frequency_cap, category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          newId(), user.id, input.name, input.objective, input.creative, input.destinationUrl,
          JSON.stringify(input.audience), input.geography ?? null, input.budgetMinor, input.currency.toUpperCase(),
          input.scheduleStart ?? null, input.scheduleEnd ?? null, input.frequencyCap, input.category,
        ],
      );
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
      return { id, status: next };
    });

    app.get("/v1/campaigns", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, name, status, objective, category, budget_minor, currency, created_at
           FROM campaigns WHERE advertiser_id = $1 ORDER BY created_at DESC`,
        [user.id],
      );
      return { campaigns: rows };
    });

    app.get("/v1/campaigns/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const c = await queryOne<{
        id: string; advertiser_id: string; name: string; status: string; objective: string;
        creative: string; destination_url: string; geography: string | null; budget_minor: number;
        currency: string; frequency_cap: number; category: string; moderation_reason: string | null;
      }>(ctx.pool, "SELECT * FROM campaigns WHERE id = $1", [id]);
      if (!c) throw ApiError.notFound("Campaign not found");
      if (c.advertiser_id !== user.id && !user.isAdmin) throw ApiError.forbidden("You cannot view this campaign");
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        creative: c.creative,
        destinationUrl: c.destination_url,
        geography: c.geography,
        budgetMinor: c.budget_minor,
        currency: c.currency,
        frequencyCap: c.frequency_cap,
        category: c.category,
        moderationReason: c.moderation_reason,
      };
    });
  };
}
