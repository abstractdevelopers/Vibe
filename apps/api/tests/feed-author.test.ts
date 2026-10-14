import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./helpers.js";
import { auth, createHarness, registerUser, resetDb } from "./helpers.js";

/**
 * Regression: the feed used to serialise `author` from the post row, so
 * `author.id` was the post id rather than the author's user id. That broke
 * "is this my post" checks (edit/delete affordances) and profile links.
 */
describe("feed author identity", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await resetDb(h.pool);
  });
  afterEach(async () => {
    await h.close();
  });

  it("returns the author's user id, not the post id", async () => {
    const alice = await registerUser(h.app, "authorid");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(alice.token), "idempotency-key": "author-1" },
      payload: { body: "hello", audience: "public" },
    });
    const postId = created.json().id;

    const feed = await h.app.inject({ method: "GET", url: "/v1/feed?limit=20", headers: auth(alice.token) });
    const item = feed.json().items.find((i: { id: string }) => i.id === postId);
    expect(item).toBeTruthy();
    expect(item.author.id).toBe(alice.id);
    expect(item.author.id).not.toBe(postId);
    expect(item.author.handle).toBe("authorid");
  });

  it("keeps author identity correct on the following feed and profile list", async () => {
    const alice = await registerUser(h.app, "authorid2");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(alice.token), "idempotency-key": "author-2" },
      payload: { body: "another", audience: "public" },
    });
    const postId = created.json().id;

    const following = await h.app.inject({
      method: "GET",
      url: "/v1/feed?limit=20&tab=following",
      headers: auth(alice.token),
    });
    const fItem = following.json().items.find((i: { id: string }) => i.id === postId);
    expect(fItem.author.id).toBe(alice.id);

    const profile = await h.app.inject({
      method: "GET",
      url: `/v1/users/${alice.id}/posts`,
      headers: auth(alice.token),
    });
    const pItem = profile.json().items.find((i: { id: string }) => i.id === postId);
    expect(pItem.author.id).toBe(alice.id);
  });
});
