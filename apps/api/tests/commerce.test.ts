import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";
import { createPaymentProvider } from "../src/payments/provider.js";
import { canTransition, ORDER_TRANSITIONS } from "../src/modules/commerce.js";

/**
 * Commerce + Bachs payment boundary.
 *
 * The point of these tests is the money-safety contract: a payment is never
 * marked paid without a signature-verified webhook, duplicate webhooks do not
 * double-apply, illegal state transitions are refused, and the Bachs adapter
 * signs/parses exactly what Bachs documents.
 */

const BACHS_SECRET = "whsec_test_123";

// A real Bachs provider instance, pointed at a base URL we never actually call
// in these tests (we only exercise signature verification and parsing).
const bachs = createPaymentProvider("bachs", BACHS_SECRET, {
  apiKey: "sk_sandbox_test",
  baseUrl: "https://sandbox-api.bachs.io",
  webUrl: "http://localhost:12001",
  apiUrl: "http://localhost:12000",
});

function signBachs(rawBody: string, timestamp: number, secret = BACHS_SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

describe("order state machine", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("created", "awaiting_payment")).toBe(true);
    expect(canTransition("awaiting_payment", "paid")).toBe(true);
    expect(canTransition("paid", "fulfilling")).toBe(true);
    expect(canTransition("refunded", "paid")).toBe(false);
    expect(canTransition("cancelled", "paid")).toBe(false);
    expect(canTransition("created", "completed")).toBe(false);
  });

  it("never lets a terminal state resume", () => {
    for (const terminal of ["refunded", "cancelled", "failed"]) {
      expect(ORDER_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});

describe("bachs provider adapter", () => {
  it("verifies a correctly signed webhook", () => {
    const raw = JSON.stringify({ id: "evt_1", type: "collection.succeeded" });
    const ts = Math.floor(Date.now() / 1000);
    expect(bachs.verifyWebhook(raw, signBachs(raw, ts), String(ts))).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a stale timestamp", () => {
    const raw = JSON.stringify({ id: "evt_1", type: "collection.succeeded" });
    const ts = Math.floor(Date.now() / 1000);
    const good = signBachs(raw, ts);
    expect(bachs.verifyWebhook(raw + " ", good, String(ts))).toBe(false);
    expect(bachs.verifyWebhook(raw, signBachs(raw, ts, "wrong_secret"), String(ts))).toBe(false);
    const stale = ts - 10_000;
    expect(bachs.verifyWebhook(raw, signBachs(raw, stale), String(stale))).toBe(false);
    expect(bachs.verifyWebhook(raw, undefined, String(ts))).toBe(false);
  });

  it("accepts the v2 signature header format", () => {
    const raw = JSON.stringify({ id: "evt_2", type: "collection.succeeded" });
    const ts = Math.floor(Date.now() / 1000);
    expect(bachs.verifyWebhook(raw, `t=${ts},v1=${signBachs(raw, ts)}`, String(ts))).toBe(true);
  });

  it("parses a Bachs event, converting decimal money to exact minor units", () => {
    const raw = JSON.stringify({
      id: "evt_3",
      type: "collection.succeeded",
      data: { checkout_id: "chk_abc", reference: "ord_ref_1", amount: "29.00", currency: "NGN" },
    });
    const event = bachs.parseWebhook(raw);
    expect(event.type).toBe("payment_succeeded");
    expect(event.providerRef).toBe("chk_abc");
    expect(event.orderReference).toBe("ord_ref_1");
    expect(event.amount).toEqual({ amount: 2900, currency: "NGN" });
  });

  it("maps failures and refunds distinctly", () => {
    const fail = bachs.parseWebhook(JSON.stringify({ id: "e", type: "collection.failed", data: {} }));
    const refund = bachs.parseWebhook(JSON.stringify({ id: "e", type: "refund.paid", data: {} }));
    expect(fail.type).toBe("payment_failed");
    expect(refund.type).toBe("refund_succeeded");
  });

  it("refuses to build a bachs provider without a key", () => {
    expect(() => createPaymentProvider("bachs", BACHS_SECRET, { baseUrl: "https://x" })).toThrow(/BACHS_API_KEY/);
  });
});

describe("commerce routes", () => {
  let h: Harness;
  let owner: TestUser;
  let buyer: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    owner = await registerUser(h.app, "shopowner");
    buyer = await registerUser(h.app, "buyer");
  });
  afterAll(async () => h.close());

  async function makeMerchant(verified = true): Promise<string> {
    const res = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(owner.token),
      payload: { name: "Vibe Shop", category: "general" },
    });
    const id = res.json().id;
    if (verified) {
      await h.pool.query("UPDATE merchants SET verification_status = 'verified' WHERE id = $1", [id]);
    }
    return id;
  }

  it("creates a merchant as unverified", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/merchants", headers: auth(owner.token), payload: { name: "New Shop" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().verificationStatus).toBe("unverified");
  });

  it("blocks an unverified merchant from publishing an active product", async () => {
    const merchantId = await makeMerchant(false);
    const res = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(owner.token),
      payload: { name: "Thing", priceMinor: 5000, currency: "NGN", status: "active" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/verified/i);
  });

  it("creates an order and computes the total server-side", async () => {
    const merchantId = await makeMerchant();
    const p1 = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(owner.token),
      payload: { name: "Mug", priceMinor: 2500, currency: "NGN", status: "active" },
    });
    const p2 = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(owner.token),
      payload: { name: "Shirt", priceMinor: 10000, currency: "NGN", status: "active" },
    });
    const res = await h.app.inject({
      method: "POST", url: "/v1/orders", headers: { ...auth(buyer.token), "idempotency-key": "ord-1" },
      payload: { merchantId, items: [{ productId: p1.json().id, quantity: 2 }, { productId: p2.json().id, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amountMinor).toBe(15000);
    expect(res.json().status).toBe("created");
  });

  it("rejects a product that does not belong to the merchant", async () => {
    const m1 = await makeMerchant();
    const m2 = await makeMerchant();
    const p = await h.app.inject({
      method: "POST", url: `/v1/merchants/${m1}/products`, headers: auth(owner.token),
      payload: { name: "Solo", priceMinor: 1000, currency: "NGN", status: "active" },
    });
    const res = await h.app.inject({
      method: "POST", url: "/v1/orders", headers: { ...auth(buyer.token), "idempotency-key": "ord-2" },
      payload: { merchantId: m2, items: [{ productId: p.json().id, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not mark an order paid on checkout; it awaits the webhook", async () => {
    const merchantId = await makeMerchant();
    const p = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(owner.token),
      payload: { name: "Ticket", priceMinor: 7500, currency: "NGN", status: "active" },
    });
    const order = await h.app.inject({
      method: "POST", url: "/v1/orders", headers: { ...auth(buyer.token), "idempotency-key": "ord-3" },
      payload: { merchantId, items: [{ productId: p.json().id, quantity: 1 }] },
    });
    const orderId = order.json().id;
    const checkout = await h.app.inject({
      method: "POST", url: `/v1/orders/${orderId}/checkout`, headers: { ...auth(buyer.token), "idempotency-key": "co-3" },
    });
    expect(checkout.statusCode).toBe(202);
    expect(checkout.json().status).toBe("awaiting_payment");
    const view = await h.app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: auth(buyer.token) });
    expect(view.json().status).toBe("awaiting_payment");
  });
});

describe("webhook → order application (stub provider)", () => {
  let h: Harness;
  let owner: TestUser;
  let buyer: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    owner = await registerUser(h.app, "whowner");
    buyer = await registerUser(h.app, "whbuyer");
  });
  afterAll(async () => h.close());

  function stubSigned(body: object): { raw: string; signature: string } {
    const raw = JSON.stringify(body);
    const signature = createHmac("sha256", "test-webhook-secret").update(raw).digest("hex");
    return { raw, signature };
  }

  async function paidOrder(): Promise<string> {
    const m = await h.app.inject({ method: "POST", url: "/v1/merchants", headers: auth(owner.token), payload: { name: "Shop" } });
    const merchantId = m.json().id;
    await h.pool.query("UPDATE merchants SET verification_status = 'verified' WHERE id = $1", [merchantId]);
    const p = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(owner.token),
      payload: { name: "Item", priceMinor: 5000, currency: "NGN", status: "active" },
    });
    const o = await h.app.inject({
      method: "POST", url: "/v1/orders", headers: { ...auth(buyer.token), "idempotency-key": `k-${Math.random()}` },
      payload: { merchantId, items: [{ productId: p.json().id, quantity: 1 }] },
    });
    const orderId = o.json().id;
    // Check out first, as a real buyer would, so the order is awaiting_payment
    // when the provider webhook arrives.
    await h.app.inject({
      method: "POST", url: `/v1/orders/${orderId}/checkout`, headers: { ...auth(buyer.token), "idempotency-key": `co-${Math.random()}` },
    });
    const ref = (await h.pool.query("SELECT reference FROM orders WHERE id = $1", [orderId])).rows[0].reference as string;
    return ref;
  }

  it("rejects an unsigned webhook", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/webhooks/payments",
      headers: { "content-type": "application/json", "x-vibe-signature": "nope" },
      payload: { id: "evt_x", type: "payment_succeeded" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("marks an order paid only from a verified webhook, and dedupes a redelivery", async () => {
    const reference = await paidOrder();
    const { raw, signature } = stubSigned({
      id: "evt_paid_1", type: "payment_succeeded", providerRef: "chk_1",
      amount: { amount: 5000, currency: "NGN" }, orderReference: reference,
    });
    const first = await h.app.inject({
      method: "POST", url: "/v1/webhooks/payments",
      headers: { "content-type": "application/json", "x-vibe-signature": signature },
      payload: raw,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().orderUpdated).toBe(true);

    const order = (await h.pool.query("SELECT id, status FROM orders WHERE reference = $1", [reference])).rows[0];
    expect(order.status).toBe("paid");

    // Redelivery of the same event id is a no-op, not a second application.
    const second = await h.app.inject({
      method: "POST", url: "/v1/webhooks/payments",
      headers: { "content-type": "application/json", "x-vibe-signature": signature },
      payload: raw,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("duplicate_ignored");
    const events = await h.pool.query("SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND to_status = 'paid'", [order.id]);
    expect(events.rows[0].n).toBe(1);
  });

  it("records but does not apply an event with no matching order", async () => {
    const { raw, signature } = stubSigned({
      id: "evt_orphan", type: "payment_succeeded", providerRef: "chk_x",
      amount: { amount: 100, currency: "NGN" }, orderReference: "does-not-exist",
    });
    const res = await h.app.inject({
      method: "POST", url: "/v1/webhooks/payments",
      headers: { "content-type": "application/json", "x-vibe-signature": signature },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().orderUpdated).toBe(false);
  });

  it("acknowledges, but does not force, a success for an already-cancelled order", async () => {
    const reference = await paidOrder();
    const order = (await h.pool.query("SELECT id FROM orders WHERE reference = $1", [reference])).rows[0];
    await h.pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [order.id]);

    const { raw, signature } = stubSigned({
      id: `evt_late_${Date.now()}`, type: "payment_succeeded", providerRef: "chk_late",
      amount: { amount: 5000, currency: "NGN" }, orderReference: reference,
    });
    const res = await h.app.inject({
      method: "POST", url: "/v1/webhooks/payments",
      headers: { "content-type": "application/json", "x-vibe-signature": signature },
      payload: raw,
    });
    // Acknowledged (the provider should not retry forever) but not applied.
    expect(res.statusCode).toBe(202);
    expect(res.json().orderUpdated).toBe(false);
    const after = (await h.pool.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0];
    expect(after.status).toBe("cancelled");
  });
});
