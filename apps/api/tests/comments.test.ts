import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./helpers.js";
import { auth, createHarness, registerUser, resetDb } from "./helpers.js";

async function createPost(h: Harness, token: string, body = "hello") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/posts",
    headers: { ...auth(token), "idempotency-key": `post-${Math.random()}` },
    payload: { body, audience: "public" },
  });
  return res.json().id as string;
}

describe("post delete and undo", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await resetDb(h.pool);
  });
  afterEach(async () => {
    await h.close();
  });

  it("hides a deleted post from the feed and restores it on undo", async () => {
    const zara = await registerUser(h.app, "zara");
    const postId = await createPost(h, zara.token, "delete me");

    const del = await h.app.inject({ method: "DELETE", url: `/v1/posts/${postId}`, headers: auth(zara.token) });
    expect(del.statusCode).toBe(204);

    let feed = await h.app.inject({ method: "GET", url: "/v1/feed?limit=20", headers: auth(zara.token) });
    expect(feed.json().items.find((i: { id: string }) => i.id === postId)).toBeFalsy();

    const undo = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/restore`,
      headers: auth(zara.token),
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().restored).toBe(true);

    feed = await h.app.inject({ method: "GET", url: "/v1/feed?limit=20", headers: auth(zara.token) });
    expect(feed.json().items.find((i: { id: string }) => i.id === postId)).toBeTruthy();
  });

  it("refuses an undo from someone other than the author", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const postId = await createPost(h, zara.token);
    await h.app.inject({ method: "DELETE", url: `/v1/posts/${postId}`, headers: auth(zara.token) });

    const undo = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/restore`,
      headers: auth(ada.token),
    });
    expect(undo.statusCode).toBe(403);
  });

  it("does not let an author undo a moderator removal", async () => {
    const zara = await registerUser(h.app, "zara");
    const postId = await createPost(h, zara.token);
    // Simulate a moderation removal (no deleted_by set to the author).
    await h.pool.query("UPDATE posts SET status = 'removed', deleted_by = NULL, deleted_at = now() WHERE id = $1", [
      postId,
    ]);

    const undo = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/restore`,
      headers: auth(zara.token),
    });
    expect(undo.statusCode).toBe(403);
  });
});

describe("comment replies", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await resetDb(h.pool);
  });
  afterEach(async () => {
    await h.close();
  });

  it("nests a reply under its parent and notifies the parent author", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const postId = await createPost(h, zara.token);

    const parent = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(ada.token),
      payload: { body: "top level" },
    });
    const parentId = parent.json().id;

    const reply = await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(zara.token),
      payload: { body: "a reply", parentId },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().parentId).toBe(parentId);

    const thread = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(zara.token),
    });
    const roots = thread.json().comments;
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe(parentId);
    expect(roots[0].replies).toHaveLength(1);
    expect(roots[0].replies[0].body).toBe("a reply");

    // Ada (the parent author) should have been notified, not Zara herself.
    const notes = await h.app.inject({ method: "GET", url: "/v1/notifications", headers: auth(ada.token) });
    expect(notes.json().notifications.some((n: { type: string }) => n.type === "comment.reply")).toBe(true);
  });

  it("flattens a reply-to-a-reply onto the same root", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const postId = await createPost(h, zara.token);
    const root = (
      await h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/comments`,
        headers: auth(ada.token),
        payload: { body: "root" },
      })
    ).json().id;
    const reply = (
      await h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/comments`,
        headers: auth(zara.token),
        payload: { body: "reply", parentId: root },
      })
    ).json().id;
    const nested = (
      await h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/comments`,
        headers: auth(ada.token),
        payload: { body: "reply to reply", parentId: reply },
      })
    ).json();

    expect(nested.parentId).toBe(root);
    const thread = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(zara.token),
    });
    expect(thread.json().comments).toHaveLength(1);
    expect(thread.json().comments[0].replies).toHaveLength(2);
  });
});

describe("comment edit and delete", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await resetDb(h.pool);
  });
  afterEach(async () => {
    await h.close();
  });

  it("records a revision on edit and marks the comment edited", async () => {
    const zara = await registerUser(h.app, "zara");
    const postId = await createPost(h, zara.token);
    const commentId = (
      await h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/comments`,
        headers: auth(zara.token),
        payload: { body: "first" },
      })
    ).json().id;

    const edited = await h.app.inject({
      method: "PATCH",
      url: `/v1/comments/${commentId}`,
      headers: auth(zara.token),
      payload: { body: "second" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().editedAt).toBeTruthy();

    const revisions = await h.app.inject({
      method: "GET",
      url: `/v1/comments/${commentId}/revisions`,
      headers: auth(zara.token),
    });
    expect(revisions.json().revisions).toHaveLength(1);
    expect(revisions.json().revisions[0].previous_body).toBe("first");
    expect(revisions.json().revisions[0].new_body).toBe("second");
  });

  it("soft-deletes a comment, keeps it as a placeholder, and undoes", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const postId = await createPost(h, zara.token);
    const rootId = (
      await h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/comments`,
        headers: auth(zara.token),
        payload: { body: "root" },
      })
    ).json().id;
    await h.app.inject({
      method: "POST",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(ada.token),
      payload: { body: "reply", parentId: rootId },
    });

    const del = await h.app.inject({ method: "DELETE", url: `/v1/comments/${rootId}`, headers: auth(zara.token) });
    expect(del.statusCode).toBe(204);

    // The root survives as a deleted placeholder so the reply is not orphaned.
    let thread = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(zara.token),
    });
    expect(thread.json().comments).toHaveLength(1);
    expect(thread.json().comments[0].deleted).toBe(true);
    expect(thread.json().comments[0].body).toBe("");
    expect(thread.json().comments[0].replies).toHaveLength(1);

    const undo = await h.app.inject({
      method: "POST",
      url: `/v1/comments/${rootId}/restore`,
      headers: auth(zara.token),
    });
    expect(undo.json().restored).toBe(true);
    thread = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(zara.token),
    });
    expect(thread.json().comments[0].deleted).toBe(false);
    expect(thread.json().comments[0].body).toBe("root");
  });

  it("drops a deleted comment with no replies from the thread", async () => {
    const zara = await registerUser(h.app, "zara");
    const postId = await createPost(h, zara.token);
    const commentId = (
      await h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/comments`,
        headers: auth(zara.token),
        payload: { body: "lonely" },
      })
    ).json().id;
    await h.app.inject({ method: "DELETE", url: `/v1/comments/${commentId}`, headers: auth(zara.token) });
    const thread = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/comments`,
      headers: auth(zara.token),
    });
    expect(thread.json().comments).toHaveLength(0);
  });

  it("refuses to edit or delete someone else's comment", async () => {
    const zara = await registerUser(h.app, "zara");
    const ada = await registerUser(h.app, "ada");
    const postId = await createPost(h, zara.token);
    const commentId = (
      await h.app.inject({
        method: "POST",
        url: `/v1/posts/${postId}/comments`,
        headers: auth(zara.token),
        payload: { body: "mine" },
      })
    ).json().id;

    const edit = await h.app.inject({
      method: "PATCH",
      url: `/v1/comments/${commentId}`,
      headers: auth(ada.token),
      payload: { body: "hacked" },
    });
    expect(edit.statusCode).toBe(403);
    const del = await h.app.inject({ method: "DELETE", url: `/v1/comments/${commentId}`, headers: auth(ada.token) });
    expect(del.statusCode).toBe(403);
  });
});
