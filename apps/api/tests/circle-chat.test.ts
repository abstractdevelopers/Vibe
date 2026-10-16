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

async function createCircle(token: string, name: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/circles",
    headers: auth(token),
    payload: { name, privacy: "private" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function inviteAndJoin(ownerToken: string, circleId: string, joinerToken: string) {
  const invite = await h.app.inject({
    method: "POST",
    url: `/v1/circles/${circleId}/invites`,
    headers: auth(ownerToken),
    payload: { role: "member" },
  });
  expect(invite.statusCode).toBe(201);
  const token = invite.json().inviteToken as string;
  const accept = await h.app.inject({
    method: "POST",
    url: `/v1/invites/${token}/accept`,
    headers: auth(joinerToken),
  });
  expect(accept.statusCode).toBe(200);
}

describe("circle chat", () => {
  it("gives a circle a conversation, titled with the circle name", async () => {
    const owner = await registerUser(h.app, "owner");
    const circleId = await createCircle(owner.token, "Lagos Runners");

    const detail = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    expect(detail.statusCode).toBe(200);
    const conversationId = detail.json().conversationId;
    expect(conversationId).toBeTruthy();

    const conv = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
      headers: auth(owner.token),
    });
    expect(conv.statusCode).toBe(200);
    expect(conv.json().conversation.circleId).toBe(circleId);
    expect(conv.json().conversation.title).toBe("Lagos Runners");
  });

  it("returns the same conversation every time the circle is opened", async () => {
    const owner = await registerUser(h.app, "stable");
    const circleId = await createCircle(owner.token, "Book Club");
    const first = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    const second = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    expect(first.json().conversationId).toBe(second.json().conversationId);
  });

  it("adds a member who joins after the chat already exists", async () => {
    const owner = await registerUser(h.app, "founder");
    const member = await registerUser(h.app, "later");
    const circleId = await createCircle(owner.token, "Chess Night");

    // The owner opens the circle, which creates the chat.
    await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });

    // The second person is invited and accepts after the chat exists.
    await inviteAndJoin(owner.token, circleId, member.token);

    const detail = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(member.token) });
    const conversationId = detail.json().conversationId;
    const conv = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
      headers: auth(member.token),
    });
    expect(conv.statusCode).toBe(200);
    const memberIds = conv.json().members.map((m: { id: string }) => m.id);
    expect(memberIds).toContain(owner.id);
    expect(memberIds).toContain(member.id);
  });

  it("lets a member post to the circle chat and read it back", async () => {
    const owner = await registerUser(h.app, "poster");
    const circleId = await createCircle(owner.token, "Film Club");
    const detail = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    const conversationId = detail.json().conversationId;

    const send = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: auth(owner.token),
      payload: { clientId: "c1", body: "Saturday, 6pm?" },
    });
    expect(send.statusCode).toBe(201);

    const list = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}/messages`,
      headers: auth(owner.token),
    });
    expect(list.json().messages[0].body).toBe("Saturday, 6pm?");
  });

  it("keeps a non-member out of the circle chat", async () => {
    const owner = await registerUser(h.app, "private");
    const stranger = await registerUser(h.app, "stranger");
    const circleId = await createCircle(owner.token, "Closed Circle");
    const detail = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    const conversationId = detail.json().conversationId;

    const peek = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
      headers: auth(stranger.token),
    });
    expect(peek.statusCode).toBe(403);
  });

  it("removes a member from the chat when they leave the circle", async () => {
    const owner = await registerUser(h.app, "keep");
    const leaver = await registerUser(h.app, "leaver");
    const circleId = await createCircle(owner.token, "Temp Circle");
    await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    await inviteAndJoin(owner.token, circleId, leaver.token);

    const detail = await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });
    const conversationId = detail.json().conversationId;

    const leave = await h.app.inject({
      method: "POST",
      url: `/v1/circles/${circleId}/leave`,
      headers: auth(leaver.token),
    });
    expect(leave.statusCode).toBe(204);

    const after = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
      headers: auth(leaver.token),
    });
    expect(after.statusCode).toBe(403);
  });

  it("lists the circle chat in the conversation list with its circle id", async () => {
    const owner = await registerUser(h.app, "lister");
    const circleId = await createCircle(owner.token, "Sunday Brunch");
    await h.app.inject({ method: "GET", url: `/v1/circles/${circleId}`, headers: auth(owner.token) });

    const list = await h.app.inject({ method: "GET", url: "/v1/conversations", headers: auth(owner.token) });
    const row = list.json().conversations.find((c: { circleId: string | null }) => c.circleId === circleId);
    expect(row).toBeTruthy();
    expect(row.title).toBe("Sunday Brunch");
  });
});
