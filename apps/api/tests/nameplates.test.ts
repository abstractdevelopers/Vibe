import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness } from "./helpers.js";

/**
 * Nameplates are how status is seen. These check the thing that matters: the
 * title and the worn, numbered frame travel with a name into a feed and a
 * thread, and the batched read agrees with the single-user one.
 */

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

/** Give someone enough activity this week to clear a tier. */
async function makeActive(token: string, posts: number): Promise<void> {
  for (let i = 0; i < posts; i += 1) {
    await h.app.inject({
      method: "POST", url: "/v1/posts", headers: auth(token),
      payload: { body: `activity ${i}`, audience: "public" },
    });
  }
}

describe("nameplates travel with a name", () => {
  it("puts an author's title on their post in the feed", async () => {
    const author = await registerUser(h.app, "titled");
    // Ten posts a week clears "Vibe Class".
    await makeActive(author.token, 10);

    const standing = await h.app.inject({ method: "GET", url: "/v1/me/standing", headers: auth(author.token) });
    expect(standing.json().standing.title).toBe("Vibe Class");

    const feed = await h.app.inject({ method: "GET", url: "/v1/feed?limit=20", headers: auth(author.token) });
    expect(feed.statusCode).toBe(200);
    const mine = (feed.json().items as Array<{ author: { id: string }; nameplate?: { title: string | null } }>)
      .find((i) => i.author.id === author.id);
    expect(mine).toBeTruthy();
    expect(mine!.nameplate?.title).toBe("Vibe Class");
  });

  it("says nothing about someone with no activity", async () => {
    const quiet = await registerUser(h.app, "quietuser");
    await h.app.inject({
      method: "POST", url: "/v1/posts", headers: auth(quiet.token),
      payload: { body: "hello", audience: "public" },
    });
    const feed = await h.app.inject({ method: "GET", url: "/v1/feed?limit=20", headers: auth(quiet.token) });
    const mine = (feed.json().items as Array<{ author: { id: string }; nameplate?: { title: string | null } }>)
      .find((i) => i.author.id === quiet.id);
    expect(mine!.nameplate?.title ?? null).toBeNull();
  });

  it("carries a commenter's nameplate into the thread", async () => {
    const author = await registerUser(h.app, "threadauthor");
    const talker = await registerUser(h.app, "talker");
    await makeActive(talker.token, 10);

    const post = await h.app.inject({
      method: "POST", url: "/v1/posts", headers: auth(author.token),
      payload: { body: "say something", audience: "public" },
    });
    const postId = post.json().id as string;
    const comment = await h.app.inject({
      method: "POST", url: `/v1/posts/${postId}/comments`, headers: auth(talker.token),
      payload: { body: "here I am" },
    });
    expect(comment.statusCode).toBe(201);

    const thread = await h.app.inject({ method: "GET", url: `/v1/posts/${postId}/comments`, headers: auth(author.token) });
    expect(thread.statusCode).toBe(200);
    const first = (thread.json().comments as Array<{ author: { id: string }; nameplate?: { title: string | null } }>)[0];
    expect(first!.author.id).toBe(talker.id);
    expect(first!.nameplate?.title).toBe("Vibe Class");
  });

  it("publishes a title but not the private ladder", async () => {
    const author = await registerUser(h.app, "privateplate");
    await makeActive(author.token, 10);
    const feed = await h.app.inject({ method: "GET", url: "/v1/feed?limit=20", headers: auth(author.token) });
    const mine = (feed.json().items as Array<{ author: { id: string }; nameplate?: Record<string, unknown> }>)
      .find((i) => i.author.id === author.id);
    // A nameplate is a label: the privileges, holder count and next rung stay
    // on /v1/me/standing.
    expect(mine!.nameplate).not.toHaveProperty("privileges");
    expect(mine!.nameplate).not.toHaveProperty("next");
    expect(mine!.nameplate).not.toHaveProperty("holders");
  });
});
