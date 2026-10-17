import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, registerUser, resetDb, auth, type Harness, type TestUser } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { RealtimeHub } from "../src/realtime.js";
import { createPaymentProvider } from "../src/payments/provider.js";
import { createPayoutProvider } from "../src/payments/payouts.js";
import { LogMailer } from "../src/modules/mailer.js";
import { loadConfig } from "../src/config.js";

/**
 * Money settlement, proven through the ledger.
 *
 * The question this answers is the one a live run left open: a processed
 * webhook must produce real, balanced books, not just a `processed_at`. Each
 * path — paid gift, live ticket, Vibe Yens top-up — is driven end to end and
 * then checked against `ledger_journals` / `ledger_entries`, the tables an
 * operator reconciles against. The wallet is enabled here because the platform
 * now runs with it on.
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
let wallet: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
  // The platform runs with the wallet on, so the money-flow test does too.
  if (!wallet) {
    const walletConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://vibe:vibe@localhost:5432/vibe",
      WALLET_ENABLED: "true",
      SESSION_SECRET: "test-session-secret-value",
      PAYMENTS_WEBHOOK_SECRET: "test-webhook-secret",
    });
    const pool = createPool(walletConfig.DATABASE_URL);
    const app = await buildApp({
      pool,
      config: walletConfig,
      hub: new RealtimeHub(),
      provider: createPaymentProvider("stub", walletConfig.PAYMENTS_WEBHOOK_SECRET),
      payouts: createPayoutProvider("disabled"),
      mailer: new LogMailer(),
    });
    await app.ready();
    wallet = { app, pool, close: async () => { await app.close(); await pool.end(); } };
  }
});

afterAll(async () => {
  if (h) await h.close();
  if (wallet) await wallet.close();
});

async function postWebhook(payload: { id: string; type: string; reference: string; amountMinor: number }) {
  const { raw, headers } = webhookPayload(payload);
  return h.app.inject({ method: "POST", url: "/v1/webhooks/payments", payload: raw, headers });
}

async function journalCount(kind: string): Promise<number> {
  const r = await h.pool.query("SELECT count(*)::int AS n FROM ledger_journals WHERE kind = $1", [kind]);
  return r.rows[0].n as number;
}

async function accountTotal(kind: string): Promise<number> {
  const r = await h.pool.query(
    `SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0) AS total
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.kind = $1`,
    [kind],
  );
  return Number(r.rows[0].total);
}

async function makeAdmin(user: TestUser): Promise<void> {
  await h.pool.query("UPDATE users SET is_admin = true WHERE id = $1", [user.id]);
}

describe("a paid gift writes a balanced journal", () => {
  it("credits the creator 70% and books 30% revenue", async () => {
    const buyer = await registerUser(h.app, "gfbuyer");
    const creator = await registerUser(h.app, "gfcreator");

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/money/gifts/purchase",
      headers: { ...auth(buyer.token), "idempotency-key": "gf-1" },
      payload: { giftId: "fireworks", quantity: 1, recipientId: creator.id },
    });
    expect(res.statusCode).toBe(202);
    const { reference, amountMinor } = res.json();
    expect(amountMinor).toBe(300_000); // ₦3,000

    const hook = await postWebhook({ id: "evt_gf_1", type: "collection.succeeded", reference, amountMinor });
    expect(hook.statusCode).toBe(202);
    expect(hook.json().gift.applied).toBe(true);

    expect(await journalCount("gift_purchase")).toBe(1);
    expect(await accountTotal("platform_revenue")).toBe(90_000); // 30%
    expect(await accountTotal("creator_earnings")).toBe(210_000); // 70%

    // A redelivery of the same event is deduplicated and writes nothing new.
    await postWebhook({ id: "evt_gf_1", type: "collection.succeeded", reference, amountMinor });
    expect(await journalCount("gift_purchase")).toBe(1);
  });
});

describe("a live ticket writes a ticket_purchase journal", () => {
  it("grants entry and books the 70/30 split to the host", async () => {
    const host = await registerUser(h.app, "tkhost");
    const guest = await registerUser(h.app, "tkguest");

    const room = await h.app.inject({
      method: "POST",
      url: "/v1/activities/rooms",
      headers: auth(host.token),
      payload: {
        kind: "listen",
        title: "Ticketed listening party",
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        durationMinutes: 60,
        visibility: "public",
        ticketPriceMinor: 100_000, // ₦1,000
      },
    });
    expect(room.statusCode).toBe(201);
    const roomId = room.json().room.id;

    const ticket = await h.app.inject({
      method: "POST",
      url: `/v1/activities/rooms/${roomId}/ticket`,
      headers: { ...auth(guest.token), "idempotency-key": "tk-1" },
      payload: {},
    });
    expect(ticket.statusCode).toBe(202);
    const { reference, amountMinor } = ticket.json();
    expect(amountMinor).toBe(100_000);

    const hook = await postWebhook({ id: "evt_tk_1", type: "collection.succeeded", reference, amountMinor });
    expect(hook.statusCode).toBe(202);
    expect(hook.json().ticket.applied).toBe(true);

    expect(await journalCount("ticket_purchase")).toBe(1);
    expect(await accountTotal("platform_revenue")).toBe(30_000);
    expect(await accountTotal("creator_earnings")).toBe(70_000);

    const granted = await h.app.inject({
      method: "GET",
      url: `/v1/activities/rooms/${roomId}/ticket`,
      headers: auth(guest.token),
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().ticket.status).toBe("granted");
  });
});

describe("a Vibe Yens top-up writes a wallet_topup journal", () => {
  it("credits the wallet only after the verified webhook", async () => {
    const user = await registerUser(h.app, "topupuser");

    const start = await wallet.app.inject({ method: "POST", url: "/v1/wallet/topups", headers: { ...auth(user.token), "idempotency-key": "tu-1" }, payload: { amountMinor: 500_000 } });
    expect(start.statusCode).toBe(202);
    const { reference, amountMinor } = start.json();

    const before = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(user.token) });
    expect(before.json().balanceMinor).toBe(0);

    const hook = await postWebhook({ id: "evt_tu_1", type: "collection.succeeded", reference, amountMinor });
    expect(hook.statusCode).toBe(202);
    expect(hook.json().wallet.applied).toBe(true);

    expect(await journalCount("wallet_topup")).toBe(1);

    const after = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(user.token) });
    expect(after.json().balanceMinor).toBe(500_000);
  });

  it("moves balance on a send and books a wallet_transfer journal", async () => {
    const sender = await registerUser(h.app, "sndsender");
    const recipient = await registerUser(h.app, "sndrecipient");

    const topup = await wallet.app.inject({ method: "POST", url: "/v1/wallet/topups", headers: { ...auth(sender.token), "idempotency-key": "st-1" }, payload: { amountMinor: 100_000 } });
    const { reference, amountMinor } = topup.json();
    await postWebhook({ id: "evt_st_1", type: "collection.succeeded", reference, amountMinor });

    const send = await wallet.app.inject({
      method: "POST",
      url: "/v1/wallet/send",
      headers: { ...auth(sender.token), "idempotency-key": "send-1" },
      payload: { recipientId: recipient.id, amountMinor: 40_000 },
    });
    expect(send.statusCode).toBe(201);

    expect(await journalCount("wallet_transfer")).toBe(1);
    const senderBalance = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(sender.token) });
    const recipientBalance = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(recipient.token) });
    expect(senderBalance.json().balanceMinor).toBe(60_000);
    expect(recipientBalance.json().balanceMinor).toBe(40_000);
  });
});

describe("a paid order moves to paid with no ledger journal", () => {
  it("transitions on the webhook and records the order", async () => {
    const merchant = await registerUser(h.app, "ordmerchant");
    const buyer = await registerUser(h.app, "ordbuyer");
    await makeAdmin(merchant);

    const opened = await h.app.inject({ method: "POST", url: "/v1/merchants", headers: auth(merchant.token), payload: { name: "E2E Shop", category: "retail" } });
    const merchantId = opened.json().id;
    await h.app.inject({ method: "POST", url: `/v1/admin/merchants/${merchantId}/verify`, headers: auth(merchant.token), payload: { verificationStatus: "verified" } });
    const product = await h.app.inject({ method: "POST", url: `/v1/merchants/${merchantId}/products`, headers: auth(merchant.token), payload: { name: "Ankara", priceMinor: 500_000, currency: "NGN", status: "active" } });
    expect(product.statusCode).toBe(201);
    const productId = product.json().id;

    const order = await h.app.inject({ method: "POST", url: "/v1/orders", headers: { ...auth(buyer.token), "idempotency-key": "ord-1" }, payload: { merchantId, items: [{ productId, quantity: 1 }] } });
    expect(order.statusCode).toBe(201);
    const orderId = order.json().id;

    const checkout = await h.app.inject({ method: "POST", url: `/v1/orders/${orderId}/checkout`, headers: { ...auth(buyer.token), "idempotency-key": "ord-checkout-1" }, payload: {} });
    expect(checkout.statusCode).toBe(202);

    const detail = await h.app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: auth(buyer.token) });
    const reference = detail.json().reference;

    const hook = await postWebhook({ id: "evt_ord_1", type: "collection.succeeded", reference, amountMinor: 500_000 });
    expect(hook.statusCode).toBe(202);

    const paid = await h.app.inject({ method: "GET", url: `/v1/orders/${orderId}`, headers: auth(buyer.token) });
    expect(paid.json().status).toBe("paid");

    // Orders are not on the ledger yet; they must not invent a journal.
    expect(await journalCount("gift_purchase")).toBe(0);
    const journals = await h.pool.query("SELECT count(*)::int AS n FROM ledger_journals");
    expect(journals.rows[0].n).toBe(0);
  });
});
