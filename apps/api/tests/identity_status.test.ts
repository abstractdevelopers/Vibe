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

// Cosmetics cost Vibe Yens, so the money tests run against an app with the
// wallet on — same pool, same database, same webhook path as production.
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

let h: Harness;
let wallet: Harness;

async function fund(app: Harness, token: string, amountMinor: number, key: string): Promise<void> {
  const created = await app.app.inject({
    method: "POST",
    url: "/v1/wallet/topups",
    headers: { ...auth(token), "idempotency-key": key },
    payload: { amountMinor },
  });
  const { reference } = created.json();
  const raw = JSON.stringify({
    id: `evt_${key}`,
    type: "payment_succeeded",
    providerRef: `chk_${key}`,
    amount: { amount: amountMinor, currency: "NGN" },
    orderReference: reference,
  });
  await app.app.inject({
    method: "POST",
    url: "/v1/webhooks/payments",
    payload: raw,
    headers: { "content-type": "application/json", "x-bachs-signature": sign(raw) },
  });
}

async function balance(app: Harness, token: string): Promise<number> {
  const res = await app.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(token) });
  return res.json().balanceMinor as number;
}

/** Post enough times to clear the Warrior bar (3 activity this week). */
async function post(app: Harness, token: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await app.app.inject({
      method: "POST", url: "/v1/posts", headers: auth(token),
      payload: { body: `hello ${i}` },
    });
  }
}
beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
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

describe("standing", () => {
  it("gives a fresh user no title and a nudge", async () => {
    const me = await registerUser(h.app, "fresh");
    const res = await h.app.inject({ method: "GET", url: "/v1/me/standing", headers: auth(me.token) });
    expect(res.statusCode).toBe(200);
    const s = res.json().standing;
    expect(s.title).toBeNull();
    expect(s.activity).toBe(0);
    expect(s.reason).toMatch(/this week/i);
  });

  it("earns a title once the user shows up", async () => {
    const me = await registerUser(h.app, "worker");
    await post(h, me.token, 3);
    const res = await h.app.inject({ method: "GET", url: "/v1/me/standing", headers: auth(me.token) });
    const s = res.json().standing;
    expect(s.activity).toBe(3);
    expect(s.title).toBe("Vibe Warrior");
    expect(s.rank).toBe("warrior");
  });

  it("names a single King for the most active person", async () => {
    const king = await registerUser(h.app, "king");
    const other = await registerUser(h.app, "other");
    await post(h, king.token, 60);
    await post(h, other.token, 5);

    const kingRes = await h.app.inject({ method: "GET", url: "/v1/me/standing", headers: auth(king.token) });
    expect(kingRes.json().standing.title).toBe("Vibe King");
    expect(kingRes.json().standing.rank).toBe("king");

    // The next person down cannot also be King; they take the next tier.
    const otherRes = await h.app.inject({ method: "GET", url: "/v1/me/standing", headers: auth(other.token) });
    expect(otherRes.json().standing.title).not.toBe("Vibe King");
  });

  it("lists the week's movers on the status board", async () => {
    const a = await registerUser(h.app, "mover");
    await post(h, a.token, 4);
    const res = await h.app.inject({ method: "GET", url: "/v1/status/board", headers: auth(a.token) });
    expect(res.statusCode).toBe(200);
    const board = res.json().board as Array<{ user: { handle: string }; activity: number }>;
    expect(board[0]?.user.handle).toBe("mover");
    expect(board[0]?.activity).toBe(4);
  });
});

describe("cosmetics", () => {
  it("lists the catalogue with nothing owned for a new user", async () => {
    const me = await registerUser(wallet.app, "shopper");
    const res = await wallet.app.inject({ method: "GET", url: "/v1/cosmetics", headers: auth(me.token) });
    expect(res.statusCode).toBe(200);
    const list = res.json().cosmetics as Array<{ id: string; owned: boolean }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => !c.owned)).toBe(true);
  });

  it("buys a cosmetic with Vibe Yens and lets the buyer wear it", async () => {
    const me = await registerUser(wallet.app, "buyer");
    await fund(wallet, me.token, 4_000_00, "c1");
    const before = await balance(wallet, me.token);

    const buy = await wallet.app.inject({ method: "POST", url: "/v1/cosmetics/frame-gold/buy", headers: auth(me.token), payload: {} });
    expect(buy.statusCode).toBe(201);
    expect(buy.json().owned).toContain("frame-gold");

    // The price left the wallet, exactly.
    expect(await balance(wallet, me.token)).toBe(before - 250_000);

    const wear = await wallet.app.inject({
      method: "POST", url: "/v1/cosmetics/wear",
      headers: auth(me.token), payload: { kind: "frame", cosmeticId: "frame-gold" },
    });
    expect(wear.statusCode).toBe(200);
    expect(wear.json().worn.frame).toBe("frame-gold");

    // Taking it off again leaves the frame slot empty.
    const off = await wallet.app.inject({
      method: "POST", url: "/v1/cosmetics/wear",
      headers: auth(me.token), payload: { kind: "frame", cosmeticId: null },
    });
    expect(off.json().worn.frame).toBeNull();
  });

  it("refuses to buy the same cosmetic twice", async () => {
    const me = await registerUser(wallet.app, "twice");
    await fund(wallet, me.token, 4_000_00, "c2");
    const first = await wallet.app.inject({ method: "POST", url: "/v1/cosmetics/frame-ember/buy", headers: auth(me.token), payload: {} });
    expect(first.statusCode).toBe(201);
    const second = await wallet.app.inject({ method: "POST", url: "/v1/cosmetics/frame-ember/buy", headers: auth(me.token), payload: {} });
    expect(second.statusCode).toBe(400);
  });

  it("refuses a purchase the wallet cannot cover", async () => {
    const me = await registerUser(wallet.app, "broke");
    await fund(wallet, me.token, 1_000_00, "c3"); // N1,000, under the N1,500 Royal outfit
    const res = await wallet.app.inject({ method: "POST", url: "/v1/cosmetics/outfit-royal/buy", headers: auth(me.token), payload: {} });
    expect(res.statusCode).toBe(400);
    // Nothing was spent on the failed buy.
    expect(await balance(wallet, me.token)).toBe(1_000_00);
  });

  it("refuses to wear something the user does not own", async () => {
    const me = await registerUser(wallet.app, "window");
    const res = await wallet.app.inject({
      method: "POST", url: "/v1/cosmetics/wear",
      headers: auth(me.token), payload: { kind: "outfit", cosmeticId: "outfit-royal" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a cosmetic of the wrong kind for the slot", async () => {
    const me = await registerUser(wallet.app, "mixed");
    await fund(wallet, me.token, 4_000_00, "c4");
    await wallet.app.inject({ method: "POST", url: "/v1/cosmetics/outfit-ankara/buy", headers: auth(me.token), payload: {} });
    const res = await wallet.app.inject({
      method: "POST", url: "/v1/cosmetics/wear",
      headers: auth(me.token), payload: { kind: "frame", cosmeticId: "outfit-ankara" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not sell cosmetics when the wallet is off", async () => {
    const me = await registerUser(h.app, "nowallet");
    const res = await h.app.inject({ method: "POST", url: "/v1/cosmetics/frame-ember/buy", headers: auth(me.token), payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
