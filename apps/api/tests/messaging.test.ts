import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

async function startDirect(a: string, b: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/conversations",
    headers: auth(a),
    payload: { userId: b },
  });
  expect([200, 201]).toContain(res.statusCode);
  return res.json().id as string;
}

describe("direct messages", () => {
  it("returns the same conversation when either side starts it", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");

    const first = await startDirect(zara.token, ada.id);
    const second = await startDirect(ada.token, zara.id);
    expect(second).toBe(first);

    const list = await h.app.inject({ method: "GET", url: "/v1/conversations", headers: auth(zara.token) });
    expect(list.json().conversations).toHaveLength(1);
  });

  it("keeps a message send idempotent on the client id", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const id = await startDirect(zara.token, ada.id);

    const payload = { clientId: "client-1", body: "Hello there" };
    const one = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(zara.token),
      payload,
    });
    const two = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(zara.token),
      payload,
    });
    expect(one.statusCode).toBe(201);
    expect(two.json().id).toBe(one.json().id);

    const messages = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(zara.token),
    });
    expect(messages.json().messages).toHaveLength(1);
  });

  it("counts unread only for the other participant", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const id = await startDirect(zara.token, ada.id);

    await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(zara.token),
      payload: { body: "Are you free Saturday?" },
    });

    const zaraList = await h.app.inject({ method: "GET", url: "/v1/conversations", headers: auth(zara.token) });
    expect(zaraList.json().conversations[0].unreadCount).toBe(0);

    const adaList = await h.app.inject({ method: "GET", url: "/v1/conversations", headers: auth(ada.token) });
    expect(adaList.json().conversations[0].unreadCount).toBe(1);

    await h.app.inject({ method: "POST", url: `/v1/conversations/${id}/read`, headers: auth(ada.token) });
    const adaAgain = await h.app.inject({ method: "GET", url: "/v1/conversations", headers: auth(ada.token) });
    expect(adaAgain.json().conversations[0].unreadCount).toBe(0);
  });

  it("refuses reads and writes from a non-member", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const mallory = await registerUser(h.app, "mallory");
    const id = await startDirect(zara.token, ada.id);

    const read = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(mallory.token),
    });
    expect(read.statusCode).toBe(403);

    const write = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(mallory.token),
      payload: { body: "sneaking in" },
    });
    expect(write.statusCode).toBe(403);

    const list = await h.app.inject({ method: "GET", url: "/v1/conversations", headers: auth(mallory.token) });
    expect(list.json().conversations).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const id = await startDirect(zara.token, ada.id);
    const res = await h.app.inject({ method: "GET", url: `/v1/conversations/${id}/messages` });
    expect(res.statusCode).toBe(401);
  });

  it("stops messaging once someone is blocked", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const id = await startDirect(zara.token, ada.id);

    await h.app.inject({ method: "POST", url: `/v1/users/${zara.id}/block`, headers: auth(ada.token) });

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(zara.token),
      payload: { body: "Still there?" },
    });
    expect(res.statusCode).toBe(403);

    const reverse = await h.app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: auth(zara.token),
      payload: { userId: ada.id },
    });
    expect(reverse.statusCode).toBe(403);
  });

  it("rejects an empty message", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const id = await startDirect(zara.token, ada.id);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(zara.token),
      payload: { body: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lets a sender delete their own message but not another's", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const id = await startDirect(zara.token, ada.id);

    const sent = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(zara.token),
      payload: { body: "oops" },
    });
    const messageId = sent.json().id;

    const byOther = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages/${messageId}/delete`,
      headers: auth(ada.token),
    });
    expect(byOther.statusCode).toBe(403);

    const bySender = await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${id}/messages/${messageId}/delete`,
      headers: auth(zara.token),
    });
    expect(bySender.statusCode).toBe(200);

    const messages = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${id}/messages`,
      headers: auth(ada.token),
    });
    expect(messages.json().messages[0].deleted).toBe(true);
    expect(messages.json().messages[0].body).toBeNull();
  });

  it("paginates messages with a stable cursor and no duplicates", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const id = await startDirect(zara.token, ada.id);

    for (let i = 0; i < 5; i += 1) {
      await h.app.inject({
        method: "POST",
        url: `/v1/conversations/${id}/messages`,
        headers: auth(zara.token),
        payload: { clientId: `c-${i}`, body: `message ${i}` },
      });
    }

    const first = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${id}/messages?limit=2`,
      headers: auth(zara.token),
    });
    expect(first.json().messages).toHaveLength(2);
    const cursor = first.json().nextCursor;
    expect(cursor).toBeTruthy();

    const second = await h.app.inject({
      method: "GET",
      url: `/v1/conversations/${id}/messages?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: auth(zara.token),
    });
    const ids = [...first.json().messages, ...second.json().messages].map((m: { id: string }) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("aggregates unread across conversations for the badge", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const bob = await registerUser(h.app, "bob");

    const withAda = await startDirect(zara.token, ada.id);
    const withBob = await startDirect(zara.token, bob.id);
    await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${withAda}/messages`,
      headers: auth(ada.token),
      payload: { body: "hi from ada" },
    });
    await h.app.inject({
      method: "POST",
      url: `/v1/conversations/${withBob}/messages`,
      headers: auth(bob.token),
      payload: { body: "hi from bob" },
    });

    const count = await h.app.inject({ method: "GET", url: "/v1/messaging/unread-count", headers: auth(zara.token) });
    expect(count.json().unread).toBe(2);
  });
});
