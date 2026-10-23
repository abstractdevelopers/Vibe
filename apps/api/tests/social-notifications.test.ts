import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./helpers.js";
import { auth, createHarness, registerUser, resetDb } from "./helpers.js";

/**
 * Two social events were silent before this: a new follower, and a like on your
 * post. Both are the kind of thing a person opens the app for, so both now
 * write a notification row (and therefore publish over realtime — notifyUsers
 * does both).
 *
 * The trap this guards is the repeat: a follow is upserted, so a double tap or
 * a retry re-posts the same row, and "notify on every request" would stack
 * duplicates. Reaction has the mirror trap — an un-react is a withdrawal and
 * must not be announced.
 */
describe("social notifications", () => {
  let h: Harness;

  beforeEach(async () => {
    if (!h) h = await createHarness();
    await resetDb(h.pool);
  });
  afterAll(async () => {
    await h.close();
  });

  async function inbox(user: { token: string }) {
    const res = await h.app.inject({ method: "GET", url: "/v1/notifications", headers: auth(user.token) });
    expect(res.statusCode).toBe(200);
    return res.json().notifications as Array<{ type: string; entity_id: string; payload: Record<string, unknown> }>;
  }

  it("tells the followee when someone follows them", async () => {
    const alice = await registerUser(h.app, "followee");
    const bob = await registerUser(h.app, "follower");

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/follows",
      headers: auth(bob.token),
      payload: { followeeId: alice.id },
    });
    expect(res.statusCode).toBe(201);

    const rows = await inbox(alice);
    const follow = rows.find((n) => n.type === "follow.new");
    expect(follow).toBeTruthy();
    expect(follow!.entity_id).toBe(bob.id);
    expect(follow!.payload.actorHandle).toBe("follower");
    expect(follow!.payload.state).toBe("accepted");
  });

  it("does not notify twice when the same follow is posted again", async () => {
    const alice = await registerUser(h.app, "followee2");
    const bob = await registerUser(h.app, "follower2");
    const follow = () =>
      h.app.inject({
        method: "POST",
        url: "/v1/follows",
        headers: auth(bob.token),
        payload: { followeeId: alice.id },
      });

    expect((await follow()).statusCode).toBe(201);
    expect((await follow()).statusCode).toBe(201);

    const rows = (await inbox(alice)).filter((n) => n.type === "follow.new");
    expect(rows).toHaveLength(1);
  });

  it("tells the author when someone likes their post", async () => {
    const author = await registerUser(h.app, "postauthor");
    const reader = await registerUser(h.app, "postreader");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(author.token), "idempotency-key": "like-1" },
      payload: { body: "hello", audience: "public" },
    });
    const postId = created.json().id as string;

    const react = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/reactions`,
      headers: auth(reader.token),
      payload: { kind: "like" },
    });
    expect(react.statusCode).toBe(200);
    expect(react.json().reacted).toBe(true);

    const rows = await inbox(author);
    const like = rows.find((n) => n.type === "post.reaction");
    expect(like).toBeTruthy();
    expect(like!.entity_id).toBe(postId);
    expect(like!.payload.actorHandle).toBe("postreader");
  });

  it("treats an un-like as a withdrawal, not a second event", async () => {
    const author = await registerUser(h.app, "postauthor2");
    const reader = await registerUser(h.app, "postreader2");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(author.token), "idempotency-key": "like-2" },
      payload: { body: "hello again", audience: "public" },
    });
    const postId = created.json().id as string;
    const react = () =>
      h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/reactions`,
        headers: auth(reader.token),
        payload: { kind: "like" },
      });

    expect((await react()).json().reacted).toBe(true);
    expect((await react()).json().reacted).toBe(false);

    const rows = (await inbox(author)).filter((n) => n.type === "post.reaction");
    expect(rows).toHaveLength(1);
  });

  it("never notifies you about your own like", async () => {
    const author = await registerUser(h.app, "selflike");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(author.token), "idempotency-key": "like-3" },
      payload: { body: "my own post", audience: "public" },
    });
    const postId = created.json().id as string;
    await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/reactions`,
      headers: auth(author.token),
      payload: { kind: "like" },
    });

    expect((await inbox(author)).filter((n) => n.type === "post.reaction")).toHaveLength(0);
  });

  it("stays quiet for someone who opted out of Likes", async () => {
    const author = await registerUser(h.app, "optedout");
    const reader = await registerUser(h.app, "optreader");
    // Absent means on; an explicit false is the only way off.
    await h.app.inject({
      method: "PATCH",
      url: "/v1/me/notification-prefs",
      headers: auth(author.token),
      payload: { types: { reaction: false } },
    });
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(author.token), "idempotency-key": "like-4" },
      payload: { body: "quiet post", audience: "public" },
    });
    const postId = created.json().id as string;
    await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/reactions`,
      headers: auth(reader.token),
      payload: { kind: "like" },
    });

    expect((await inbox(author)).filter((n) => n.type === "post.reaction")).toHaveLength(0);
  });
});
