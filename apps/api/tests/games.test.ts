import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, registerUser, resetDb, auth, type Harness, type TestUser } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db.js";
import { RealtimeHub } from "../src/realtime.js";
import { createPaymentProvider } from "../src/payments/provider.js";
import { createPayoutProvider } from "../src/payments/payouts.js";
import { LogMailer } from "../src/modules/mailer.js";
import { loadConfig } from "../src/config.js";

const walletConfig = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://vibe:vibe@localhost:5432/vibe",
  WALLET_ENABLED: "true",
  SESSION_SECRET: "test-session-secret-value",
  PAYMENTS_WEBHOOK_SECRET: "test-webhook-secret",
});

function sign(raw: string): string {
  return createHmac("sha256", "test-webhook-secret").update(raw).digest("hex");
}
function topupWebhook(id: string, reference: string, amountMinor: number) {
  const raw = JSON.stringify({ id, type: "payment_succeeded", providerRef: `chk_${id}`, amount: { amount: amountMinor, currency: "NGN" }, orderReference: reference });
  return { raw, headers: { "content-type": "application/json", "x-bachs-signature": sign(raw) } };
}

let h: Harness;
let wallet: Harness;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

async function fund(user: TestUser, amountMinor: number, tag: string) {
  const res = await wallet.app.inject({ method: "POST", url: "/v1/wallet/topups", headers: { ...auth(user.token), "idempotency-key": `top-${tag}` }, payload: { amountMinor } });
  const { reference } = res.json();
  const hook = topupWebhook(`evt_${tag}`, reference, amountMinor);
  const done = await wallet.app.inject({ method: "POST", url: "/v1/webhooks/payments", payload: hook.raw, headers: hook.headers });
  if (done.statusCode !== 202) throw new Error(`topup failed: ${done.statusCode} ${done.body}`);
}

async function balance(user: TestUser): Promise<number> {
  const res = await wallet.app.inject({ method: "GET", url: "/v1/wallet", headers: auth(user.token) });
  return res.json().balanceMinor as number;
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.pool);
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
  alice = await registerUser(wallet.app, "galice");
  bob = await registerUser(wallet.app, "gbob");
  carol = await registerUser(wallet.app, "gcarol");
});

afterAll(async () => {
  await wallet.close();
  await h.close();
});

describe("games catalogue", () => {
  it("lists every game and marks which are playable", async () => {
    const res = await wallet.app.inject({ method: "GET", url: "/v1/games", headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.games.length).toBeGreaterThan(30);
    const playable = body.games.filter((g: any) => g.availability === "playable");
    // The whole point of this work: more than thirty games that actually play.
    expect(playable.length).toBeGreaterThanOrEqual(30);
    expect(playable.map((g: any) => g.id)).toContain("whot");
    expect(playable.map((g: any) => g.id)).toContain("tictactoe");
    expect(playable.map((g: any) => g.id)).toContain("blackjack");
    expect(body.games.find((g: any) => g.id === "chess").availability).toBe("planned");
    expect(body.rakeBps).toBe(500);
  });

  it("refuses to start a game that is only planned", async () => {
    const res = await wallet.app.inject({ method: "POST", url: "/v1/games/sessions", headers: { ...auth(alice.token), "idempotency-key": "g1" }, payload: { gameId: "chess" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("a free Whot game plays to a winner", () => {
  it("serves only the viewer's own hand", async () => {
    const create = await wallet.app.inject({ method: "POST", url: "/v1/games/sessions", headers: auth(alice.token), payload: { gameId: "whot" } });
    expect(create.statusCode).toBe(201);
    const sessionId = create.json().session.id;

    const join = await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/join`, headers: auth(bob.token) });
    expect(join.statusCode).toBe(201);

    const start = await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/start`, headers: auth(alice.token) });
    expect(start.statusCode).toBe(200);
    const state = start.json().session.state;
    expect(state.hand.length).toBe(6);
    // Bob's hand is not in Alice's view.
    expect(JSON.stringify(state)).not.toContain("bob");

    // Alice may not move for Bob.
    const wrong = await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/move`, headers: auth(bob.token), payload: { move: { type: "draw" } } });
    expect(wrong.statusCode).toBe(400);
  });
});

describe("a staked Whot game moves real Yens", () => {
  it("stakes into escrow, pays the winner, and rakes 5%", async () => {
    await fund(alice, 100_000, "alice");
    await fund(bob, 100_000, "bob");
    const beforeAlice = await balance(alice);
    const beforeBob = await balance(bob);
    expect(beforeAlice).toBe(100_000);

    const create = await wallet.app.inject({ method: "POST", url: "/v1/games/sessions", headers: auth(alice.token), payload: { gameId: "whot", stakeMinor: 50_000 } });
    const sessionId = create.json().session.id;
    await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/join`, headers: auth(bob.token) });
    // Each stake left the wallet and is held in escrow.
    expect(await balance(alice)).toBe(50_000);
    expect(await balance(bob)).toBe(50_000);
    const pot = await wallet.pool.query("SELECT pot_minor FROM game_sessions WHERE id = $1", [sessionId]);
    expect(Number(pot.rows[0].pot_minor)).toBe(100_000);

    await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/start`, headers: auth(alice.token) });

    // Drive the game to a finish: always play the first legal card, else draw.
    let guard = 0;
    let finished = false;
    let winnerId: string | null = null;
    const order = [alice, bob];
    while (!finished && guard < 500) {
      guard += 1;
      const view = await wallet.app.inject({ method: "GET", url: `/v1/games/sessions/${sessionId}`, headers: auth(order[0]!.token) });
      const s = view.json().session.state;
      if (s.finished) { finished = true; winnerId = s.winnerId; break; }
      const mover = s.turnUserId === alice.id ? alice : bob;
      const viewMover = await wallet.app.inject({ method: "GET", url: `/v1/games/sessions/${sessionId}`, headers: auth(mover.token) });
      const sm = viewMover.json().session.state;
      const top = sm.top;
      const playable = sm.hand.find((c: any) => c.shape === "whot" || (sm.calledShape ? c.shape === sm.calledShape : c.shape === top.shape || c.number === top.number));
      const move = playable
        ? (playable.shape === "whot" ? { type: "play", card: playable, callShape: "circle" } : { type: "play", card: playable })
        : { type: "draw" };
      const res = await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/move`, headers: auth(mover.token), payload: { move } });
      expect(res.statusCode).toBe(200);
      if (res.json().session.state.finished) { finished = true; winnerId = res.json().session.state.winnerId; }
    }
    expect(finished).toBe(true);

    // The pot (100k) paid out: 5% rake (5k) to revenue, 95k to the winner.
    const winnerBefore = winnerId === alice.id ? beforeAlice : beforeBob;
    const loserId = winnerId === alice.id ? bob.id : alice.id;
    const winner = winnerId === alice.id ? alice : bob;
    const loser = winnerId === alice.id ? bob : alice;
    // Winner net: -50k stake + 95k prize = +45k.
    expect(await balance(winner)).toBe(winnerBefore - 50_000 + 95_000);
    expect(await balance(loser)).toBe(50_000);

    const revenue = await wallet.pool.query("SELECT COALESCE(SUM(amount_minor),0) AS n FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'platform_revenue' AND e.direction = 'credit'");
    expect(Number(revenue.rows[0].n)).toBe(5_000);
    // Escrow is empty again.
    const escrow = await wallet.pool.query("SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_minor ELSE -amount_minor END),0) AS n FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'game_pot'");
    expect(Number(escrow.rows[0].n)).toBe(0);
    expect(loserId).toBeTruthy();
  });
});

describe("a non-Whot game plays through the same routes", () => {
  it("plays a game of tic-tac-toe to a winner over the API", async () => {
    const dave = await registerUser(wallet.app, "gdave");
    const erin = await registerUser(wallet.app, "gerin");
    const create = await wallet.app.inject({ method: "POST", url: "/v1/games/sessions", headers: auth(dave.token), payload: { gameId: "tictactoe" } });
    const sessionId = create.json().session.id;
    await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/join`, headers: auth(erin.token) });
    await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/start`, headers: auth(dave.token) });

    let guard = 0;
    let finished = false;
    while (!finished && guard < 20) {
      guard += 1;
      const view = await wallet.app.inject({ method: "GET", url: `/v1/games/sessions/${sessionId}`, headers: auth(dave.token) });
      const s = view.json().session.state;
      if (s.finished) { finished = true; break; }
      const mover = s.turnUserId === dave.id ? dave : erin;
      let move: { row: number; col: number } | null = null;
      for (let r = 0; r < 3 && !move; r += 1) for (let c = 0; c < 3 && !move; c += 1) if (s.board[r][c] === null) move = { row: r, col: c };
      const res = await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/move`, headers: auth(mover.token), payload: { move } });
      expect(res.statusCode).toBe(200);
      if (res.json().session.state.finished) finished = true;
    }
    expect(finished).toBe(true);
  });
});

describe("leaving a lobby refunds the stake", () => {
  it("returns the exact stake to the wallet", async () => {
    await fund(carol, 100_000, "carol");
    // The host is seated and staked at creation.
    const create = await wallet.app.inject({ method: "POST", url: "/v1/games/sessions", headers: auth(carol.token), payload: { gameId: "whot", stakeMinor: 30_000 } });
    const sessionId = create.json().session.id;
    const afterStake = await balance(carol);
    expect(afterStake).toBe(70_000);
    const leave = await wallet.app.inject({ method: "POST", url: `/v1/games/sessions/${sessionId}/leave`, headers: auth(carol.token) });
    expect(leave.statusCode).toBe(200);
    expect(leave.json().refunded).toBe(true);
    expect(await balance(carol)).toBe(afterStake + 30_000);
    const pot = await wallet.pool.query("SELECT pot_minor FROM game_sessions WHERE id = $1", [sessionId]);
    expect(Number(pot.rows[0].pot_minor)).toBe(0);
  });
});
