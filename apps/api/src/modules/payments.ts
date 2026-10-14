import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryOne } from "../db.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { requireIdempotencyKey, runIdempotent } from "../idempotency.js";
import { applyProviderEvent } from "./commerce.js";

/**
 * Payment boundary endpoints. No order/checkout product ships in V1's first
 * sprint, so this exposes only the two integration points the spec requires:
 * creating a provider checkout attempt (idempotent, never marks success) and
 * receiving provider webhooks (signature-verified, deduplicated).
 */

const checkoutSchema = z.object({
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  reference: z.string().min(1).max(120),
  description: z.string().min(1).max(200),
});

export function paymentsRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/payments/checkout", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(checkoutSchema, req.body);
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/payments/checkout", key, requestBody: req.body },
        async () => {
          const session = await ctx.provider.createCheckout({
            amount: { amount: input.amountMinor, currency: input.currency.toUpperCase() },
            reference: input.reference,
            description: input.description,
          });
          return {
            statusCode: 202,
            // The client must never treat this as a completed payment.
            body: {
              providerRef: session.providerRef,
              redirectUrl: session.redirectUrl,
              status: session.requiresConfirmation ? "awaiting_confirmation" : "processing",
            },
          };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    app.post("/v1/webhooks/payments", async (req, reply) => {
      // Use the exact bytes Bachs signed, not a re-serialised body.
      const raw = (req as { rawBody?: string }).rawBody ?? (typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
      const signature =
        (req.headers["x-bachs-signature"] as string | undefined) ??
        (req.headers["x-bachs-signature-v2"] as string | undefined) ??
        (req.headers["x-vibe-signature"] as string | undefined);
      const timestamp = req.headers["x-bachs-timestamp"] as string | undefined;
      if (!ctx.provider.verifyWebhook(raw, signature, timestamp)) {
        throw ApiError.unauthorized("Invalid webhook signature");
      }
      const event = ctx.provider.parseWebhook(raw);
      // The inbox primary key (provider, event_id) makes redelivery a no-op.
      const inserted = await ctx.pool.query(
        `INSERT INTO provider_webhook_events (provider, event_id, provider_ref, payload)
         VALUES ($1, $2, $3, $4) ON CONFLICT (provider, event_id) DO NOTHING`,
        [event.provider, event.eventId, event.providerRef, JSON.stringify(event)],
      );
      if (inserted.rowCount === 0) {
        reply.code(200);
        return { status: "duplicate_ignored" };
      }
      // A verified event can advance the order it references. Unmatched events
      // are recorded but not applied (they may belong to a different system).
      const applied = await applyProviderEvent(ctx.pool, event);
      await ctx.pool.query(
        `UPDATE provider_webhook_events SET processed_at = now() WHERE provider = $1 AND event_id = $2`,
        [event.provider, event.eventId],
      );
      reply.code(202);
      return { status: "accepted", eventId: event.eventId, type: event.type, orderUpdated: applied };
    });

    app.get("/v1/payments/attempts/:providerRef", async (req) => {
      const user = await requireUser(ctx, req);
      const { providerRef } = req.params as { providerRef: string };
      const row = await queryOne(
        ctx.pool,
        `SELECT provider, event_id, received_at, processed_at FROM provider_webhook_events
          WHERE provider_ref = $1 ORDER BY received_at DESC LIMIT 1`,
        [providerRef],
      );
      return {
        providerRef,
        confirmed: row !== null,
        note: "A checkout attempt is only confirmed by a verified provider webhook.",
      };
    });
  };
}
