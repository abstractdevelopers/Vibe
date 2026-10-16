import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";
import type { PayoutProvider, PayoutDestination, PayoutResult } from "../src/payments/payouts.js";
import { creatorBalance, HOLD_DAYS } from "../src/money/ledger.js";

/**
 * Split payment, end to end.
 *
 * The other money tests stop at the ledger: a gift is credited to
 * `creator_earnings` and the books balance. This suite follows the money all
 * the way out — a verified gift webhook credits the creator, the creator
 * registers a bank account, requests a payout, and a verified *payout* webhook
 * debits the earnings and records the payout as paid.
 *
 * It exists because that last hop was missing: the webhook handler settled
 * `GIFT-` references but never `WD-` ones, so `settlePayout` was dead code and
 * a payout would have sat at `requested` forever with the creator's earnings
 * never debited. A fake payout provider stands in for Bachs; the settlement
 * logic, the ledger and the routes are all real.
 */

const STUB_SECRET = "test-webhook-secret";

/** A payout provider that records what it was asked to do and approves accounts. */
class FakePayoutProvider implements PayoutProvider {
  readonly name = "bachs";
  readonly destinations: Array<{ accountNumber: string; amountMinor?: number }> = [];
  readonly payouts: Array<{ providerDestinationId: string; amountMinor: number; reference: string }> = [];
  private seq = 0;

  async createDestination(input: {
    accountName: string;
    accountNumber: string;
    bankCode: string;
    currency: string;
    label: string;
  }): Promise<PayoutDestination> {
    this.destinations.push({ accountNumber: input.accountNumber });
    this.seq += 1;
    return {
      providerDestinationId: `pd_test_${this.seq}`,
      // The real provider reviews a new account; the fake approves it so the
      // payout leg can be exercised.
      status: "approved",
      bankName: "Test Bank",
      bankCode: input.bankCode,
      accountName: input.accountName,
      accountLast4: input.accountNumber.slice(-4),
      currency: input.currency,
      isUsable: true,
    };
  }

  async listDestinations(): Promise<PayoutDestination[]> {
    return [];
  }

  async createPayout(input: {
    providerDestinationId: string;
    amountMinor: number;
    currency: string;
    reference: string;
    narration: string;
  }): Promise<PayoutResult> {
    this.payouts.push({
      providerDestinationId: input.providerDestinationId,
      amountMinor: input.amountMinor,
      reference: input.reference,
    });
    // The provider accepts the request but has not moved money yet. Only a
    // verified webhook may mark it paid.
    return { providerRef: `po_test_${this.seq}`, status: "processing", feeMinor: null, failureReason: null };
  }

  async getPayout(): Promise<PayoutResult | null> {
    return null;
  }
}

let h: Harness;
let payouts: FakePayoutProvider;
let buyer: TestUser;
let creator: TestUser;

function sign(rawBody: string): string {
  return createHmac("sha256", STUB_SECRET).update(rawBody).digest("hex");
}

/** Post a signed webhook. `reference` is the `GIFT-`/`WD-` order reference. */
async function postWebhook(payload: {
  id: string;
  type: string;
  reference: string;
  amountMinor: number;
}): Promise<{ statusCode: number; body: any }> {
  const raw = JSON.stringify({
    id: payload.id,
    type: payload.type,
    providerRef: `chk_${payload.id}`,
    amount: { amount: payload.amountMinor, currency: "NGN" },
    orderReference: payload.reference,
  });
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/webhooks/payments",
    payload: raw,
    headers: { "content-type": "application/json", "x-bachs-signature": sign(raw) },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

async function accountTotal(kind: string): Promise<number> {
  const res = await h.pool.query(
    `SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0) AS total
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = $1`,
    [kind],
  );
  return Number(res.rows[0].total);
}

/** Age the creator's earnings so they clear the 7-day hold. */
async function ageEarnings(): Promise<void> {
  await h.pool.query(
    `UPDATE ledger_entries SET created_at = now() - ($1 || ' days')::interval
      WHERE account_id IN (SELECT id FROM ledger_accounts WHERE kind = 'creator_earnings')`,
    [String(HOLD_DAYS + 1)],
  );
}

/** Buy a gift and settle it with a verified webhook, returning the reference. */
async function buyAndPay(giftId: string, quantity: number): Promise<void> {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/money/gifts/purchase",
    headers: { ...auth(buyer.token), "idempotency-key": `buy-${giftId}-${quantity}` },
    payload: { giftId, quantity, recipientId: creator.id },
  });
  expect(res.statusCode).toBe(202);
  const { reference, amountMinor } = res.json();
  const { statusCode, body } = await postWebhook({
    id: `evt_${reference}`,
    type: "collection.succeeded",
    reference,
    amountMinor,
  });
  expect(statusCode).toBe(202);
  expect(body.gift.applied).toBe(true);
}

describe("split payment, end to end", () => {
  beforeAll(async () => {
    payouts = new FakePayoutProvider();
    h = await createHarness(undefined, payouts);
    await resetDb(h.pool);
    buyer = await registerUser(h.app, "buyer");
    creator = await registerUser(h.app, "creator");
  });

  afterAll(async () => {
    await h.close();
  });

  it("credits the creator 70% when a gift is paid", async () => {
    // Fireworks is ₦3,000; the creator's 70% is ₦2,100.
    await buyAndPay("fireworks", 1);

    const balance = await creatorBalance(h.pool, creator.id, "NGN");
    expect(balance.lifetimeEarnedMinor).toBe(210_000);
    // Inside the hold window it is earned but not yet withdrawable.
    expect(balance.pendingMinor).toBe(210_000);
    expect(balance.availableMinor).toBe(0);
    expect(await accountTotal("platform_revenue")).toBe(90_000);
    expect(await accountTotal("creator_earnings")).toBe(210_000);
  });

  it("registers a bank account through the payout provider", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/destinations",
      headers: auth(creator.token),
      payload: { accountName: "Ada Creator", accountNumber: "0123456789", bankCode: "058", label: "Ada's bank" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("approved");
    expect(body.accountLast4).toBe("6789");
    // The provider was actually called.
    expect(payouts.destinations).toHaveLength(1);
    expect(payouts.destinations[0]!.accountNumber).toBe("0123456789");
  });

  it("makes the earnings withdrawable once the hold passes", async () => {
    await ageEarnings();
    const res = await h.app.inject({ method: "GET", url: "/v1/money/balance", headers: auth(creator.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().availableMinor).toBe(210_000);
  });

  it("requests a payout without marking it paid", async () => {
    const dest = await h.pool.query("SELECT id FROM payout_destinations WHERE user_id = $1", [creator.id]);
    const destinationId = dest.rows[0].id;

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/payouts",
      headers: { ...auth(creator.token), "idempotency-key": "wd-1" },
      payload: { destinationId, amountMinor: 210_000 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("requested");
    expect(payouts.payouts).toHaveLength(1);
    expect(payouts.payouts[0]!.amountMinor).toBe(210_000);

    // Not paid: no ledger debit has happened yet.
    expect(await accountTotal("creator_earnings")).toBe(210_000);
    // The provider accepted it and is processing; only a webhook can finish it.
    const row = await h.pool.query("SELECT status FROM payouts WHERE reference = $1", [res.json().reference]);
    expect(row.rows[0].status).toBe("processing");
  });

  it("reserves the requested amount so it cannot back a second payout", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/money/balance", headers: auth(creator.token) });
    expect(res.json().inFlightMinor).toBe(210_000);
    expect(res.json().availableMinor).toBe(0);
  });

  it("pays out only on a verified payout webhook, and debits the earnings", async () => {
    const payoutRow = await h.pool.query("SELECT reference FROM payouts WHERE user_id = $1", [creator.id]);
    const reference = payoutRow.rows[0].reference as string;

    const { statusCode, body } = await postWebhook({
      id: "evt_payout_paid_1",
      type: "payout.paid",
      reference,
      amountMinor: 210_000,
    });
    expect(statusCode).toBe(202);
    expect(body.payout.applied).toBe(true);

    const row = await h.pool.query("SELECT status, journal_id FROM payouts WHERE reference = $1", [reference]);
    expect(row.rows[0].status).toBe("paid");
    expect(row.rows[0].journal_id).not.toBeNull();

    // The creator's earnings liability has fallen to zero and cash left.
    expect(await accountTotal("creator_earnings")).toBe(0);
    expect(await accountTotal("creator_payouts")).toBe(210_000);
  });

  it("is idempotent: a redelivered payout webhook does not pay twice", async () => {
    const payoutRow = await h.pool.query("SELECT reference FROM payouts WHERE user_id = $1", [creator.id]);
    const reference = payoutRow.rows[0].reference as string;
    const before = await accountTotal("creator_payouts");

    const { body } = await postWebhook({
      id: "evt_payout_paid_1",
      type: "payout.paid",
      reference,
      amountMinor: 210_000,
    });
    // Same event id: deduplicated at the inbox before it reaches settlement.
    expect(body.status).toBe("duplicate_ignored");
    expect(await accountTotal("creator_payouts")).toBe(before);
  });

  it("reverses a clawed-back payout and restores the earnings", async () => {
    const payoutRow = await h.pool.query("SELECT reference FROM payouts WHERE user_id = $1", [creator.id]);
    const reference = payoutRow.rows[0].reference as string;

    const { body } = await postWebhook({
      id: "evt_payout_reversed_1",
      type: "payout.reversed",
      reference,
      amountMinor: 210_000,
    });
    expect(body.payout.applied).toBe(true);

    const row = await h.pool.query("SELECT status FROM payouts WHERE reference = $1", [reference]);
    expect(row.rows[0].status).toBe("reversed");
    expect(await accountTotal("creator_earnings")).toBe(210_000);
  });

  it("marks a failed payout without debiting, releasing the reservation", async () => {
    // A reversed payout re-holds the restored funds for another 7 days, which is
    // the conservative choice: money that came back has not "aged out" again.
    // Age them so this test starts from a withdrawable balance.
    await ageEarnings();
    const dest = await h.pool.query("SELECT id FROM payout_destinations WHERE user_id = $1", [creator.id]);
    const destinationId = dest.rows[0].id;

    const requested = await h.app.inject({
      method: "POST",
      url: "/v1/money/payouts",
      headers: { ...auth(creator.token), "idempotency-key": "wd-2" },
      payload: { destinationId, amountMinor: 210_000 },
    });
    expect(requested.statusCode).toBe(202);
    const reference = requested.json().reference as string;

    const { body } = await postWebhook({
      id: "evt_payout_failed_1",
      type: "payout.failed",
      reference,
      amountMinor: 210_000,
    });
    expect(body.payout.applied).toBe(true);

    const row = await h.pool.query("SELECT status FROM payouts WHERE reference = $1", [reference]);
    expect(row.rows[0].status).toBe("failed");
    // Nothing was debited, so the earnings are intact and available again.
    expect(await accountTotal("creator_earnings")).toBe(210_000);
    const balance = await creatorBalance(h.pool, creator.id, "NGN");
    expect(balance.availableMinor).toBe(210_000);
    expect(balance.inFlightMinor).toBe(0);
  });
});
