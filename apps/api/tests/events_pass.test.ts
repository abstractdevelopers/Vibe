import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * Phase 4: events, check-in codes, and Phase 5: Vibe Pass + loyalty.
 *
 * The spec's hard rules under test: a check-in code is validated server-side and
 * revocable; a revoked or expired code is refused; a person checks in once; a
 * pass is a revocable pointer; loyalty redemption is single-use per nonce.
 */
describe("events, check-in, pass and loyalty", () => {
  let h: Harness;
  let organizer: TestUser;
  let attendee: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    organizer = await registerUser(h.app, "organizer");
    attendee = await registerUser(h.app, "attendee");
  });
  afterAll(async () => h.close());

  async function makeEvent(): Promise<string> {
    const created = await h.app.inject({
      method: "POST", url: "/v1/events", headers: auth(organizer.token),
      payload: {
        title: "Rooftop meetup", startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        timezone: "Africa/Lagos", city: "Lagos", area: "Yaba", priceMinor: 0, currency: "NGN",
      },
    });
    const id = created.json().id;
    await h.app.inject({ method: "POST", url: `/v1/events/${id}/publish`, headers: auth(organizer.token) });
    return id;
  }

  it("creates and publishes an event, and does not claim a booking", async () => {
    const id = await makeEvent();
    const res = await h.app.inject({ method: "GET", url: `/v1/events/${id}`, headers: auth(attendee.token) });
    expect(res.json().state).toBe("published");
    // No verified booking was supplied, so none is claimed.
    expect(res.json().booking.verified).toBe(false);
  });

  it("checks a person in with a valid code, once", async () => {
    const id = await makeEvent();
    const codeRes = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin-codes`, headers: auth(organizer.token),
      payload: { ttlMinutes: 60, maxUses: 50 },
    });
    const code = codeRes.json().code;
    const first = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin`, headers: auth(attendee.token), payload: { code },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().alreadyCheckedIn).toBe(false);
    // A second attempt is idempotent, not a duplicate.
    const second = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin`, headers: auth(attendee.token), payload: { code },
    });
    expect(second.json().alreadyCheckedIn).toBe(true);
    const list = await h.app.inject({ method: "GET", url: `/v1/events/${id}/checkins`, headers: auth(organizer.token) });
    expect(list.json().checkins).toHaveLength(1);
  });

  it("refuses a revoked check-in code", async () => {
    const id = await makeEvent();
    const codeRes = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin-codes`, headers: auth(organizer.token),
      payload: { ttlMinutes: 60 },
    });
    const code = codeRes.json().code;
    const codes = await h.pool.query<{ id: string }>("SELECT id FROM checkin_codes WHERE event_id = $1", [id]);
    await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin-codes/${codes.rows[0]!.id}/revoke`, headers: auth(organizer.token),
    });
    const res = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin`, headers: auth(attendee.token), payload: { code },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/revoked/i);
  });

  it("refuses an expired check-in code", async () => {
    const id = await makeEvent();
    const codeRes = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin-codes`, headers: auth(organizer.token),
      payload: { ttlMinutes: 60 },
    });
    const code = codeRes.json().code;
    await h.pool.query("UPDATE checkin_codes SET expires_at = now() - interval '1 minute' WHERE event_id = $1", [id]);
    const res = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin`, headers: auth(attendee.token), payload: { code },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  it("only the organizer may issue a check-in code", async () => {
    const id = await makeEvent();
    const res = await h.app.inject({
      method: "POST", url: `/v1/events/${id}/checkin-codes`, headers: auth(attendee.token), payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates a pass, resolves it, and stops resolving after revoke", async () => {
    const pass = await registerUser(h.app, "passholder");
    const created = await h.app.inject({ method: "POST", url: "/v1/pass", headers: auth(pass.token) });
    const token = created.json().token;
    const resolved = await h.app.inject({ method: "GET", url: `/v1/pass/resolve/${token}`, headers: auth(organizer.token) });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().pass.status).toBe("active");
    await h.app.inject({ method: "POST", url: "/v1/pass/me/revoke", headers: auth(pass.token) });
    const after = await h.app.inject({ method: "GET", url: `/v1/pass/resolve/${token}`, headers: auth(organizer.token) });
    expect(after.statusCode).toBe(404);
  });

  it("only shares profile fields the holder consented to", async () => {
    const holder = await registerUser(h.app, "consenter");
    await h.app.inject({ method: "POST", url: "/v1/pass", headers: auth(holder.token) });
    await h.app.inject({
      method: "PATCH", url: "/v1/pass/me/share", headers: auth(holder.token),
      payload: { shareHandle: false, shareAvatar: false, shareDisplayName: true },
    });
    const me = await h.app.inject({ method: "GET", url: "/v1/pass/me", headers: auth(holder.token) });
    const token = me.json().pass.token;
    const resolved = await h.app.inject({ method: "GET", url: `/v1/pass/resolve/${token}`, headers: auth(organizer.token) });
    expect(resolved.json().pass.displayName).toBe("consenter");
    expect(resolved.json().pass.handle).toBeNull();
    expect(resolved.json().pass.avatarUrl).toBeNull();
  });

  it("redeems a loyalty offer once per nonce and is idempotent on replay", async () => {
    const merchantUser = await registerUser(h.app, "shopowner");
    const holder = await registerUser(h.app, "loyal");
    const m = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(merchantUser.token),
      payload: { name: "Corner Shop", category: "retail" },
    });
    const merchantId = m.json().id;
    const pass = await h.app.inject({ method: "POST", url: "/v1/pass", headers: auth(holder.token) });
    const passToken = pass.json().token;
    const payload = { passToken, offerCode: "FREE-COFFEE", nonce: "nonce-abc-123" };
    const first = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/redeem`, headers: auth(merchantUser.token), payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().duplicate).toBe(false);
    // Replaying the same nonce does not redeem again.
    const replay = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/redeem`, headers: auth(merchantUser.token), payload,
    });
    expect(replay.json().duplicate).toBe(true);
    const history = await h.app.inject({
      method: "GET", url: `/v1/merchants/${merchantId}/redemptions`, headers: auth(merchantUser.token),
    });
    expect(history.json().redemptions).toHaveLength(1);
  });

  it("does not let a non-owner redeem for a merchant", async () => {
    const merchantUser = await registerUser(h.app, "owner2");
    const m = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(merchantUser.token), payload: { name: "Other Shop" },
    });
    const res = await h.app.inject({
      method: "POST", url: `/v1/merchants/${m.json().id}/redeem`, headers: auth(attendee.token),
      payload: { passToken: "whatever-token", offerCode: "X", nonce: "n-12345678" },
    });
    expect(res.statusCode).toBe(403);
  });
});
