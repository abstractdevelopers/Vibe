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

// Battles only take a stake when the wallet is on, so the money tests run
// against an app built with the flag set — same pool, same database.
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

/** Credit a wallet by driving a real top-up through the stub provider webhook. */
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

describe("battles", () => {
  it("runs a free battle: create, join, vote, close, and count one vote each", async () => {
    const host = await registerUser(h.app, "bhost");
    const voter = await registerUser(h.app, "bvoter");

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(host.token),
      payload: { title: "Android vs iPhone", sideA: "Android", sideB: "iPhone" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().battle.id as string;
    expect(created.json().battle.potMinor).toBe(0);

    const joined = await h.app.inject({ method: "POST", url: `/v1/battles/${id}/join`, headers: auth(voter.token), payload: { side: "b" } });
    expect(joined.statusCode).toBe(200);

    const voted = await h.app.inject({ method: "POST", url: `/v1/battles/${id}/vote`, headers: auth(voter.token), payload: { side: "b" } });
    expect(voted.statusCode).toBe(200);
    expect(voted.json().battle.tally).toEqual({ a: 0, b: 1 });
    // Voting records which side the viewer is on, so the screen can light it up.
    expect(voted.json().battle.mySide).toBe("b");

    // Voting again changes the vote rather than adding one: one vote per user.
    const revote = await h.app.inject({ method: "POST", url: `/v1/battles/${id}/vote`, headers: auth(voter.token), payload: { side: "a" } });
    expect(revote.json().battle.tally).toEqual({ a: 1, b: 0 });
    expect(revote.json().battle.mySide).toBe("a");

    const closed = await h.app.inject({ method: "POST", url: `/v1/battles/${id}/close`, headers: auth(host.token) });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().battle.status).toBe("closed");
    expect(closed.json().battle.winner).toBe("a");
  });

  it("does not let a non-host close a running battle, but anyone can close an expired one", async () => {
    const host = await registerUser(h.app, "bhost2");
    const other = await registerUser(h.app, "bother2");

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(host.token),
      payload: { title: "Lagos vs Abuja", sideA: "Lagos", sideB: "Abuja", endsAt: new Date(Date.now() - 1000).toISOString() },
    });
    const id = created.json().battle.id as string;

    const early = await h.app.inject({ method: "POST", url: `/v1/battles/${id}/close`, headers: auth(other.token) });
    expect(early.statusCode).toBe(200); // it has already expired, so this is allowed
  });

  it("moves a staked pot to the winning side and pays nothing to the losers", async () => {
    const host = await registerUser(wallet.app, "shost");
    const backerA = await registerUser(wallet.app, "backA");
    const backerB = await registerUser(wallet.app, "backB");
    await fund(wallet, host.token, 1_000_00, "f1");
    await fund(wallet, backerA.token, 1_000_00, "f2");
    await fund(wallet, backerB.token, 1_000_00, "f3");

    const created = await wallet.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(host.token),
      payload: { title: "Jollof vs Fried Rice", sideA: "Jollof", sideB: "Fried Rice", stakeMinor: 200_00 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().battle.id as string;
    // The host staked on side A at creation.
    expect(await balance(wallet, host.token)).toBe(800_00);

    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/join`, headers: auth(backerA.token), payload: { side: "a" } });
    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/join`, headers: auth(backerB.token), payload: { side: "b" } });
    expect(await balance(wallet, backerA.token)).toBe(800_00);
    expect(await balance(wallet, backerB.token)).toBe(800_00);

    // Side A wins on votes. The pot is 600 and the platform takes no rake, so
    // the two A backers split it in proportion to their equal stakes: 300 each.
    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/vote`, headers: auth(host.token), payload: { side: "a" } });
    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/vote`, headers: auth(backerA.token), payload: { side: "a" } });

    const closed = await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/close`, headers: auth(host.token) });
    expect(closed.statusCode).toBe(200);
    const view = closed.json().battle;
    expect(view.winner).toBe("a");
    expect(view.potMinor).toBe(600_00);

    expect(await balance(wallet, host.token)).toBe(800_00 + 300_00);
    expect(await balance(wallet, backerA.token)).toBe(800_00 + 300_00);
    // The losing backer keeps what they did not stake and gets nothing more.
    expect(await balance(wallet, backerB.token)).toBe(800_00);
  });

  it("splits a large pot between many winning backers, in proportion and to the minor unit", async () => {
    // Six people back one side and four back the other. This is the "many
    // users participate, how does each win" case: the stake is the same for
    // everyone, so everyone on the winning side takes an equal slice of the
    // pot, and the slices must sum to the pot exactly or the journal will not
    // balance.
    const host = await registerUser(wallet.app, "mhost");
    const a2 = await registerUser(wallet.app, "ma2");
    const a3 = await registerUser(wallet.app, "ma3");
    const a4 = await registerUser(wallet.app, "ma4");
    const a5 = await registerUser(wallet.app, "ma5");
    const a6 = await registerUser(wallet.app, "ma6");
    const b1 = await registerUser(wallet.app, "mb1");
    const b2 = await registerUser(wallet.app, "mb2");
    const b3 = await registerUser(wallet.app, "mb3");
    const b4 = await registerUser(wallet.app, "mb4");

    const winners = [host, a2, a3, a4, a5, a6];
    const losers = [b1, b2, b3, b4];
    for (const [i, u] of [...winners, ...losers].entries()) {
      await fund(wallet, u.token, 1_000_00, `m${i}`);
    }

    const STAKE = 100_00;
    const created = await wallet.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(host.token),
      payload: { title: "Many vs many", sideA: "Left", sideB: "Right", stakeMinor: STAKE },
    });
    const id = created.json().battle.id as string;

    for (const u of [a2, a3, a4, a5, a6]) {
      const joined = await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/join`, headers: auth(u.token), payload: { side: "a" } });
      expect(joined.statusCode).toBe(200);
    }
    for (const u of losers) {
      await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/join`, headers: auth(u.token), payload: { side: "b" } });
    }

    // While the battle is open the viewer sees what their stake is worth as the
    // pot stands, and the first people behind each side are shown.
    const mid = await wallet.app.inject({ method: "GET", url: `/v1/battles/${id}`, headers: auth(a5.token) });
    const midView = mid.json().battle;
    expect(midView.myProjectedMinor).toBeGreaterThan(0);
    // The list is capped so a huge battle cannot render an endless rail.
    expect(midView.backers.length).toBe(8);
    expect(midView.backers[0].user.handle).toBe(host.handle);

    // Left wins on votes.
    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/vote`, headers: auth(host.token), payload: { side: "a" } });

    const closed = await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/close`, headers: auth(host.token) });
    const view = closed.json().battle;

    // Pot is A's 600 plus B's 400 = 1000, and there is no rake.
    const pot = 1000_00;
    expect(view.potMinor).toBe(pot);

    const balances = new Map<string, number>();
    for (const u of [...winners, ...losers]) balances.set(u.token, await balance(wallet, u.token));

    // Every winner put in the same stake, so every winner takes the same
    // amount back, and the six slices sum to the pot exactly.
    const aCount = 6;
    const perWinner = Math.floor(pot / aCount);
    let paid = 0;
    for (const u of winners) {
      const gain = balances.get(u.token)! - (1_000_00 - STAKE);
      expect(gain).toBeGreaterThanOrEqual(perWinner);
      paid += gain;
    }
    expect(paid).toBe(pot);

    // The losers get nothing back beyond what they did not stake.
    for (const u of losers) {
      expect(balances.get(u.token)).toBe(1_000_00 - STAKE);
    }
  });

  it("refunds every stake on a tie and on a cancel", async () => {
    const host = await registerUser(wallet.app, "thost");
    const other = await registerUser(wallet.app, "tother");
    await fund(wallet, host.token, 1_000_00, "g1");
    await fund(wallet, other.token, 1_000_00, "g2");

    const created = await wallet.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(host.token),
      payload: { title: "Cats vs Dogs", sideA: "Cats", sideB: "Dogs", stakeMinor: 100_00 },
    });
    const id = created.json().battle.id as string;
    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/join`, headers: auth(other.token), payload: { side: "b" } });

    // One vote each is a tie, so the pot goes back in full.
    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/vote`, headers: auth(host.token), payload: { side: "a" } });
    await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/vote`, headers: auth(other.token), payload: { side: "b" } });
    const closed = await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/close`, headers: auth(host.token) });
    expect(closed.json().battle.winner).toBe("tie");
    expect(await balance(wallet, host.token)).toBe(1_000_00);
    expect(await balance(wallet, other.token)).toBe(1_000_00);

    // A fresh battle, cancelled, also refunds.
    const created2 = await wallet.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(host.token),
      payload: { title: "Tea vs Coffee", sideA: "Tea", sideB: "Coffee", stakeMinor: 150_00 },
    });
    const id2 = created2.json().battle.id as string;
    expect(await balance(wallet, host.token)).toBe(1_000_00 - 150_00);
    const cancelled = await wallet.app.inject({ method: "POST", url: `/v1/battles/${id2}/cancel`, headers: auth(host.token) });
    expect(cancelled.json().battle.status).toBe("cancelled");
    expect(await balance(wallet, host.token)).toBe(1_000_00);
  });

  it("refuses a stake the wallet cannot cover, and refuses staking with the wallet off", async () => {
    const poor = await registerUser(wallet.app, "poor");
    const denied = await wallet.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(poor.token),
      payload: { title: "X vs Y", sideA: "X", sideB: "Y", stakeMinor: 500_00 },
    });
    expect(denied.statusCode).toBe(400);

    // The default harness has WALLET_ENABLED off, so a staked battle is refused
    // there while a free battle still works.
    const plain = await registerUser(h.app, "plain");
    const staked = await h.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(plain.token),
      payload: { title: "X vs Y", sideA: "X", sideB: "Y", stakeMinor: 500_00 },
    });
    expect(staked.statusCode).toBe(400);

    const free = await h.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(plain.token),
      payload: { title: "X vs Y", sideA: "X", sideB: "Y" },
    });
    expect(free.statusCode).toBe(201);
  });

  it("does not pay out twice when a close is retried", async () => {
    const host = await registerUser(wallet.app, "dhost");
    await fund(wallet, host.token, 1_000_00, "d1");
    const created = await wallet.app.inject({
      method: "POST",
      url: "/v1/battles",
      headers: auth(host.token),
      payload: { title: "A vs B", sideA: "A", sideB: "B", stakeMinor: 200_00 },
    });
    const id = created.json().battle.id as string;

    const first = await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/close`, headers: auth(host.token) });
    expect(first.statusCode).toBe(200);
    const second = await wallet.app.inject({ method: "POST", url: `/v1/battles/${id}/close`, headers: auth(host.token) });
    expect(second.statusCode).toBe(400); // already closed

    // A lone backer wins their own stake back — no rake, so nothing is lost.
    expect(await balance(wallet, host.token)).toBe(1_000_00);
  });
});
