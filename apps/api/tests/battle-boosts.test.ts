import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { RealtimeHub } from "../src/realtime.js";
import { createPaymentProvider } from "../src/payments/provider.js";
import { createPayoutProvider } from "../src/payments/payouts.js";
import { LogMailer } from "../src/modules/mailer.js";
import { loadConfig } from "../src/config.js";
import { createHmac } from "node:crypto";

/**
 * A battle boost is the only paid way to move a score, and it is a wallet
 * debit, so it gets the same treatment as any other money path: it must be
 * priced from the server's catalogue, capped per person per kind, and booked
 * to the ledger exactly once.
 */

const STUB_SECRET = "test-webhook-secret";

const walletConfig = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://vibe:vibe@localhost:5432/vibe",
  WALLET_ENABLED: "true",
  SESSION_SECRET: "test-session-secret-value",
  PAYMENTS_WEBHOOK_SECRET: "test-webhook-secret",
});

function sign(raw: string): string {
  return createHmac("sha256", STUB_SECRET).update(raw).digest("hex");
}

let h: Harness;
let wallet: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
  // A boost is a wallet debit, so it needs an app built with the wallet on.
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

async function fund(token: string, amountMinor: number, key: string): Promise<void> {
  const created = await wallet.app.inject({
    method: "POST", url: "/v1/wallet/topups",
    headers: { ...auth(token), "idempotency-key": key },
    payload: { amountMinor },
  });
  const { reference } = created.json();
  const raw = JSON.stringify({
    id: `evt_${key}`, type: "payment_succeeded", providerRef: `chk_${key}`,
    amount: { amount: amountMinor, currency: "NGN" }, orderReference: reference,
  });
  await wallet.app.inject({
    method: "POST", url: "/v1/webhooks/payments", payload: raw,
    headers: { "content-type": "application/json", "x-bachs-signature": sign(raw) },
  });
}

async function balance(token: string): Promise<number> {
  const res = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(token) });
  return res.json().balanceMinor as number;
}

async function openBattle(token: string, title = "Which is better?"): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: "/v1/battles", headers: auth(token),
    payload: { title, sideA: "Jollof", sideB: "Fried rice" },
  });
  expect(res.statusCode).toBe(201);
  return (res.json().battle?.id ?? res.json().id) as string;
}

describe("battle boosts", () => {
  it("debits the catalogue price and books one ledger entry", async () => {
    const host = await registerUser(wallet.app, "boosthost");
    const fan = await registerUser(wallet.app, "boostfan");
    await fund(fan.token, 100_000, "bf1");
    const battleId = await openBattle(host.token);

    const before = await balance(fan.token);
    const res = await wallet.app.inject({
      method: "POST", url: `/v1/battles/${battleId}/boosts`, headers: auth(fan.token),
      payload: { side: "a", kind: "jab" },
    });
    expect(res.statusCode).toBe(201);

    const after = await balance(fan.token);
    expect(before - after).toBe(5_000);

    const journals = await h.pool.query(
      "SELECT count(*)::int AS n FROM ledger_journals WHERE kind = 'battle_boost'",
    );
    expect(journals.rows[0].n).toBe(1);
  });

  it("refuses a boost the wallet cannot cover, and books nothing", async () => {
    const host = await registerUser(wallet.app, "poorhost");
    const fan = await registerUser(wallet.app, "poorfan");
    // The top-up minimum is ₦100, so fund that and then spend it down to below
    // a Hook (₦150). A boost the balance cannot cover must book nothing.
    await fund(fan.token, 10_000, "pf1");
    expect(await balance(fan.token)).toBe(10_000);
    const battleId = await openBattle(host.token);

    const res = await wallet.app.inject({
      method: "POST", url: `/v1/battles/${battleId}/boosts`, headers: auth(fan.token),
      payload: { side: "a", kind: "hook" },
    });
    expect(res.statusCode).toBe(400);

    const journals = await wallet.pool.query(
      "SELECT count(*)::int AS n FROM ledger_journals WHERE kind = 'battle_boost'",
    );
    expect(journals.rows[0].n).toBe(0);
    expect(await balance(fan.token)).toBe(10_000);
  });

  it("caps one person's boosts per kind, so a wallet cannot buy the score", async () => {
    const host = await registerUser(wallet.app, "caphost");
    const fan = await registerUser(wallet.app, "capfan");
    await fund(fan.token, 500_000, "cf1");
    const battleId = await openBattle(host.token);

    // A "jab" is capped at 6 per person per battle.
    for (let i = 0; i < 6; i += 1) {
      const res = await wallet.app.inject({
        method: "POST", url: `/v1/battles/${battleId}/boosts`, headers: auth(fan.token),
        payload: { side: "a", kind: "jab" },
      });
      expect(res.statusCode).toBe(201);
    }
    const over = await wallet.app.inject({
      method: "POST", url: `/v1/battles/${battleId}/boosts`, headers: auth(fan.token),
      payload: { side: "a", kind: "jab" },
    });
    expect(over.statusCode).toBe(400);

    const rows = await h.pool.query(
      "SELECT count(*)::int AS n FROM battle_boosts WHERE battle_id = $1 AND user_id = $2 AND kind = 'jab'",
      [battleId, fan.id],
    );
    expect(rows.rows[0].n).toBe(6);
  });

  it("does not take money for a battle that has closed", async () => {
    const host = await registerUser(wallet.app, "closedhost");
    const fan = await registerUser(wallet.app, "closedfan");
    await fund(fan.token, 100_000, "cl1");
    const battleId = await openBattle(host.token);
    await h.pool.query("UPDATE battles SET status = 'closed' WHERE id = $1", [battleId]);

    const res = await wallet.app.inject({
      method: "POST", url: `/v1/battles/${battleId}/boosts`, headers: auth(fan.token),
      payload: { side: "a", kind: "jab" },
    });
    expect(res.statusCode).toBe(400);
    expect(await balance(fan.token)).toBe(100_000);
  });
});
