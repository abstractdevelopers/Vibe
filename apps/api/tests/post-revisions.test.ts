import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./helpers.js";
import { auth, createHarness, registerUser, resetDb } from "./helpers.js";

/**
 * Post editing with revision history (§4.2: draft -> published -> edited
 * (revision history)). An edit records the previous body rather than silently
 * overwriting it.
 */
describe("post revisions", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await resetDb(h.pool);
  });
  afterEach(async () => {
    await h.close();
  });

  async function makePost(token: string, body: string) {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(token), "idempotency-key": `p-${Math.random()}` },
      payload: { body, audience: "public" },
    });
    return res.json().id as string;
  }

  it("records the previous body and stamps editedAt", async () => {
    const alice = await registerUser(h.app, "editor");
    const postId = await makePost(alice.token, "first version");

    const edit = await h.app.inject({
      method: "PATCH",
      url: `/v1/posts/${postId}`,
      headers: auth(alice.token),
      payload: { body: "second version" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().editedAt).toBeTruthy();

    const revisions = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/revisions`,
      headers: auth(alice.token),
    });
    expect(revisions.json().revisions.length).toBe(1);
    expect(revisions.json().revisions[0].previous_body).toBe("first version");
    expect(revisions.json().revisions[0].new_body).toBe("second version");

    const row = await h.pool.query<{ body: string; edited_at: Date | null }>(
      "SELECT body, edited_at FROM posts WHERE id = $1",
      [postId],
    );
    expect(row.rows[0]!.body).toBe("second version");
    expect(row.rows[0]!.edited_at).not.toBeNull();
  });

  it("does not write a revision when nothing changed", async () => {
    const alice = await registerUser(h.app, "editor2");
    const postId = await makePost(alice.token, "same text");
    const edit = await h.app.inject({
      method: "PATCH",
      url: `/v1/posts/${postId}`,
      headers: auth(alice.token),
      payload: { body: "same text" },
    });
    expect(edit.json().unchanged).toBe(true);
    const revisions = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/revisions`,
      headers: auth(alice.token),
    });
    expect(revisions.json().revisions.length).toBe(0);
  });

  it("refuses an edit from anyone but the author", async () => {
    const alice = await registerUser(h.app, "owner_p");
    const bob = await registerUser(h.app, "other_p");
    const postId = await makePost(alice.token, "mine");
    const edit = await h.app.inject({
      method: "PATCH",
      url: `/v1/posts/${postId}`,
      headers: auth(bob.token),
      payload: { body: "hijacked" },
    });
    expect(edit.statusCode).toBe(403);
    const revisions = await h.app.inject({
      method: "GET",
      url: `/v1/posts/${postId}/revisions`,
      headers: auth(bob.token),
    });
    expect(revisions.statusCode).toBe(403);
  });
});
