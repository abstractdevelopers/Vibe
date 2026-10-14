import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./helpers.js";
import { auth, createHarness, registerUser, resetDb } from "./helpers.js";

/**
 * Notification preferences, data export, and the deletion workflow.
 * Spec §3 (profile & settings), §8 (export/deletion), §13 (behave per policy).
 */
describe("account lifecycle", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await resetDb(h.pool);
  });
  afterEach(async () => {
    await h.close();
  });

  it("defaults every notification type to on, and remembers an opt-out", async () => {
    const alice = await registerUser(h.app, "alice");
    const before = await h.app.inject({ method: "GET", url: "/v1/me/notification-prefs", headers: auth(alice.token) });
    expect(before.statusCode).toBe(200);
    expect(before.json().types.message).toBe(true);
    expect(before.json().types.plan_invite).toBe(true);

    const patched = await h.app.inject({
      method: "PATCH",
      url: "/v1/me/notification-prefs",
      headers: auth(alice.token),
      payload: { types: { message: false }, quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().types.message).toBe(false);
    expect(patched.json().types.plan_invite).toBe(true);
    expect(patched.json().quietHoursEnabled).toBe(true);
    expect(patched.json().quietHoursStart).toBe(22);

    // An unknown type must not be stored.
    const bad = await h.app.inject({
      method: "PATCH",
      url: "/v1/me/notification-prefs",
      headers: auth(alice.token),
      payload: { types: { not_a_real_type: false } },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().types.not_a_real_type).toBeUndefined();
  });

  it("honours an opt-out when fanning out a Circle notification", async () => {
    const owner = await registerUser(h.app, "owner");
    const member = await registerUser(h.app, "member");

    const circle = await h.app.inject({
      method: "POST",
      url: "/v1/circles",
      headers: auth(owner.token),
      payload: { name: "Crew", privacy: "private" },
    });
    const circleId = circle.json().id;
    const invite = await h.app.inject({
      method: "POST",
      url: `/v1/circles/${circleId}/invites`,
      headers: auth(owner.token),
      payload: { role: "member" },
    });
    await h.app.inject({
      method: "POST",
      url: `/v1/invites/${invite.json().inviteToken}/accept`,
      headers: auth(member.token),
      payload: {},
    });

    // Member opts out of plan notifications.
    await h.app.inject({
      method: "PATCH",
      url: "/v1/me/notification-prefs",
      headers: auth(member.token),
      payload: { types: { plan_invite: false } },
    });

    // Owner creates a plan, which fans out "plan.created".
    await h.app.inject({
      method: "POST",
      url: "/v1/plans",
      headers: auth(owner.token),
      payload: {
        circleId,
        title: "Beach day",
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        timeZone: "Africa/Lagos",
      },
    });

    const inbox = await h.app.inject({ method: "GET", url: "/v1/notifications", headers: auth(member.token) });
    const types = inbox.json().notifications.map((n: { type: string }) => n.type);
    expect(types).not.toContain("plan.created");
  });

  it("exports the account's own data without other people's secrets", async () => {
    const alice = await registerUser(h.app, "alicex");
    await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(alice.token), "idempotency-key": "k1" },
      payload: { body: "hello world", audience: "public" },
    });
    const res = await h.app.inject({ method: "GET", url: "/v1/me/export", headers: auth(alice.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.handle).toBe("alicex");
    expect(body.profile.email).toBe("alicex@example.com");
    expect(body.posts.length).toBe(1);
    // Never leak credential material.
    expect(JSON.stringify(body)).not.toMatch(/password|token_hash|password_hash/i);
  });

  it("deletes through a cooling-off window and blocks login afterwards", async () => {
    const alice = await registerUser(h.app, "alicey");
    const req = await h.app.inject({ method: "POST", url: "/v1/me/delete", headers: auth(alice.token) });
    expect(req.statusCode).toBe(202);
    expect(req.json().status).toBe("pending");
    expect(req.json().coolingOffHours).toBe(24);

    // Cannot execute before the window elapses.
    const early = await h.app.inject({ method: "POST", url: "/v1/me/delete/execute", headers: auth(alice.token) });
    expect(early.statusCode).toBe(400);

    // Cancelling keeps the account usable.
    const cancel = await h.app.inject({ method: "POST", url: "/v1/me/delete/cancel", headers: auth(alice.token) });
    expect(cancel.json().status).toBe("cancelled");

    // Re-request, force the window open, then execute.
    await h.app.inject({ method: "POST", url: "/v1/me/delete", headers: auth(alice.token) });
    await h.pool.query("UPDATE account_deletion_requests SET execute_after = now() - interval '1 hour' WHERE user_id = $1", [alice.id]);
    const done = await h.app.inject({ method: "POST", url: "/v1/me/delete/execute", headers: auth(alice.token) });
    expect(done.json().status).toBe("completed");

    // The session is revoked and the account can no longer log in.
    const login = await h.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "alicey@example.com", password: "password123" },
    });
    expect(login.statusCode).toBe(401);
  });
});
