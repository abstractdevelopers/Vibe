import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import type pg from "pg";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, publicUser, requireAdmin, requireUser, type AppContext, type UserLike } from "../http.js";
import { requireIdempotencyKey, runIdempotent } from "../idempotency.js";
import { trackSafe } from "./analytics.js";
import { ORDER_FEE_BPS } from "../money/catalogue.js";
import { settleOrderPurchase, refundOrderPurchase } from "../money/settlement.js";
import type { ProviderPaymentEvent } from "../payments/provider.js";

/**
 * Commerce: merchant storefronts, product catalog and the order state machine
 * (§4.7). Vibe does not hold funds; a provider (Bachs) collects payment and a
 * signature-verified webhook is the only thing that can move an order into a
 * paid state. A redirect or a browser event never does.
 */

const merchantSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  category: z.string().max(60).optional(),
  policies: z.string().max(2000).optional(),
  contactRoute: z.string().max(200).optional(),
});

const productSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  priceMinor: z.number().int().min(0),
  currency: z.string().length(3),
  availability: z.enum(["in_stock", "out_of_stock", "preorder", "discontinued"]).default("in_stock"),
  fulfillment: z.string().max(300).optional(),
  refundPolicy: z.string().max(1000).optional(),
  mediaUrl: z.string().max(1000).optional(),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
});

const orderItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(100),
});

const createOrderSchema = z.object({
  merchantId: z.string().uuid(),
  items: z.array(orderItemSchema).min(1).max(50),
});

const merchantVerifySchema = z.object({
  verificationStatus: z.enum(["verified", "rejected", "pending"]),
  reason: z.string().max(500).optional(),
});

const orderTransitionSchema = z.object({
  to: z.enum([
    "seller_confirmed",
    "fulfilling",
    "completed",
    "cancelled",
    "refund_pending",
    "disputed",
  ]),
  note: z.string().max(500).optional(),
});

/**
 * Who may drive which transition. The seller moves an order through fulfilment;
 * the buyer may cancel an unpaid order or raise a dispute. `refunded` is
 * deliberately absent: money only moves back on a verified provider webhook, so
 * `refund_pending` is a request, not a refund.
 */
const SELLER_TARGETS = ["seller_confirmed", "fulfilling", "completed", "cancelled", "refund_pending", "disputed"];
const BUYER_TARGETS = ["cancelled", "disputed"];

/** The states in which an order still needs the seller to do something. */
const OPEN_FOR_SELLER = ["paid", "seller_confirmed", "fulfilling", "disputed"];

/** The order lifecycle. A transition is only allowed if it is listed here. */
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  // `paid` is reachable directly from `created`: a provider webhook can arrive
  // before our own checkout status write lands, and the provider is
  // authoritative about whether money moved.
  created: ["awaiting_payment", "paid", "cancelled", "failed"],
  awaiting_payment: ["payment_processing", "paid", "cancelled", "failed"],
  payment_processing: ["paid", "failed", "cancelled"],
  paid: ["seller_confirmed", "fulfilling", "completed", "refund_pending", "refunded", "disputed"],
  seller_confirmed: ["fulfilling", "completed", "cancelled", "refund_pending", "refunded", "disputed"],
  fulfilling: ["completed", "refund_pending", "refunded", "disputed"],
  completed: ["refund_pending", "refunded", "disputed"],
  refund_pending: ["refunded", "disputed"],
  refunded: [],
  cancelled: [],
  failed: [],
  disputed: ["refunded", "completed", "cancelled"],
};

export function canTransition(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Apply a state change to an order, recording it. Idempotent: re-applying the
 * same target is a no-op, and an illegal transition is rejected rather than
 * silently forced, so a late or duplicate webhook cannot corrupt the order.
 */
export async function transitionOrder(
  db: pg.Pool,
  orderId: string,
  to: string,
  reason: string,
  actorId?: string | null,
): Promise<{ changed: boolean; status: string }> {
  const order = await queryOne<{ status: string }>(db, "SELECT status FROM orders WHERE id = $1", [orderId]);
  if (!order) throw ApiError.notFound("Order not found");
  if (order.status === to) return { changed: false, status: order.status };
  if (!canTransition(order.status, to)) {
    throw ApiError.badRequest(`Cannot move an order from "${order.status}" to "${to}"`);
  }
  await withTransaction(db, async (tx) => {
    await tx.query("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1", [orderId, to]);
    await tx.query(
      `INSERT INTO order_events (id, order_id, from_status, to_status, reason, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), orderId, order.status, to, reason, actorId ?? null],
    );
  });
  return { changed: true, status: to };
}

/**
 * Apply a verified provider event to the order it references. Returns whether
 * an order changed. Unmatched events are ignored (recorded, not applied).
 */
export async function applyProviderEvent(db: pg.Pool, event: ProviderPaymentEvent): Promise<boolean> {
  if (!event.orderReference) return false;
  const order = await queryOne<{ id: string; status: string }>(
    db,
    "SELECT id, status FROM orders WHERE reference = $1",
    [event.orderReference],
  );
  if (!order) return false;
  const target =
    event.type === "payment_succeeded"
      ? "paid"
      : event.type === "payment_failed"
        ? "failed"
        : event.type === "refund_succeeded"
          ? "refunded"
          : null;
  if (!target) return false;
  if (order.status === target) return false;
  if (!canTransition(order.status, target)) {
    // An illegal transition (e.g. a success for an already-cancelled order) is
    // a real-money anomaly an operator must see. The event is already recorded,
    // so acknowledge it rather than making the provider retry forever.
    return false;
  }
  // The order flip and its ledger entry are one transaction: a paid order can
  // never exist without its books, and a redelivered webhook finds the status
  // already at the target and returns without double-booking.
  await withTransaction(db, async (tx) => {
    await tx.query("UPDATE orders SET status = $2, updated_at = now() WHERE id = $1", [order.id, target]);
    await tx.query(
      `INSERT INTO order_events (id, order_id, from_status, to_status, reason, actor_id)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [newId(), order.id, order.status, target, `provider:${event.type}`],
    );
    if (target === "paid") {
      const res = await settleOrderPurchase(tx, { orderId: order.id, feeBps: ORDER_FEE_BPS });
      if (!res.applied && res.reason !== "already_posted") {
        throw new Error(`order settlement failed: ${res.reason}`);
      }
    } else if (target === "refunded") {
      const res = await refundOrderPurchase(tx, { orderId: order.id });
      if (!res.applied && res.reason !== "not_posted") {
        throw new Error(`order refund failed: ${res.reason}`);
      }
    }
  });
  return true;
}

export function commerceRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // ---- Merchants ----

    app.post("/v1/merchants", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(merchantSchema, req.body);
      const created = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO merchants (id, owner_id, name, description, category, policies, contact_route)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [newId(), user.id, input.name, input.description ?? null, input.category ?? null, input.policies ?? null, input.contactRoute ?? null],
      );
      reply.code(201);
      // A new merchant is unverified; an operator must verify before products go live.
      return { id: created!.id, verificationStatus: "unverified" };
    });

    app.get("/v1/merchants", async (req) => {
      await requireUser(ctx, req);
      // Discovery lists verified businesses only; an unverified merchant is not
      // surfaced publicly.
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, name, description, category, verification_status
           FROM merchants WHERE verification_status = 'verified' ORDER BY created_at DESC LIMIT 50`,
      );
      return { merchants: rows };
    });

    /** The caller's own businesses, whatever their verification state. */
    app.get("/v1/merchants/mine", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, name, description, category, verification_status, created_at
           FROM merchants WHERE owner_id = $1 ORDER BY created_at DESC`,
        [user.id],
      );
      return {
        merchants: rows.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          category: m.category,
          verificationStatus: m.verification_status,
          createdAt: m.created_at,
        })),
      };
    });

    app.get("/v1/merchants/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const m = await queryOne<{
        id: string; name: string; description: string | null; category: string | null;
        verification_status: string; policies: string | null; contact_route: string | null;
        owner_id: string;
      }>(ctx.pool, "SELECT * FROM merchants WHERE id = $1", [id]);
      if (!m) throw ApiError.notFound("Merchant not found");
      trackSafe(ctx.pool, { name: "merchant_viewed", userId: user.id, properties: { entityType: "merchant", entityId: id } });
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        category: m.category,
        verificationStatus: m.verification_status,
        policies: m.policies,
        contactRoute: m.contact_route,
        isOwner: m.owner_id === user.id,
      };
    });

    /** An operator verifies (or rejects) a merchant. Audited. */
    app.post("/v1/admin/merchants/:id/verify", async (req) => {
      const user = await requireUser(ctx, req);
      requireAdmin(user);
      const { id } = req.params as { id: string };
      const input = parse(merchantVerifySchema, req.body);
      const m = await queryOne<{ id: string }>(ctx.pool, "SELECT id FROM merchants WHERE id = $1", [id]);
      if (!m) throw ApiError.notFound("Merchant not found");
      await withTransaction(ctx.pool, async (tx) => {
        await tx.query("UPDATE merchants SET verification_status = $2, updated_at = now() WHERE id = $1", [id, input.verificationStatus]);
        await tx.query(
          `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
           VALUES ($1, 'merchant.verified', 'merchant', $2, $3)`,
          [user.id, id, JSON.stringify({ status: input.verificationStatus, reason: input.reason ?? null })],
        );
      });
      return { id, verificationStatus: input.verificationStatus };
    });

    // ---- Products ----

    app.post("/v1/merchants/:id/products", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(productSchema, req.body);
      const m = await queryOne<{ owner_id: string; verification_status: string }>(
        ctx.pool,
        "SELECT owner_id, verification_status FROM merchants WHERE id = $1",
        [id],
      );
      if (!m) throw ApiError.notFound("Merchant not found");
      if (m.owner_id !== user.id && !user.isAdmin) throw ApiError.forbidden("Only the merchant owner can add products");
      // An unverified merchant cannot publish a live product.
      if (input.status === "active" && m.verification_status !== "verified") {
        throw ApiError.badRequest("The merchant must be verified before a product can be active");
      }
      const created = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO products (id, merchant_id, name, description, price_minor, currency, availability,
                               fulfillment, refund_policy, media_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [newId(), id, input.name, input.description ?? null, input.priceMinor, input.currency.toUpperCase(),
         input.availability, input.fulfillment ?? null, input.refundPolicy ?? null, input.mediaUrl ?? null, input.status],
      );
      reply.code(201);
      return { id: created!.id };
    });

    app.get("/v1/merchants/:id/products", async (req) => {
      await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const rows = await queryMany<{
        id: string; name: string; description: string | null; price_minor: number; currency: string;
        availability: string; fulfillment: string | null; refund_policy: string | null;
        media_url: string | null; status: string;
      }>(
        ctx.pool,
        `SELECT id, name, description, price_minor, currency, availability, fulfillment, refund_policy, media_url, status
           FROM products WHERE merchant_id = $1 AND status <> 'archived' ORDER BY created_at DESC`,
        [id],
      );
      return {
        products: rows.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          priceMinor: p.price_minor,
          currency: p.currency,
          availability: p.availability,
          fulfillment: p.fulfillment,
          refundPolicy: p.refund_policy,
          mediaUrl: p.media_url,
          status: p.status,
        })),
      };
    });

    app.get("/v1/products/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const p = await queryOne<{
        id: string; merchant_id: string; name: string; description: string | null;
        price_minor: number; currency: string; availability: string; fulfillment: string | null;
        refund_policy: string | null; media_url: string | null; status: string;
        merchant_name: string; verification_status: string;
      }>(
        ctx.pool,
        `SELECT p.*, m.name AS merchant_name, m.verification_status
           FROM products p JOIN merchants m ON m.id = p.merchant_id
          WHERE p.id = $1`,
        [id],
      );
      if (!p) throw ApiError.notFound("Product not found");
      trackSafe(ctx.pool, { name: "product_viewed", userId: user.id, properties: { entityType: "product", entityId: id } });
      return {
        id: p.id,
        merchantId: p.merchant_id,
        merchantName: p.merchant_name,
        merchantVerification: p.verification_status,
        name: p.name,
        description: p.description,
        priceMinor: p.price_minor,
        currency: p.currency,
        availability: p.availability,
        fulfillment: p.fulfillment,
        refundPolicy: p.refund_policy,
        mediaUrl: p.media_url,
        status: p.status,
      };
    });

    // ---- Orders ----

    app.post("/v1/orders", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(createOrderSchema, req.body);
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/orders", key, requestBody: req.body },
        async () => {
          const merchant = await queryOne<{ id: string }>(ctx.pool, "SELECT id FROM merchants WHERE id = $1", [input.merchantId]);
          if (!merchant) throw ApiError.notFound("Merchant not found");

          const ids = input.items.map((i) => i.productId);
          const products = await queryMany<{
            id: string; merchant_id: string; name: string; price_minor: number; currency: string; status: string; availability: string;
          }>(
            ctx.pool,
            `SELECT id, merchant_id, name, price_minor, currency, status, availability
               FROM products WHERE id = ANY($1::uuid[])`,
            [ids],
          );
          if (products.length !== ids.length) throw ApiError.badRequest("One or more products were not found");

          // All items must belong to the merchant and share one currency.
          let currency: string | null = null;
          let total = 0;
          const lines = input.items.map((item) => {
            const p = products.find((x) => x.id === item.productId)!;
            if (p.merchant_id !== input.merchantId) throw ApiError.badRequest("All items must come from the same merchant");
            if (p.status !== "active") throw ApiError.badRequest(`"${p.name}" is not available for sale`);
            if (currency && p.currency !== currency) throw ApiError.badRequest("All items must share one currency");
            currency = p.currency;
            total += p.price_minor * item.quantity;
            return { productId: p.id, name: p.name, unitAmount: p.price_minor, quantity: item.quantity, currency: p.currency };
          });

          const order = await withTransaction(ctx.pool, async (tx) => {
            const created = await queryOne<{ id: string }>(
              tx,
              `INSERT INTO orders (id, buyer_id, merchant_id, status, amount_minor, currency, reference)
               VALUES ($1,$2,$3,'created',$4,$5,$6) RETURNING id`,
              [newId(), user.id, input.merchantId, total, currency, `ord_${newId()}`],
            );
            for (const line of lines) {
              await tx.query(
                `INSERT INTO order_items (id, order_id, product_id, name, unit_amount_minor, quantity, currency)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [newId(), created!.id, line.productId, line.name, line.unitAmount, line.quantity, line.currency],
              );
            }
            await tx.query(
              `INSERT INTO order_events (id, order_id, from_status, to_status, reason, actor_id)
               VALUES ($1,$2,NULL,'created','order.created',$3)`,
              [newId(), created!.id, user.id],
            );
            return created!;
          });
          reply.code(201);
          return { statusCode: 201, body: { id: order.id, status: "created", amountMinor: total, currency } };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    /**
     * Start a provider checkout for an order. The order moves to
     * awaiting_payment; it does NOT become paid here. Only a verified webhook
     * can do that.
     */
    app.post("/v1/orders/:id/checkout", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const { id } = req.params as { id: string };
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: `POST /v1/orders/${id}/checkout`, key, requestBody: { id } },
        async () => {
          const order = await queryOne<{ id: string; buyer_id: string; amount_minor: number; currency: string; status: string; reference: string }>(
            ctx.pool,
            "SELECT id, buyer_id, amount_minor, currency, status, reference FROM orders WHERE id = $1",
            [id],
          );
          if (!order) throw ApiError.notFound("Order not found");
          if (order.buyer_id !== user.id) throw ApiError.forbidden("Only the buyer can pay for this order");
          if (!["created", "awaiting_payment"].includes(order.status)) {
            throw ApiError.badRequest(`An order in "${order.status}" cannot be checked out`);
          }
          const session = await ctx.provider.createCheckout({
            amount: { amount: order.amount_minor, currency: order.currency },
            reference: order.reference,
            description: `Vibe order ${order.reference}`,
          });
          await ctx.pool.query("UPDATE orders SET provider = $2, provider_ref = $3, updated_at = now() WHERE id = $1", [
            id, ctx.provider.name, session.providerRef,
          ]);
          if (order.status === "created") await transitionOrder(ctx.pool, id, "awaiting_payment", "checkout.created", user.id);
          trackSafe(ctx.pool, { name: "checkout_started", userId: user.id, properties: { entityType: "order", entityId: id } });
          return {
            statusCode: 202,
            body: {
              orderId: id,
              status: "awaiting_payment",
              providerRef: session.providerRef,
              redirectUrl: session.redirectUrl,
              // The client must show "awaiting confirmation", never "paid".
              note: "Payment is confirmed only by a verified provider webhook.",
            },
          };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    app.get("/v1/orders/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const order = await queryOne<{
        id: string; buyer_id: string; merchant_id: string; status: string;
        amount_minor: number; currency: string; provider: string | null; provider_ref: string | null; reference: string;
      }>(ctx.pool, "SELECT * FROM orders WHERE id = $1", [id]);
      if (!order) throw ApiError.notFound("Order not found");
      if (order.buyer_id !== user.id && !user.isAdmin) {
        // The merchant owner may also see their own order.
        const m = await queryOne<{ owner_id: string }>(ctx.pool, "SELECT owner_id FROM merchants WHERE id = $1", [order.merchant_id]);
        if (m?.owner_id !== user.id) throw ApiError.forbidden("You cannot view this order");
      }
      const merchantRow = await queryOne<{ owner_id: string; name: string }>(
        ctx.pool,
        "SELECT owner_id, name FROM merchants WHERE id = $1",
        [order.merchant_id],
      );
      const isSeller = merchantRow?.owner_id === user.id;
      const items = await queryMany(
        ctx.pool,
        `SELECT id, name, unit_amount_minor, quantity, currency FROM order_items WHERE order_id = $1`,
        [id],
      );
      const events = await queryMany(
        ctx.pool,
        `SELECT from_status, to_status, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at`,
        [id],
      );
      return {
        id: order.id,
        status: order.status,
        amountMinor: order.amount_minor,
        currency: order.currency,
        reference: order.reference,
        provider: order.provider,
        providerRef: order.provider_ref,
        merchantId: order.merchant_id,
        merchantName: merchantRow?.name ?? null,
        isSeller,
        isBuyer: order.buyer_id === user.id,
        items: items.map((it) => ({
          id: it.id,
          name: it.name,
          unitAmountMinor: it.unit_amount_minor,
          quantity: it.quantity,
          currency: it.currency,
        })),
        history: events.map((e) => ({
          fromStatus: e.from_status,
          toStatus: e.to_status,
          reason: e.reason,
          createdAt: e.created_at,
        })),
      };
    });

    app.get("/v1/orders", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany<{
        id: string; merchant_id: string; status: string; amount_minor: number; currency: string; created_at: string;
      }>(
        ctx.pool,
        `SELECT id, merchant_id, status, amount_minor, currency, created_at
           FROM orders WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [user.id],
      );
      return {
        orders: rows.map((o) => ({
          id: o.id,
          merchantId: o.merchant_id,
          status: o.status,
          amountMinor: o.amount_minor,
          currency: o.currency,
          createdAt: o.created_at,
        })),
      };
    });

    /**
     * The seller's incoming orders: everything bought from a store the caller
     * owns. `open` narrows to the ones that still need the seller to act.
     */
    app.get("/v1/seller/orders", async (req) => {
      const user = await requireUser(ctx, req);
      const { open } = req.query as { open?: string };
      const onlyOpen = open === "true" || open === "1";
      const rows = await queryMany<{
        id: string; merchant_id: string; merchant_name: string; status: string;
        amount_minor: number; currency: string; created_at: string; buyer_handle: string;
      }>(
        ctx.pool,
        `SELECT o.id, o.merchant_id, m.name AS merchant_name, o.status, o.amount_minor,
                o.currency, o.created_at, u.handle AS buyer_handle
           FROM orders o
           JOIN merchants m ON m.id = o.merchant_id
           JOIN users u ON u.id = o.buyer_id
          WHERE m.owner_id = $1
            ${onlyOpen ? `AND o.status = ANY($2::text[])` : ""}
          ORDER BY o.created_at DESC LIMIT 100`,
        onlyOpen ? [user.id, OPEN_FOR_SELLER] : [user.id],
      );
      return {
        orders: rows.map((o) => ({
          id: o.id,
          merchantId: o.merchant_id,
          merchantName: o.merchant_name,
          status: o.status,
          amountMinor: o.amount_minor,
          currency: o.currency,
          createdAt: o.created_at,
          buyerHandle: o.buyer_handle,
        })),
      };
    });

    /**
     * Move an order along its lifecycle. The seller drives fulfilment; the buyer
     * may cancel an unpaid order or raise a dispute. Every change is recorded in
     * `order_events`, and `refunded` is never reachable from here — only a
     * verified provider webhook marks money returned.
     */
    app.post("/v1/orders/:id/transition", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(orderTransitionSchema, req.body);
      const order = await queryOne<{
        id: string; buyer_id: string; merchant_id: string; status: string;
      }>(ctx.pool, "SELECT id, buyer_id, merchant_id, status FROM orders WHERE id = $1", [id]);
      if (!order) throw ApiError.notFound("Order not found");
      const merchant = await queryOne<{ owner_id: string }>(
        ctx.pool,
        "SELECT owner_id FROM merchants WHERE id = $1",
        [order.merchant_id],
      );
      const isSeller = merchant?.owner_id === user.id;
      const isBuyer = order.buyer_id === user.id;
      if (!isSeller && !isBuyer && !user.isAdmin) {
        throw ApiError.forbidden("You cannot change this order");
      }
      if (!user.isAdmin) {
        // Seller-only steps.
        if ((input.to === "seller_confirmed" || input.to === "fulfilling") && !isSeller) {
          throw ApiError.forbidden("Only the seller can do that");
        }
        // A buyer may confirm receipt of an order that is on its way.
        const buyerMayComplete = input.to === "completed" && order.status === "fulfilling";
        if (isBuyer && !isSeller && !BUYER_TARGETS.includes(input.to) && !buyerMayComplete) {
          throw ApiError.forbidden("Only the seller can do that");
        }
        if (isSeller && !SELLER_TARGETS.includes(input.to)) {
          throw ApiError.badRequest("That is not a seller action");
        }
      }
      const result = await transitionOrder(ctx.pool, id, input.to, input.note ?? `order.${input.to}`, user.id);
      trackSafe(ctx.pool, {
        name: "order_transition",
        userId: user.id,
        properties: { entityType: "order", entityId: id, to: input.to },
      });
      return { id, status: result.status, changed: result.changed };
    });
  };
}
