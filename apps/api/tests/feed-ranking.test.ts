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

async function post(token: string, payload: Record<string, unknown>) {
  const res = await h.app.inject({ method: "POST", url: "/v1/posts", headers: auth(token), payload });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function feed(token: string, qs = "") {
  const res = await h.app.inject({ method: "GET", url: `/v1/feed${qs}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("feed ranking and tabs", () => {
  it("ranks a followed author's post above an unrelated stranger's", async () => {
    const me = await registerUser(h.app, "maya");
    const friend = await registerUser(h.app, "friend");
    const stranger = await registerUser(h.app, "stranger");

    // The stranger posts later, so pure recency would put them first.
    await post(friend.token, { body: "from a friend", audience: "public" });
    await new Promise((r) => setTimeout(r, 20));
    await post(stranger.token, { body: "from a stranger", audience: "public" });

    await h.app.inject({
      method: "POST",
      url: "/v1/follows",
      headers: auth(me.token),
      payload: { followeeId: friend.id },
    });

    const items = (await feed(me.token)).items;
    expect(items[0].author.handle).toBe("friend");
  });

  it("keeps the Following tab chronological and limited to people you follow", async () => {
    const me = await registerUser(h.app, "maya");
    const friend = await registerUser(h.app, "friend");
    const stranger = await registerUser(h.app, "stranger");

    await post(stranger.token, { body: "stranger post", audience: "public" });
    await post(friend.token, { body: "friend post", audience: "public" });
    await h.app.inject({
      method: "POST",
      url: "/v1/follows",
      headers: auth(me.token),
      payload: { followeeId: friend.id },
    });

    const following = (await feed(me.token, "?tab=following")).items;
    expect(following.map((p: { body: string }) => p.body)).toEqual(["friend post"]);

    const forYou = (await feed(me.token)).items;
    expect(forYou.map((p: { body: string }) => p.body)).toContain("stranger post");
  });

  it("demotes a post with open reports below a clean one", async () => {
    const me = await registerUser(h.app, "maya");
    const author = await registerUser(h.app, "author");
    const reporters = await Promise.all([
      registerUser(h.app, "rita1"),
      registerUser(h.app, "rita2"),
      registerUser(h.app, "rita3"),
    ]);

    const clean = await post(author.token, { body: "a clean post", audience: "public" });
    await new Promise((r) => setTimeout(r, 20));
    const bad = await post(author.token, { body: "a reported post", audience: "public" });

    for (const r of reporters) {
      await h.app.inject({
        method: "POST",
        url: "/v1/reports",
        headers: auth(r.token),
        payload: { targetType: "post", targetId: bad, reason: "spam" },
      });
    }

    const items = (await feed(me.token)).items;
    const cleanIndex = items.findIndex((p: { id: string }) => p.id === clean);
    const badIndex = items.findIndex((p: { id: string }) => p.id === bad);
    expect(cleanIndex).toBeGreaterThanOrEqual(0);
    expect(badIndex).toBeGreaterThanOrEqual(0);
    expect(cleanIndex).toBeLessThan(badIndex);
  });

  it("does not repeat one author more than three times on a page", async () => {
    const me = await registerUser(h.app, "maya");
    const prolific = await registerUser(h.app, "prolific");
    for (let i = 0; i < 6; i += 1) {
      await post(prolific.token, { body: `post ${i}`, audience: "public" });
    }
    const items = (await feed(me.token)).items;
    const fromProlific = items.filter((p: { author: { handle: string } }) => p.author.handle === "prolific");
    expect(fromProlific.length).toBeLessThanOrEqual(3);
  });

  it("paginates the ranked feed without duplicates or gaps", async () => {
    const me = await registerUser(h.app, "maya");
    const authors = await Promise.all([
      registerUser(h.app, "authone"),
      registerUser(h.app, "authtwo"),
      registerUser(h.app, "authtree"),
    ]);
    for (let i = 0; i < 9; i += 1) {
      await post(authors[i % authors.length]!.token, { body: `post ${i}`, audience: "public" });
    }

    const first = await feed(me.token, "?limit=3");
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = await feed(me.token, `?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`);
    const ids = [...first.items, ...second.items].map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still hides a private Circle post from a non-member after ranking", async () => {
    const owner = await registerUser(h.app, "owner");
    const outsider = await registerUser(h.app, "outsider");

    const circle = await h.app.inject({
      method: "POST",
      url: "/v1/circles",
      headers: auth(owner.token),
      payload: { name: "Private crew", privacy: "private" },
    });
    const circleId = circle.json().id;
    await post(owner.token, { body: "circle secret", audience: "circle", circleId });

    const outsiderFeed = (await feed(outsider.token)).items;
    expect(outsiderFeed.map((p: { body: string }) => p.body)).not.toContain("circle secret");
  });
});
