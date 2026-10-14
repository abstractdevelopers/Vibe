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

async function makePost(token: string, body = "hello") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/posts",
    headers: auth(token),
    payload: { body, audience: "public" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("non-monetary gifts", () => {
  it("exposes a fixed catalogue and states the no-money policy", async () => {
    const user = await registerUser(h.app, "gifter");
    const res = await h.app.inject({ method: "GET", url: "/v1/gifts/catalogue", headers: auth(user.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gifts.length).toBeGreaterThan(0);
    // No catalogue entry carries a price or value field.
    for (const gift of body.gifts) {
      expect(gift).not.toHaveProperty("price");
      expect(gift).not.toHaveProperty("value");
      expect(gift).not.toHaveProperty("amount");
    }
    expect(body.policy).toMatch(/no money|carry no money|free/i);
  });

  it("sends a gift and counts it, but only once per kind per sender", async () => {
    const author = await registerUser(h.app, "author");
    const gifter = await registerUser(h.app, "gifter");
    const postId = await makePost(author.token);

    const first = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/gifts`,
      headers: auth(gifter.token),
      payload: { kind: "sparkle" },
    });
    expect(first.statusCode).toBe(201);

    const again = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/gifts`,
      headers: auth(gifter.token),
      payload: { kind: "sparkle" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadySent).toBe(true);

    const list = await h.app.inject({ method: "GET", url: `/v1/posts/${postId}/gifts`, headers: auth(gifter.token) });
    const sparkle = list.json().gifts.find((g: { id: string }) => g.id === "sparkle");
    expect(sparkle.count).toBe(1);
    expect(sparkle.viewerSent).toBe(true);
    expect(list.json().total).toBe(1);
  });

  it("rejects a gift kind that is not in the catalogue", async () => {
    const author = await registerUser(h.app, "author");
    const gifter = await registerUser(h.app, "gifter");
    const postId = await makePost(author.token);

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/gifts`,
      headers: auth(gifter.token),
      // A client trying to send something with a value must be refused.
      payload: { kind: "100_usd", value: 100 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses gifting your own post", async () => {
    const author = await registerUser(h.app, "author");
    const postId = await makePost(author.token);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/gifts`,
      headers: auth(author.token),
      payload: { kind: "fire" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("records a notification and a received-gifts list for the recipient", async () => {
    const author = await registerUser(h.app, "author");
    const gifter = await registerUser(h.app, "gifter");
    const postId = await makePost(author.token);

    await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/gifts`,
      headers: auth(gifter.token),
      payload: { kind: "cheer", note: "congrats!" },
    });

    const notifications = await h.app.inject({ method: "GET", url: "/v1/notifications", headers: auth(author.token) });
    expect(notifications.json().notifications[0].type).toBe("gift.received");

    const received = await h.app.inject({ method: "GET", url: "/v1/gifts/received", headers: auth(author.token) });
    expect(received.json().gifts).toHaveLength(1);
    expect(received.json().gifts[0].from.handle).toBe("gifter");
    expect(received.json().gifts[0].note).toBe("congrats!");
  });

  it("blocks gifting across a block", async () => {
    const author = await registerUser(h.app, "author");
    const gifter = await registerUser(h.app, "gifter");
    const postId = await makePost(author.token);

    await h.app.inject({ method: "POST", url: `/v1/users/${gifter.id}/block`, headers: auth(author.token) });

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/gifts`,
      headers: auth(gifter.token),
      payload: { kind: "hug" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires authentication", async () => {
    const author = await registerUser(h.app, "author");
    const postId = await makePost(author.token);
    const res = await h.app.inject({ method: "POST", url: `/v1/posts/${postId}/gifts`, payload: { kind: "fire" } });
    expect(res.statusCode).toBe(401);
  });
});
