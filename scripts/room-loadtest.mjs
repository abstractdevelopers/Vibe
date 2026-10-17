#!/usr/bin/env node
/**
 * Room load test: how many live listeners a voice/broadcast room actually holds.
 *
 * The latency script (loadtest.mjs) measures request/response paths. This one
 * measures the thing a live room is made of: open sockets on /v1/realtime, each
 * present in a room, all receiving a broadcast. It is the difference between
 * "the API answers" and "a thousand people can stand in the same room".
 *
 * Usage:
 *   node scripts/room-loadtest.mjs [baseUrl] [listeners] [users]
 *     baseUrl    default http://localhost:12000
 *     listeners  default 1000 — sockets to hold open at once
 *     users      default 200  — distinct accounts the sockets are spread over
 *
 * It creates its own public room and its own accounts, so it is safe to run
 * against a throwaway environment. It does NOT run against production data.
 *
 * What it reports:
 *   - handshake: how many of the sockets connected and joined
 *   - capacity:  the close code if the server sheds load (4429) and how many
 *   - fanout:    how many listeners received one broadcast, and how fast
 *   - sustained: messages/sec held for a few seconds, and the delivery ratio
 */

const base = (process.argv[2] ?? process.env.PUBLIC_API_URL ?? "http://localhost:12000").replace(/\/$/, "");
const LISTENERS = Number(process.argv[3] ?? 1000);
const USERS = Number(process.argv[4] ?? 200);
const wsBase = base.replace(/^http/, "ws");

async function post(path, body, token) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/** Create `n` accounts concurrently and return their tokens. */
async function accounts(n) {
  // A load test needs hundreds of identities, and signup is deliberately rate
  // limited per IP (10/hour) to stop junk accounts. Reusing a pre-minted token
  // file avoids fighting that guard — and avoids the flattering mistake of
  // measuring the signup path instead of the room. See scripts/seed-load-users.sh.
  const fromFile = process.env.LOAD_TOKENS;
  if (fromFile) {
    const { readFileSync } = await import("node:fs");
    const tokens = JSON.parse(readFileSync(fromFile, "utf8"));
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error(`no tokens in ${fromFile}`);
    return tokens;
  }
  const tokens = new Array(n);
  const stamp = Date.now().toString(36);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      const email = `room-${stamp}-${i}@example.com`;
      const { token } = await post("/v1/auth/register", {
        email, handle: `room${stamp}${i}`, displayName: `Listener ${i}`, password: "password123",
      });
      tokens[i] = token;
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, 24) }, worker));
  return tokens;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log(`Room load test -> ${base}`);
  console.log(`  listeners: ${LISTENERS}  accounts: ${USERS}`);

  // 1. Accounts + a room to stand in.
  const t0 = performance.now();
  const tokens = await accounts(Math.min(USERS, LISTENERS));
  console.log(`  created ${tokens.length} accounts in ${Math.round(performance.now() - t0)}ms`);

  const host = tokens[0];
  const room = await post("/v1/activities/rooms", {
    title: "Load test room",
    kind: "voice",
    layout: "stage",
    visibility: "public",
    startsAt: new Date().toISOString(),
    durationMinutes: 60,
  }, host);
  const roomId = room.room.id;
  console.log(`  room ${roomId}`);

  // 2. Open every socket, spread across the accounts, and join the room.
  const sockets = [];
  const errors = { refused: 0, closed: 0, capacity: 0, other: 0 };

  function openSocket(i) {
    return new Promise((resolve) => {
      const token = tokens[i % tokens.length];
      const ws = new WebSocket(`${wsBase}/v1/realtime?token=${token}`);
      const entry = { ws, i, joined: false, got: 0 };
      sockets.push(entry);
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(entry); } };

      ws.onopen = () => ws.send(JSON.stringify({ type: "room.join", roomId }));
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "realtime.ready") {
          entry.joined = true;
          return done();
        }
        entry.got += 1;
        // small settle window: give stragglers time before we count
        clearTimeout(entry.timer);
        entry.timer = setTimeout(done, 400);
      };
      ws.onclose = (ev) => {
        entry.closed = true;
        if (ev.code === 4429) errors.capacity += 1;
        else if (ev.code === 4401) errors.refused += 1;
        else errors.closed += 1;
        done();
      };
      ws.onerror = () => { errors.other += 1; done(); };
    });
  }

  const t1 = performance.now();
  const BATCH = 50;
  for (let start = 0; start < LISTENERS; start += BATCH) {
    const end = Math.min(start + BATCH, LISTENERS);
    await Promise.all(Array.from({ length: end - start }, (_, k) => openSocket(start + k)));
  }
  const openMs = performance.now() - t1;
  const joined = sockets.filter((s) => s.joined).length;
  console.log(`  sockets open+joined: ${joined}/${LISTENERS} in ${Math.round(openMs)}ms (${Math.round(joined / (openMs / 1000))}/s)`);
  console.log(`  closes -> capacity:${errors.capacity} refused:${errors.refused} other:${errors.closed + errors.other}`);

  if (joined === 0) {
    console.log("RESULT: no sockets joined — nothing to measure");
    process.exit(1);
  }

  // `realtime.ready` means the socket is authenticated and subscribed, but the
  // room join is processed asynchronously after it. Give the joins time to
  // settle before broadcasting, or the first message races the join and the
  // delivery number measures the race, not the fan-out.
  await sleep(3000);

  // 3. Fan-out: the host sends one broadcast; count how many hear it.
  const alive = sockets.filter((s) => s.joined && s.ws.readyState === 1);
  const before = alive.map((s) => s.got);
  const seq = 1;
  // Send from a member socket so the relay treats it as a room member.
  const hostSocket = alive[0].ws;
  const sendAt = performance.now();
  hostSocket.send(JSON.stringify({ type: "rtc.offer", roomId, to: "broadcast", payload: { seq } }));
  await sleep(1500);
  const heard = alive.filter((s, k) => s.got > before[k]).length;
  const fanoutMs = performance.now() - sendAt;
  console.log(`  fan-out: ${heard}/${alive.length} listeners heard one broadcast in ${Math.round(fanoutMs)}ms`);

  // 4. Sustained: 5 broadcasts/sec for 5s, measure delivery. The rate is kept
  // under the server's per-socket flood guard (60 frames / 10s), so the number
  // reflects fan-out rather than the deliberate backpressure a real client
  // never trips — a well-behaved client sends a handful of frames a second.
  const ROUNDS = 25;
  const totalBefore = alive.map((s) => s.got);
  const s0 = performance.now();
  for (let r = 0; r < ROUNDS; r++) {
    hostSocket.send(JSON.stringify({ type: "rtc.ice", roomId, to: "broadcast", payload: { seq: 1000 + r } }));
    await sleep(200);
  }
  await sleep(1500);
  const sustainedMs = performance.now() - s0;
  const deliveries = alive.reduce((sum, s, k) => sum + (s.got - totalBefore[k]), 0);
  const expected = alive.length * ROUNDS;
  console.log(`  sustained: ${ROUNDS} broadcasts in ${Math.round(sustainedMs)}ms`);
  console.log(`  delivered: ${deliveries}/${expected} frames (${(100 * deliveries / expected).toFixed(1)}%)`);

  for (const s of sockets) { try { s.ws.close(); } catch { /* already closed */ } }
  await sleep(300);
  console.log("RESULT:", joined >= LISTENERS ? "PASS — all listeners held" : `PARTIAL — ${joined}/${LISTENERS} held`);
}

main().catch((e) => { console.error("load test failed:", e.message); process.exit(1); });
