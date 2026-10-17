import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, registerUser, resetDb, auth, type Harness } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { RealtimeHub } from "../src/realtime.js";
import { createPaymentProvider } from "../src/payments/provider.js";
import { createPayoutProvider } from "../src/payments/payouts.js";
import { LogMailer } from "../src/modules/mailer.js";
import { loadConfig } from "../src/config.js";

const STUB_SECRET = "test-webhook-secret";

// The wallet is off by default, so its routes only exist under this config.
const walletConfig = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://vibe:vibe@localhost:5432/vibe",
  WALLET_ENABLED: "true",
  SESSION_SECRET: "test-session-secret-value",
  PAYMENTS_WEBHOOK_SECRET: "test-webhook-secret",
});

function sign(rawBody: string): string {
  return createHmac("sha256", STUB_SECRET).update(rawBody).digest("hex");
}

function webhook(payload: { id: string; type: string; reference: string; amountMinor: number }) {
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
  // The wallet is off in the default config, so it needs its own app with the
  // flag on. It shares the pool-backed database.
  if (!wallet) {
    const pool = createPool(process.env.DATABASE_URL ?? "postgres://vibe:vibe@localhost:5432/vibe");
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

describe("Vibe Yens wallet is gated", () => {
  it("returns 404 when WALLET_ENABLED is off", async () => {
    const u = await registerUser(h.app, "gateoff");
    const res = await h.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(u.token) });
    expect(res.statusCode).toBe(404);
  });
});

describe("Vibe Yens wallet", () => {
  it("starts at zero and only credits after a verified webhook", async () => {
    const u = await registerUser(wallet.app, "yenuser");

    const start = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(u.token) });
    expect(start.statusCode).toBe(200);
    expect(start.json().balanceMinor).toBe(0);

    const created = await wallet.app.inject({
      method: "POST",
      url: "/v1/wallet/topups",
      headers: { ...auth(u.token), "idempotency-key": "topup-1" },
      payload: { amountMinor: 5_000_00 },
    });
    expect(created.statusCode).toBe(202);
    const { reference } = created.json();
    expect(reference.startsWith("WALLET-")).toBe(true);

    // Still zero: a pending top-up is not money.
    const before = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(u.token) });
    expect(before.json().balanceMinor).toBe(0);

    const hook = webhook({ id: "evt_topup_1", type: "payment_succeeded", reference, amountMinor: 5_000_00 });
    const settled = await wallet.app.inject({ method: "POST", url: "/v1/webhooks/payments", payload: hook.raw, headers: hook.headers });
    expect(settled.statusCode).toBe(202);

    const after = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(u.token) });
    expect(after.json().balanceMinor).toBe(5_000_00);
  });

  it("sends to a friend and moves the balance", async () => {
    const sender = await registerUser(wallet.app, "sender1");
    const recipient = await registerUser(wallet.app, "recip1");

    const created = await wallet.app.inject({
      method: "POST",
      url: "/v1/wallet/topups",
      headers: { ...auth(sender.token), "idempotency-key": "topup-2" },
      payload: { amountMinor: 3_000_00 },
    });
    const { reference } = created.json();
    const hook = webhook({ id: "evt_topup_2", type: "payment_succeeded", reference, amountMinor: 3_000_00 });
    await wallet.app.inject({ method: "POST", url: "/v1/webhooks/payments", payload: hook.raw, headers: hook.headers });

    const sent = await wallet.app.inject({
      method: "POST",
      url: "/v1/wallet/send",
      headers: { ...auth(sender.token), "idempotency-key": "send-1" },
      payload: { recipientId: recipient.id, amountMinor: 1_250_00, note: "lunch" },
    });
    expect(sent.statusCode).toBe(201);

    const sBal = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(sender.token) });
    const rBal = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(recipient.token) });
    expect(sBal.json().balanceMinor).toBe(3_000_00 - 1_250_00);
    expect(rBal.json().balanceMinor).toBe(1_250_00);

    // The recipient is told, and the send is recorded as an analytics event
    // (fire-and-forget, so poll briefly rather than read immediately).
    const notes = await wallet.pool.query(
      `SELECT type FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [recipient.id],
    );
    expect(notes.rows.map((r) => r.type)).toContain("wallet.received");
    let sentEvents: string[] = [];
    for (let i = 0; i < 20 && !sentEvents.includes("wallet_sent"); i += 1) {
      const events = await wallet.pool.query(`SELECT name FROM analytics_events WHERE user_id = $1`, [sender.id]);
      sentEvents = events.rows.map((r) => r.name);
      if (!sentEvents.includes("wallet_sent")) await new Promise((r) => setTimeout(r, 50));
    }
    expect(sentEvents).toContain("wallet_sent");

    // A retry with the same idempotency key does not double-send.
    const retry = await wallet.app.inject({
      method: "POST",
      url: "/v1/wallet/send",
      headers: { ...auth(sender.token), "idempotency-key": "send-1" },
      payload: { recipientId: recipient.id, amountMinor: 1_250_00, note: "lunch" },
    });
    expect(retry.statusCode).toBe(201);
    const sBal2 = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(sender.token) });
    expect(sBal2.json().balanceMinor).toBe(3_000_00 - 1_250_00);
  });

  it("refuses to send more than the balance", async () => {
    const sender = await registerUser(wallet.app, "brokesender");
    const recipient = await registerUser(wallet.app, "recip2");
    const res = await wallet.app.inject({
      method: "POST",
      url: "/v1/wallet/send",
      headers: { ...auth(sender.token), "idempotency-key": "send-broke" },
      payload: { recipientId: recipient.id, amountMinor: 500_00 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to send to yourself", async () => {
    const u = await registerUser(wallet.app, "selfsend");
    const res = await wallet.app.inject({
      method: "POST",
      url: "/v1/wallet/send",
      headers: { ...auth(u.token), "idempotency-key": "send-self" },
      payload: { recipientId: u.id, amountMinor: 100_00 },
    });
    expect(res.statusCode).toBe(400);
  });
});
