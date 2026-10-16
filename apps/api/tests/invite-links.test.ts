import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, registerUser, resetDb, auth, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

async function makeCircle(token: string, name = "Invite Circle") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/circles",
    headers: auth(token),
    payload: { name, description: "Come hang out", privacy: "invite_only" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function makeInvite(token: string, circleId: string, body: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/circles/${circleId}/invites`,
    headers: auth(token),
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json().inviteToken as string;
}

describe("invite links", () => {
  it("previews a Circle to a visitor who is not signed in", async () => {
    const owner = await registerUser(h.app, "invowner");
    const circleId = await makeCircle(owner.token, "Sunday Runners");
    const token = await makeInvite(owner.token, circleId);

    // No auth header: this is the anonymous landing page.
    const res = await h.app.inject({ method: "GET", url: `/v1/invites/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.circle.name).toBe("Sunday Runners");
    expect(body.circle.description).toBe("Come hang out");
    expect(body.usable).toBe(true);
    // It must not leak the member list or posts.
    expect(body.circle).not.toHaveProperty("members");
  });

  it("still accepts the invite after the visitor signs up", async () => {
    const owner = await registerUser(h.app, "host2");
    const joiner = await registerUser(h.app, "joiner2");
    const circleId = await makeCircle(owner.token, "Book Club");
    const token = await makeInvite(owner.token, circleId);

    const accept = await h.app.inject({
      method: "POST",
      url: `/v1/invites/${token}/accept`,
      headers: auth(joiner.token),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().circleId).toBe(circleId);

    const detail = await h.app.inject({
      method: "GET",
      url: `/v1/circles/${circleId}`,
      headers: auth(owner.token),
    });
    const ids = detail.json().members.map((m: { id: string }) => m.id);
    expect(ids).toContain(joiner.id);
  });

  it("reports a used-up invite as unusable", async () => {
    const owner = await registerUser(h.app, "limited");
    const joiner = await registerUser(h.app, "onlyone");
    const circleId = await makeCircle(owner.token);
    const token = await makeInvite(owner.token, circleId, { maxUses: 1 });

    await h.app.inject({ method: "POST", url: `/v1/invites/${token}/accept`, headers: auth(joiner.token) });

    const preview = await h.app.inject({ method: "GET", url: `/v1/invites/${token}` });
    expect(preview.json().usable).toBe(false);
    expect(preview.json().reason).toBe("used_up");
  });

  it("reports an expired invite as unusable", async () => {
    const owner = await registerUser(h.app, "expiry");
    const circleId = await makeCircle(owner.token);
    const token = await makeInvite(owner.token, circleId, { expiresInHours: 1 });
    await h.pool.query("UPDATE circle_invites SET expires_at = now() - interval '1 hour'");

    const preview = await h.app.inject({ method: "GET", url: `/v1/invites/${token}` });
    expect(preview.json().usable).toBe(false);
    expect(preview.json().reason).toBe("expired");
  });

  it("returns 404 for an unknown token", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/invites/not-a-real-token" });
    expect(res.statusCode).toBe(404);
  });
});
