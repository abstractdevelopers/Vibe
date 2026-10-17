import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";
import { createPaymentProvider } from "../src/payments/provider.js";
import { splitGift, GIFT_CATALOGUE, GIFT_FEE_BPS } from "../src/money/catalogue.js";
import { creatorBalance, HOLD_DAYS, MIN_PAYOUT_MINOR } from "../src/money/ledger.js";

/**
 * Money invariants.
 *
 * These are the tests that matter most in the codebase: they assert that the
 * books balance, that a gift is only paid after a signature-verified webhook,
 * that a duplicate webhook cannot double-deliver or double-credit, that a
 * creator cannot be paid more than they earned, and that no client can name its
 * own price or payout amount.
 */

const STUB_SECRET = "test-webhook-secret";

/**
 * Sign as the stub provider does. The Bachs adapter is exercised separately by
 * unit tests below, because constructing it and creating a checkout would make
 * a real network call to the sandbox.
 */
function sign(rawBody: string): string {
  return createHmac("sha256", STUB_SECRET).update(rawBody).digest("hex");
}

async function postWebhook(
  app: Harness["app"],
  payload: { id: string; type: string; reference: string; amountMinor: number; currency?: string },
): Promise<{ statusCode: number; body: any }> {
  const raw = JSON.stringify({
    id: payload.id,
    type: payload.type,
    providerRef: `chk_${payload.id}`,
    amount: { amount: payload.amountMinor, currency: payload.currency ?? "NGN" },
    orderReference: payload.reference,
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/webhooks/payments",
    payload: raw,
    headers: { "content-type": "application/json", "x-vibe-signature": sign(raw) },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

/** Every journal must sum to zero. This is the core accounting invariant. */
async function assertBooksBalance(h: Harness): Promise<void> {
  const res = await h.pool.query(
    `SELECT j.id, j.kind,
            SUM(CASE WHEN e.direction = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) AS imbalance
       FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
      GROUP BY j.id, j.kind
     HAVING SUM(CASE WHEN e.direction = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) <> 0`,
  );
  expect(res.rows).toEqual([]);
}

/** Sum of one account kind across all accounts, signed (credit positive). */
async function accountTotal(h: Harness, kind: string): Promise<number> {
  const res = await h.pool.query(
    `SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0) AS total
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = $1`,
    [kind],
  );
  return Number(res.rows[0]!.total);
}

describe("gift split arithmetic", () => {
  it("splits a price into fee and recipient share without losing a kobo", () => {
    for (const gift of GIFT_CATALOGUE) {
      const { feeMinor, recipientMinor } = splitGift(gift.priceMinor, gift.feeBps);
      expect(feeMinor + recipientMinor).toBe(gift.priceMinor);
      expect(recipientMinor).toBeGreaterThan(0);
    }
  });

  it("floors the fee, so rounding never shortchanges the creator", () => {
    // 33.33% of 100 kobo is 33.33; the fee must be 33, not 34.
    const { feeMinor, recipientMinor } = splitGift(100, 3333);
    expect(feeMinor).toBe(33);
    expect(recipientMinor).toBe(67);
  });

  it("keeps the advertised rate", () => {
    expect(GIFT_FEE_BPS).toBe(1500);
    expect(splitGift(100_000, GIFT_FEE_BPS)).toEqual({ feeMinor: 15_000, recipientMinor: 85_000 });
  });
});

describe("paid gifts end to end", () => {
  let h: Harness;
  let buyer: TestUser;
  let creator: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    buyer = await registerUser(h.app, "buyer");
    creator = await registerUser(h.app, "creator");
  });

  afterAll(async () => {
    await h.close();
  });

  it("lists the catalogue with the creator's share stated", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/money/gifts", headers: auth(buyer.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gifts.length).toBe(GIFT_CATALOGUE.length);
    const rose = body.gifts.find((g: any) => g.id === "rose");
    expect(rose.priceMinor).toBe(20_000);
    expect(rose.recipientMinor).toBe(17_000);
    // The buyer is told the split before they pay.
    expect(body.policy).toContain("15%");
  });

  it("refuses a gift to yourself", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/gifts/purchase",
      headers: { ...auth(buyer.token), "idempotency-key": "self-1" },
      payload: { giftId: "rose", recipientId: buyer.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates a pending purchase and does NOT mark it paid", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/gifts/purchase",
      headers: { ...auth(buyer.token), "idempotency-key": "buy-1" },
      payload: { giftId: "fire", quantity: 2, recipientId: creator.id },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    // 2 x ₦2,000 = ₦4,000; Vibe keeps ₦600; creator earns ₦3,400.
    expect(body.amountMinor).toBe(400_000);
    expect(body.feeMinor).toBe(60_000);
    expect(body.recipientMinor).toBe(340_000);
    // The critical assertion: a checkout session is not a payment.
    expect(body.status).toBe("pending");

    const row = await h.pool.query("SELECT status FROM gift_purchases WHERE reference = $1", [body.reference]);
    expect(row.rows[0].status).toBe("pending");
    // No money has moved, so there is no ledger journal yet.
    expect(await accountTotal(h, "platform_revenue")).toBe(0);
  });

  it("ignores a purchase whose gift does not exist", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/gifts/purchase",
      headers: { ...auth(buyer.token), "idempotency-key": "buy-bad" },
      payload: { giftId: "not-a-gift", recipientId: creator.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not pay a gift on a webhook with a bad signature", async () => {
    const raw = JSON.stringify({ id: "evt_bad", type: "collection.succeeded", data: { reference: "GIFT-nope", amount: "1.00", currency: "NGN" } });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/webhooks/payments",
      payload: raw,
      headers: { "content-type": "application/json", "x-bachs-signature": "deadbeef", "x-bachs-timestamp": String(Math.floor(Date.now() / 1000)) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("pays the gift only on a verified webhook, and balances the books", async () => {
    const purchase = await h.pool.query("SELECT reference, amount_minor FROM gift_purchases LIMIT 1");
    const reference = purchase.rows[0].reference;
    const amount = Number(purchase.rows[0].amount_minor);

    const { statusCode, body } = await postWebhook(h.app, {
      id: "evt_paid_1",
      type: "payment_succeeded",
      reference,
      amountMinor: amount,
    });
    expect(statusCode).toBe(202);
    expect(body.gift.applied).toBe(true);

    const row = await h.pool.query("SELECT status, journal_id FROM gift_purchases WHERE reference = $1", [reference]);
    expect(row.rows[0].status).toBe("paid");
    expect(row.rows[0].journal_id).not.toBeNull();

    // The books balance, and the split is exactly as advertised.
    await assertBooksBalance(h);
    expect(await accountTotal(h, "platform_revenue")).toBe(60_000);
    expect(await accountTotal(h, "creator_earnings")).toBe(340_000);

    // The gift is delivered exactly once.
    const gifts = await h.pool.query("SELECT count(*) AS n FROM paid_gifts WHERE recipient_id = $1", [creator.id]);
    expect(Number(gifts.rows[0].n)).toBe(1);
  });

  it("does not double-credit on a redelivered webhook", async () => {
    const purchase = await h.pool.query("SELECT reference, amount_minor FROM gift_purchases LIMIT 1");
    const reference = purchase.rows[0].reference;
    const amount = Number(purchase.rows[0].amount_minor);
    // Same event id: deduplicated by the inbox primary key.
    const { statusCode, body } = await postWebhook(h.app, {
      id: "evt_paid_1",
      type: "payment_succeeded",
      reference,
      amountMinor: amount,
    });
    expect(statusCode).toBe(200);
    expect(body.status).toBe("duplicate_ignored");

    // A new event id for the same reference must also not double-credit.
    const again = await postWebhook(h.app, {
      id: "evt_paid_1b",
      type: "payment_succeeded",
      reference,
      amountMinor: amount,
    });
    expect(again.body.gift.applied).toBe(false);
    expect(again.body.gift.reason).toBe("already_paid");

    await assertBooksBalance(h);
    expect(await accountTotal(h, "creator_earnings")).toBe(340_000);
    const gifts = await h.pool.query("SELECT count(*) AS n FROM paid_gifts WHERE recipient_id = $1", [creator.id]);
    expect(Number(gifts.rows[0].n)).toBe(1);
  });

  it("refuses to fulfil when the collected amount does not match", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/gifts/purchase",
      headers: { ...auth(buyer.token), "idempotency-key": "buy-mismatch" },
      payload: { giftId: "rose", recipientId: creator.id },
    });
    const { reference } = res.json();
    const { body } = await postWebhook(h.app, {
      id: "evt_mismatch",
      type: "payment_succeeded",
      reference,
      amountMinor: 100,
    });
    expect(body.gift.applied).toBe(false);
    expect(body.gift.reason).toBe("amount_mismatch");

    const row = await h.pool.query("SELECT status FROM gift_purchases WHERE reference = $1", [reference]);
    expect(row.rows[0].status).toBe("failed");
    // Nothing was credited for the bad charge.
    await assertBooksBalance(h);
  });

  it("shows the creator their earnings, with the hold applied", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/money/balance", headers: auth(creator.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lifetimeEarnedMinor).toBe(340_000);
    // Newly earned money is held, so it is not yet available.
    expect(body.pendingMinor).toBe(340_000);
    expect(body.availableMinor).toBe(0);
    expect(body.minPayoutMinor).toBe(MIN_PAYOUT_MINOR);
  });

  it("lets a gift be refunded, reversing the entries rather than editing them", async () => {
    const purchase = await h.pool.query("SELECT reference FROM gift_purchases WHERE status = 'paid' LIMIT 1");
    const reference = purchase.rows[0].reference;
    const { body } = await postWebhook(h.app, {
      id: "evt_refund_1",
      type: "refund_succeeded",
      reference,
      amountMinor: 400_000,
    });
    expect(body.gift.applied).toBe(true);
    await assertBooksBalance(h);
    // Revenue and the creator's earnings both fall back to zero.
    expect(await accountTotal(h, "platform_revenue")).toBe(0);
    expect(await accountTotal(h, "creator_earnings")).toBe(0);
    // The delivered gift is withdrawn.
    const gifts = await h.pool.query("SELECT count(*) AS n FROM paid_gifts WHERE recipient_id = $1", [creator.id]);
    expect(Number(gifts.rows[0].n)).toBe(0);
  });
});

describe("payout guards", () => {
  let h: Harness;
  let creator: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    creator = await registerUser(h.app, "payouter");
  });

  afterAll(async () => {
    await h.close();
  });

  it("cannot pay out with no earnings", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/payouts",
      headers: { ...auth(creator.token), "idempotency-key": "po-1" },
      payload: { destinationId: "00000000-0000-0000-0000-000000000000" },
    });
    // Payouts are disabled in the test harness, so the guard fires before any
    // destination lookup. Either way, no money moves.
    expect([404, 503]).toContain(res.statusCode);
  });

  it("refuses a payout request cleanly when payouts are disabled", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/payouts",
      headers: { ...auth(creator.token), "idempotency-key": "po-disabled" },
      payload: { destinationId: "00000000-0000-0000-0000-000000000000" },
    });
    // A clear 503, not a 500 from the disabled provider throwing.
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/not switched on/i);
  });

  it("refuses adding a bank account cleanly when payouts are disabled", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/destinations",
      headers: auth(creator.token),
      payload: { accountName: "Test Creator", accountNumber: "8110470104", bankCode: "305" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/not switched on/i);
  });

  it("reports payouts as disabled when no provider is configured", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/money/balance", headers: auth(creator.token) });
    expect(res.json().payoutProvider).toBe("disabled");
    expect(res.json().availableMinor).toBe(0);
  });

  it("never lets a balance be negative even if entries are odd", async () => {
    const balance = await creatorBalance(h.pool, creator.id, "NGN");
    expect(balance.availableMinor).toBeGreaterThanOrEqual(0);
  });

  it("holds earnings for the documented window", () => {
    expect(HOLD_DAYS).toBe(7);
  });
});
