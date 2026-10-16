import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, registerUser, resetDb, auth, type Harness } from "./helpers.js";

const STUB_SECRET = "test-webhook-secret";
let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

function sign(rawBody: string): string {
  return createHmac("sha256", STUB_SECRET).update(rawBody).digest("hex");
}

/** A signed payment webhook, in the provider's real payload shape. */
function signBody(payload: { id: string; type: string; reference: string; amountMinor: number }) {
  const raw = JSON.stringify({
    id: payload.id,
    type: payload.type,
    providerRef: `chk_${payload.id}`,
    amount: { amount: payload.amountMinor, currency: "NGN" },
    orderReference: payload.reference,
  });
  return { raw, headers: { "content-type": "application/json", "x-bachs-signature": sign(raw) } };
}

async function createRoom(token: string, payload: Record<string, unknown>) {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/activities/rooms",
    headers: auth(token),
    body: undefined,
    payload,
  });
  if (res.statusCode !== 201) throw new Error(`create room failed: ${res.statusCode} ${res.body}`);
  return res.json().room;
}

describe("voice rooms", () => {
  it("creates a voice room with an audio track", async () => {
    const host = await registerUser(h.app, "voicer");
    const room = await createRoom(host.token, {
      kind: "voice",
      title: "Late night talk",
      startsAt: new Date().toISOString(),
      durationMinutes: 60,
      audioTrack: { title: "Essence", artist: "Wizkid" },
    });
    expect(room.kind).toBe("voice");
    expect(room.audioTrack.title).toBe("Essence");
    expect(room.isTicketed).toBe(false);
  });

  it("creates a listen-together room and allows a daily cadence", async () => {
    const host = await registerUser(h.app, "dailyhost");
    const room = await createRoom(host.token, {
      kind: "listen",
      title: "Morning drive",
      startsAt: new Date().toISOString(),
      durationMinutes: 90,
      recurrence: "daily",
    });
    expect(room.kind).toBe("listen");
    expect(room.recurrence).toBe("daily");
  });

  it("rejects an unknown cadence", async () => {
    const host = await registerUser(h.app, "badcadence");
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/activities/rooms",
      headers: auth(host.token),
      payload: { kind: "voice", title: "x", startsAt: new Date().toISOString(), recurrence: "hourly" },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("ticketed live rooms", () => {
  it("refuses entry without a ticket and grants it after payment", async () => {
    const host = await registerUser(h.app, "paidhost");
    const fan = await registerUser(h.app, "fan");
    const room = await createRoom(host.token, {
      kind: "listen",
      title: "Paid listening party",
      startsAt: new Date().toISOString(),
      durationMinutes: 60,
      ticketPriceMinor: 200_000, // ₦2,000
    });
    expect(room.isTicketed).toBe(true);

    // Without a ticket, joining is refused with 402.
    const blocked = await h.app.inject({
      method: "POST",
      url: `/v1/activities/rooms/${room.id}/join`,
      headers: auth(fan.token),
      payload: {},
    });
    expect(blocked.statusCode).toBe(402);

    // Buy: this creates a checkout and a pending purchase, nothing more.
    const buy = await h.app.inject({
      method: "POST",
      url: `/v1/activities/rooms/${room.id}/ticket`,
      headers: { ...auth(fan.token), "idempotency-key": "ticket-1" },
      payload: {},
    });
    expect(buy.statusCode).toBe(202);
    const { reference, amountMinor } = buy.json();
    expect(reference).toMatch(/^TKT-/);
    expect(amountMinor).toBe(200_000);

    // The verified webhook is what grants the ticket.
    const { raw, headers } = signBody({ id: "evt_ticket_1", type: "collection.succeeded", reference, amountMinor: 200_000 });
    const hook = await h.app.inject({ method: "POST", url: "/v1/webhooks/payments", headers, payload: raw });
    expect(hook.statusCode).toBe(202);
    expect(hook.json().ticket?.applied).toBe(true);

    // Now the same join succeeds.
    const join = await h.app.inject({
      method: "POST",
      url: `/v1/activities/rooms/${room.id}/join`,
      headers: auth(fan.token),
      payload: {},
    });
    expect(join.statusCode).toBe(200);

    const ticket = await h.app.inject({
      method: "GET",
      url: `/v1/activities/rooms/${room.id}/ticket`,
      headers: auth(fan.token),
    });
    expect(ticket.json().ticket.status).toBe("granted");
  });

  it("splits a ticket 70/30 and credits the host's balance", async () => {
    const host = await registerUser(h.app, "earninghost");
    const fan = await registerUser(h.app, "payer");
    const room = await createRoom(host.token, {
      kind: "voice",
      title: "Ticketed stage",
      startsAt: new Date().toISOString(),
      durationMinutes: 60,
      ticketPriceMinor: 100_000,
    });
    const buy = await h.app.inject({
      method: "POST",
      url: `/v1/activities/rooms/${room.id}/ticket`,
      headers: { ...auth(fan.token), "idempotency-key": "ticket-split" },
      payload: {},
    });
    const { reference } = buy.json();
    const { raw, headers } = signBody({ id: "evt_ticket_split", type: "collection.succeeded", reference, amountMinor: 100_000 });
    await h.app.inject({ method: "POST", url: "/v1/webhooks/payments", headers, payload: raw });

    const balance = await h.app.inject({ method: "GET", url: "/v1/money/balance", headers: auth(host.token) });
    // 70% of ₦1,000 is ₦700, held for 7 days, so it shows as pending.
    expect(balance.json().pendingMinor).toBe(70_000);
  });

  it("does not double-grant a ticket on a redelivered webhook", async () => {
    const host = await registerUser(h.app, "idemhost");
    const fan = await registerUser(h.app, "idemfan");
    const room = await createRoom(host.token, {
      kind: "listen",
      title: "Idempotent party",
      startsAt: new Date().toISOString(),
      durationMinutes: 60,
      ticketPriceMinor: 50_000,
    });
    const buy = await h.app.inject({
      method: "POST",
      url: `/v1/activities/rooms/${room.id}/ticket`,
      headers: { ...auth(fan.token), "idempotency-key": "ticket-idem" },
      payload: {},
    });
    const { reference } = buy.json();
    const { raw, headers } = signBody({ id: "evt_ticket_idem", type: "collection.succeeded", reference, amountMinor: 50_000 });
    await h.app.inject({ method: "POST", url: "/v1/webhooks/payments", headers, payload: raw });
    const second = await h.app.inject({ method: "POST", url: "/v1/webhooks/payments", headers, payload: raw });
    expect(second.json().status).toBe("duplicate_ignored");

    const rows = await h.pool.query("SELECT count(*)::int AS n FROM room_tickets WHERE room_id = $1", [room.id]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("refuses a ticket for a free room", async () => {
    const host = await registerUser(h.app, "freehost");
    const fan = await registerUser(h.app, "freefan");
    const room = await createRoom(host.token, {
      kind: "voice",
      title: "Free room",
      startsAt: new Date().toISOString(),
      durationMinutes: 30,
    });
    const buy = await h.app.inject({
      method: "POST",
      url: `/v1/activities/rooms/${room.id}/ticket`,
      headers: { ...auth(fan.token), "idempotency-key": "free-ticket" },
      payload: {},
    });
    expect(buy.statusCode).toBe(400);
  });
});
