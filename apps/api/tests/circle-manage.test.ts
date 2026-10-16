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

async function makeCircle(token: string, name = "Edit Me") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/circles",
    headers: auth(token),
    payload: { name, description: "Before", privacy: "private" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function addMember(circleId: string, token: string) {
  const invite = await h.app.inject({
    method: "POST",
    url: `/v1/circles/${circleId}/invites`,
    headers: auth(token),
    payload: { role: "member" },
  });
  const join = await registerUser(h.app, `joiner${Math.random().toString(36).slice(2, 8)}`);
  const accept = await h.app.inject({
    method: "POST",
    url: `/v1/invites/${invite.json().inviteToken}/accept`,
    headers: auth(join.token),
  });
  expect(accept.statusCode).toBe(200);
  return join;
}

describe("circle management", () => {
  it("lets the owner edit name, description and privacy", async () => {
    const owner = await registerUser(h.app, "editowner");
    const circleId = await makeCircle(owner.token);

    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/circles/${circleId}`,
      headers: auth(owner.token),
      payload: { name: "Renamed", description: "After", privacy: "public_discoverable" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().circle.name).toBe("Renamed");
    expect(res.json().circle.description).toBe("After");
    expect(res.json().circle.privacy).toBe("public_discoverable");

    const detail = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    expect(detail.json().circle.name).toBe("Renamed");
  });

  it("refuses an empty edit", async () => {
    const owner = await registerUser(h.app, "emptyedit");
    const circleId = await makeCircle(owner.token);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/circles/${circleId}`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("forbids a plain member from editing", async () => {
    const owner = await registerUser(h.app, "editboss");
    const circleId = await makeCircle(owner.token);
    const member = await addMember(circleId, owner.token);

    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/circles/${circleId}`,
      headers: auth(member.token),
      payload: { name: "Hijacked" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets the owner delete a circle, which hides it everywhere", async () => {
    const owner = await registerUser(h.app, "delowner");
    const circleId = await makeCircle(owner.token, "Doomed");

    const del = await h.app.inject({ method: "DELETE", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    expect(del.statusCode).toBe(204);

    const list = await h.app.inject({ method: "GET", url: "/v1/circles", headers: auth(owner.token) });
    expect(list.json().circles.map((c: { id: string }) => c.id)).not.toContain(circleId);

    const detail = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    expect(detail.statusCode).toBe(404);
  });

  it("forbids a non-owner from deleting", async () => {
    const owner = await registerUser(h.app, "keepowner");
    const circleId = await makeCircle(owner.token);
    const member = await addMember(circleId, owner.token);

    const res = await h.app.inject({ method: "DELETE", url: `/v1/circles/${circleId}`, headers: auth(member.token) });
    expect(res.statusCode).toBe(403);
  });
});
