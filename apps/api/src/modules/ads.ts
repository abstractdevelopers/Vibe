import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { ApiError } from "../errors.js";
import { queryMany, queryOne } from "../db.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { trackSafe } from "./analytics.js";

/**
 * Ad delivery and reporting (§4.8).
 *
 * Delivery is deliberately separate from organic ranking: an approved campaign
 * is chosen here and appended to a feed page, so payment can never override
 * safety or relevance. Two rules the spec is explicit about are enforced:
 *
 *   - a campaign only runs once an operator has approved it AND the business
 *     behind it is verified;
 *   - impressions and clicks are deduplicated, so a retried beacon or a replay
 *     cannot inflate reach or clicks (click-fraud protection).
 *
 * Metrics distinguish *reported* (a client beacon) from *verified* (the
 * server-side served record), per §4.8's "clear distinction between estimated
 * and verified metrics".
 */

const impressionSchema = z.object({
  placementId: z.string().min(1).max(80),
  surface: z.enum(["feed", "explore"]).default("feed"),
});

export interface SponsoredAd {
  campaignId: string;
  title: string;
  body: string;
  cta: string;
  /** Banner image, or null for a text-only creative. */
  imageUrl: string | null;
  destinationUrl: string;
  advertiserName: string;
  advertiserId: string;
  placementId: string;
}

/**
 * Choose at most one eligible ad for a viewer on a surface, or null. Eligibility
 * requires an approved campaign whose business is verified, inside its schedule,
 * not hidden by the viewer, and under its per-viewer frequency cap.
 */
export async function selectAdForViewer(
  pool: pg.Pool,
  viewerId: string,
  surface: "feed" | "explore",
  placementId: string,
): Promise<SponsoredAd | null> {
  const ad = await queryOne<{
    id: string;
    advertiser_id: string;
    creative_title: string | null;
    creative_body: string | null;
    creative_cta: string | null;
    creative_image_url: string | null;
    creative: string;
    destination_url: string;
    frequency_cap: number;
    advertiser_name: string;
  }>(
    pool,
    `SELECT c.id, c.advertiser_id, c.creative_title, c.creative_body, c.creative_cta,
            c.creative_image_url, c.creative, c.destination_url, c.frequency_cap,
            COALESCE(m.name, u.display_name) AS advertiser_name
       FROM campaigns c
       JOIN users u ON u.id = c.advertiser_id
       -- A campaign only runs for a verified business. No verified merchant,
       -- no delivery.
       JOIN merchants m ON m.id = c.landing_merchant_id AND m.verification_status = 'verified'
      WHERE c.status IN ('approved', 'active')
        AND (c.schedule_start IS NULL OR c.schedule_start <= now())
        AND (c.schedule_end IS NULL OR c.schedule_end >= now())
        AND NOT EXISTS (SELECT 1 FROM ad_preferences p
                         WHERE p.user_id = $1 AND p.campaign_id = c.id)
        -- Frequency cap: how many times this viewer has already been served.
        AND (SELECT count(*) FROM ad_deliveries d
              WHERE d.campaign_id = c.id AND d.viewer_id = $1
                AND d.served_at > now() - interval '1 day') < c.frequency_cap
        -- The budget is a spend limit: every verified serving costs one
        -- impression, and an exhausted campaign stops delivering. Before this
        -- the budget was stored and reported but nothing ever consumed it.
        AND c.budget_minor > (
              SELECT count(*) * c.cost_per_impression_minor
                FROM ad_deliveries d2 WHERE d2.campaign_id = c.id)
      ORDER BY c.created_at ASC
      LIMIT 1`,
    [viewerId],
  );
  if (!ad) return null;

  // Record the serving. The unique (campaign_id, surface, placement_id,
  // viewer_id) constraint makes this idempotent.
  await pool.query(
    `INSERT INTO ad_deliveries (campaign_id, surface, placement_id, viewer_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (campaign_id, surface, placement_id, viewer_id) DO NOTHING`,
    [ad.id, surface, placementId, viewerId],
  );

  return {
    campaignId: ad.id,
    title: ad.creative_title ?? ad.advertiser_name,
    body: ad.creative_body ?? ad.creative,
    cta: ad.creative_cta ?? "Learn more",
    destinationUrl: ad.destination_url,
    advertiserName: ad.advertiser_name,
    imageUrl: ad.creative_image_url,
    advertiserId: ad.advertiser_id,
    placementId,
  };
}

async function deliveryFor(
  pool: pg.Pool,
  campaignId: string,
  viewerId: string,
  placementId: string,
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    pool,
    `SELECT id FROM ad_deliveries
      WHERE campaign_id = $1 AND viewer_id = $2 AND placement_id = $3`,
    [campaignId, viewerId, placementId],
  );
}

export function adsRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    /** An impression beacon. Idempotent per delivery, so retries do not inflate. */
    app.post("/v1/ads/:id/impression", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(impressionSchema, req.body ?? {});
      const delivery = await deliveryFor(ctx.pool, id, user.id, input.placementId);
      if (!delivery) throw ApiError.notFound("No such ad delivery");
      await ctx.pool.query(
        `INSERT INTO ad_impressions (delivery_id, campaign_id, viewer_id, source)
         VALUES ($1, $2, $3, 'reported')
         ON CONFLICT (delivery_id) DO NOTHING`,
        [delivery.id, id, user.id],
      );
      trackSafe(ctx.pool, { name: "ad_impression", userId: user.id, properties: { entityType: "campaign", entityId: id, surface: input.surface } });
      reply.code(202);
      return { ok: true };
    });

    /** A click. One per delivery; a replayed click is a no-op. */
    app.post("/v1/ads/:id/click", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(impressionSchema, req.body ?? {});
      const delivery = await deliveryFor(ctx.pool, id, user.id, input.placementId);
      if (!delivery) throw ApiError.notFound("No such ad delivery");
      await ctx.pool.query(
        `INSERT INTO ad_clicks (delivery_id, campaign_id, viewer_id)
         VALUES ($1, $2, $3) ON CONFLICT (delivery_id) DO NOTHING`,
        [delivery.id, id, user.id],
      );
      trackSafe(ctx.pool, { name: "ad_click", userId: user.id, properties: { entityType: "campaign", entityId: id } });
      reply.code(202);
      return { ok: true };
    });

    /** Hide this campaign for me. Delivery respects it immediately. */
    app.post("/v1/ads/:id/hide", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await ctx.pool.query(
        `INSERT INTO ad_preferences (user_id, campaign_id) VALUES ($1, $2)
         ON CONFLICT (user_id, campaign_id) DO NOTHING`,
        [user.id, id],
      );
      reply.code(204);
      return null;
    });

    /**
     * Campaign metrics for the advertiser (or an operator). Reported vs
     * verified impressions are returned separately and never summed into one
     * number the UI could present as fact.
     */
    app.get("/v1/campaigns/:id/metrics", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const c = await queryOne<{
        advertiser_id: string; currency: string; budget_minor: number; cost_per_impression_minor: number;
      }>(
        ctx.pool,
        "SELECT advertiser_id, currency, budget_minor, cost_per_impression_minor FROM campaigns WHERE id = $1",
        [id],
      );
      if (!c) throw ApiError.notFound("Campaign not found");
      if (c.advertiser_id !== user.id && !user.isAdmin) {
        throw ApiError.forbidden("You cannot view this campaign's metrics");
      }
      const totals = await queryOne<{
        served: number;
        impressions: number;
        clicks: number;
        reach: number;
      }>(
        ctx.pool,
        `SELECT
           (SELECT count(*) FROM ad_deliveries WHERE campaign_id = $1) AS served,
           (SELECT count(*) FROM ad_impressions WHERE campaign_id = $1) AS impressions,
           (SELECT count(*) FROM ad_clicks WHERE campaign_id = $1) AS clicks,
           (SELECT count(DISTINCT viewer_id) FROM ad_deliveries WHERE campaign_id = $1) AS reach`,
        [id],
      );
      const served = totals?.served ?? 0;
      const impressions = totals?.impressions ?? 0;
      const clicks = totals?.clicks ?? 0;
      // Spend is the verified serving count times the campaign's rate. It is
      // derived, not a running counter, so it cannot drift from deliveries.
      const spentMinor = served * c.cost_per_impression_minor;
      return {
        campaignId: id,
        currency: c.currency,
        budgetMinor: c.budget_minor,
        costPerImpressionMinor: c.cost_per_impression_minor,
        spentMinor,
        remainingBudgetMinor: Math.max(0, c.budget_minor - spentMinor),
        // Verified: the server served the ad. Reported: a client confirmed it
        // was on screen. Both are exposed so the UI can label them honestly.
        verified: { served, reach: totals?.reach ?? 0 },
        reported: { impressions, clicks },
        // Derived, clearly a ratio of the above — not a measurement of its own.
        clickThroughRate: impressions > 0 ? Number((clicks / impressions).toFixed(4)) : null,
      };
    });

    /** My hidden campaigns, so the UI can show and undo a hide. */
    app.get("/v1/ads/hidden", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT c.id AS campaign_id, c.creative_title, c.name, p.hidden_at
           FROM ad_preferences p JOIN campaigns c ON c.id = p.campaign_id
          WHERE p.user_id = $1 ORDER BY p.hidden_at DESC`,
        [user.id],
      );
      return { hidden: rows };
    });
  };
}
