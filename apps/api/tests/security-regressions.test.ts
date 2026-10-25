import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness, type TestUser } from "./helpers.js";

/**
 * Regressions for the audit fixes. Each case drives the public route that used
 * to be exploitable, rather than calling the helper directly, so a future
 * refactor that drops the guard fails here.
 */

const STUB_SECRET = "test-webhook-secret";

function sign(rawBody: string): string {
  return createHmac("sha256", STUB_SECRET).update(rawBody).digest("hex");
}

function webhookPayload(payload: { id: string; type: string; reference: string; amountMinor: number }) {
  const raw = JSON.stringify({
    id: payload.id,
    type: payload.type,
    providerRef: `chk_${payload.id}`,
    amount: { amount: payload.amountMinor, currency: "NGN" },
    orderReference: payload.reference,
  });
  return { raw, headers: { "content-type": "application/json", "x-bachs-signature": sign(raw) } };
}

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

async function makeAdmin(user: TestUser): Promise<void> {
  await h.pool.query("UPDATE users SET is_admin = true WHERE id = $1", [user.id]);
}

async function makePost(token: string, audience = "public"): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/posts",
    headers: auth(token),
    payload: { body: "audit regression", audience },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("order settlement is amount-checked", () => {
  it("refuses a webhook that pays less than the order asks, and books nothing", async () => {
    const merchant = await registerUser(h.app, "ordmerchant");
    const buyer = await registerUser(h.app, "ordbuyer");
    await makeAdmin(merchant);

    const opened = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(merchant.token), payload: { name: "Shop", category: "retail" },
    });
    const merchantId = opened.json().id;
    await h.app.inject({
      method: "POST", url: `/v1/admin/merchants/${merchantId}/verify`, headers: auth(merchant.token),
      payload: { verificationStatus: "verified" },
    });
    const product = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(merchant.token),
      payload: { name: "Ankara", priceMinor: 500_000, currency: "NGN", status: "active" },
    });
    const productId = product.json().id;

    const order = await h.app.inject({
      method: "POST", url: "/v1/orders", headers: { ...auth(buyer.token), "idempotency-key": "ord-1" },
      payload: { merchantId, items: [{ productId, quantity: 1 }] },
    });
    const orderId = order.json().id as string;
    await h.app.inject({
      method: "POST", url: `/v1/orders/${orderId}/checkout`, headers: { ...auth(buyer.token), "idempotency-key": "ord-checkout-1" }, payload: {},
    });
    const detail = await h.app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: auth(buyer.token) });
    const reference = detail.json().reference as string;

    // A ₦0.01 payment against a ₦5,000 order.
    const { raw, headers } = webhookPayload({ id: "evt_under", type: "collection.succeeded", reference, amountMinor: 1 });
    const hook = await h.app.inject({ method: "POST", url: "/v1/webhooks/payments", payload: raw, headers });
    expect(hook.statusCode).toBe(202);
    expect(hook.json().orderUpdated).toBe(false);

    const after = await h.app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: auth(buyer.token) });
    expect(after.json().status).not.toBe("paid");
    const journals = await h.pool.query("SELECT count(*)::int AS n FROM ledger_journals WHERE kind = 'order_purchase'");
    expect(journals.rows[0].n).toBe(0);
    const audit = await h.pool.query("SELECT count(*)::int AS n FROM money_audit WHERE action = 'order.amount_mismatch'");
    expect(audit.rows[0].n).toBe(1);
  });

  it("refuses to mint a checkout for a reference owned by an internal flow", async () => {
    const user = await registerUser(h.app, "checkouter");
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/payments/checkout",
      headers: { ...auth(user.token), "idempotency-key": "ref-1" },
      payload: { amountMinor: 1, currency: "NGN", reference: "GIFT-anything", description: "cheap" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("fulfils an order the provider reports as overpaid, and flags the excess", async () => {
    // The money was really collected, so the goods must follow. The excess is
    // recorded for an operator to refund rather than silently kept.
    const merchant = await registerUser(h.app, "overmerchant");
    const buyer = await registerUser(h.app, "overbuyer");
    await makeAdmin(merchant);
    const opened = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(merchant.token), payload: { name: "Shop", category: "retail" },
    });
    const merchantId = opened.json().id;
    await h.app.inject({
      method: "POST", url: `/v1/admin/merchants/${merchantId}/verify`, headers: auth(merchant.token),
      payload: { verificationStatus: "verified" },
    });
    const product = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(merchant.token),
      payload: { name: "Ankara", priceMinor: 500_000, currency: "NGN", status: "active" },
    });
    const productId = product.json().id;

    const order = await h.app.inject({
      method: "POST", url: "/v1/orders", headers: { ...auth(buyer.token), "idempotency-key": "ov-1" },
      payload: { merchantId, items: [{ productId, quantity: 1 }] },
    });
    const orderId = order.json().id as string;
    await h.app.inject({
      method: "POST", url: `/v1/orders/${orderId}/checkout`,
      headers: { ...auth(buyer.token), "idempotency-key": "ov-checkout-1" }, payload: {},
    });
    const detail = await h.app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: auth(buyer.token) });
    const reference = detail.json().reference as string;

    const { raw, headers } = webhookPayload({ id: "evt_over", type: "collection.succeeded", reference, amountMinor: 600_000 });
    const hook = await h.app.inject({ method: "POST", url: "/v1/webhooks/payments", payload: raw, headers });
    expect(hook.statusCode).toBe(202);
    expect(hook.json().orderUpdated).toBe(true);

    const after = await h.app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: auth(buyer.token) });
    expect(after.json().status).toBe("paid");

    const audit = await h.pool.query("SELECT metadata FROM money_audit WHERE action = 'order.overpaid'");
    expect(audit.rows).toHaveLength(1);
    expect(Number(audit.rows[0].metadata.excessMinor)).toBe(100_000);
  });
});

describe("post visibility applies to the thread, not just the feed", () => {
  it("hides a private post's comments, reactions and gifts from a stranger", async () => {
    const author = await registerUser(h.app, "privateauthor");
    const stranger = await registerUser(h.app, "stranger");
    const postId = await makePost(author.token, "private");

    for (const [method, url, payload] of [
      ["GET", `/v1/posts/${postId}/comments`, undefined],
      ["POST", `/v1/posts/${postId}/comments`, { body: "hello" }],
      ["POST", `/v1/posts/${postId}/reactions`, { kind: "like" }],
      ["POST", `/v1/posts/${postId}/gifts`, { kind: "sparkle" }],
      ["GET", `/v1/posts/${postId}/gifts`, undefined],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: auth(stranger.token), payload });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    // The author still has full access.
    const own = await h.app.inject({ method: "GET", url: `/v1/posts/${postId}/comments`, headers: auth(author.token) });
    expect(own.statusCode).toBe(200);
  });

  it("refuses a Circle id on a non-Circle post, so search cannot widen it", async () => {
    const author = await registerUser(h.app, "straycircle");
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: auth(author.token),
      payload: { body: "leaky", audience: "private", circleId: "00000000-0000-4000-8000-000000000000" },
    });
    // Validation failures are 422 in this API.
    expect(res.statusCode).toBe(422);
  });

  it("keeps a private post out of another user's search", async () => {
    const author = await registerUser(h.app, "searchauthor");
    const stranger = await registerUser(h.app, "searchstranger");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: auth(author.token),
      payload: { body: "uniquetokenzebra", audience: "private" },
    });
    expect(created.statusCode).toBe(201);

    const res = await h.app.inject({
      method: "GET", url: "/v1/search/posts?q=uniquetokenzebra", headers: auth(stranger.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
  });
});

describe("moderator removals survive the author's undo", () => {
  it("will not let an author restore a comment a moderator removed", async () => {
    const author = await registerUser(h.app, "commentauthor");
    const moderator = await registerUser(h.app, "commentmod");
    const postId = await makePost(author.token);

    const comment = await h.app.inject({
      method: "POST", url: `/v1/posts/${postId}/comments`, headers: auth(author.token), payload: { body: "oops" },
    });
    expect(comment.statusCode).toBe(201);
    const commentId = comment.json().id as string;

    await h.pool.query(
      "UPDATE comments SET deleted_at = now(), deleted_at_prev = NULL, deleted_by = $2 WHERE id = $1",
      [commentId, moderator.id],
    );

    const restore = await h.app.inject({
      method: "POST", url: `/v1/comments/${commentId}/restore`, headers: auth(author.token),
    });
    expect(restore.statusCode).toBe(403);
  });

  it("still lets the author undo their own deletion", async () => {
    const author = await registerUser(h.app, "selfundo");
    const postId = await makePost(author.token);
    const comment = await h.app.inject({
      method: "POST", url: `/v1/posts/${postId}/comments`, headers: auth(author.token), payload: { body: "mine" },
    });
    const commentId = comment.json().id as string;

    const removed = await h.app.inject({
      method: "DELETE", url: `/v1/comments/${commentId}`, headers: auth(author.token),
    });
    expect(removed.statusCode).toBe(204);
    const restored = await h.app.inject({
      method: "POST", url: `/v1/comments/${commentId}/restore`, headers: auth(author.token),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().restored).toBe(true);
  });
});

describe("time-boxed suspensions end on their own", () => {
  it("blocks while the deadline is in the future and lifts once it passes", async () => {
    const user = await registerUser(h.app, "suspended");
    await h.pool.query(
      "UPDATE users SET moderation_status = 'suspended', moderation_until = now() + interval '1 hour' WHERE id = $1",
      [user.id],
    );
    const blocked = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(user.token) });
    expect(blocked.statusCode).toBe(403);

    await h.pool.query(
      "UPDATE users SET moderation_until = now() - interval '1 minute' WHERE id = $1",
      [user.id],
    );
    const allowed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(user.token) });
    expect(allowed.statusCode).toBe(200);

    const row = await h.pool.query(
      "SELECT moderation_status, moderation_until FROM users WHERE id = $1",
      [user.id],
    );
    expect(row.rows[0].moderation_status).toBe("active");
    expect(row.rows[0].moderation_until).toBeNull();
  });
});
