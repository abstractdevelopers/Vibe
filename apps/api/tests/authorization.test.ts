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

describe("feed visibility and authorization", () => {
  it("only shows private Circle posts to members", async () => {
    const alice = await registerUser(h.app, "alice");
    const bob = await registerUser(h.app, "bob");
    const mallory = await registerUser(h.app, "mallory");

    const circle = (
      await h.app.inject({
        method: "POST",
        url: "/v1/circles",
        headers: auth(alice.token),
        payload: { name: "Private", privacy: "private" },
      })
    ).json();

    await h.app.inject({
      method: "POST",
      url: `/v1/circles/${circle.id}/invites`,
      headers: auth(alice.token),
      payload: { role: "member" },
    }).then(async (res) => {
      const token = res.json().inviteToken;
      await h.app.inject({ method: "POST", url: `/v1/invites/${token}/accept`, headers: auth(bob.token) });
    });

    const post = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: auth(alice.token),
      payload: { body: "Secret dinner plans", audience: "circle", circleId: circle.id },
    });
    expect(post.statusCode).toBe(201);

    const bobFeed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(bob.token) });
    expect(bobFeed.json().items.map((i: { body: string }) => i.body)).toContain("Secret dinner plans");

    const malloryFeed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(mallory.token) });
    expect(malloryFeed.json().items).toHaveLength(0);
  });

  it("hides posts from blocked users", async () => {
    const alice = await registerUser(h.app, "alice");
    const bob = await registerUser(h.app, "bob");

    await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: auth(bob.token),
      payload: { body: "Public hello", audience: "public" },
    });

    const before = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(alice.token) });
    expect(before.json().items).toHaveLength(1);

    await h.app.inject({ method: "POST", url: `/v1/users/${bob.id}/block`, headers: auth(alice.token) });

    const after = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(alice.token) });
    expect(after.json().items).toHaveLength(0);
  });
});

describe("cursor pagination", () => {
  it("returns distinct pages without duplicates", async () => {
    const alice = await registerUser(h.app, "alice");
    for (let i = 0; i < 5; i += 1) {
      await h.app.inject({
        method: "POST",
        url: "/v1/posts",
        headers: auth(alice.token),
        payload: { body: `Post ${i}`, audience: "public" },
      });
    }

    const first = await h.app.inject({
      method: "GET",
      url: "/v1/feed?limit=2",
      headers: auth(alice.token),
    });
    const firstBody = first.json();
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await h.app.inject({
      method: "GET",
      url: `/v1/feed?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      headers: auth(alice.token),
    });
    const ids = new Set([...firstBody.items, ...second.json().items].map((i: { id: string }) => i.id));
    expect(ids.size).toBe(4);
  });
});

describe("reports and moderation", () => {
  it("records a report and lets an admin action it with an audit trail", async () => {
    const alice = await registerUser(h.app, "alice");
    const bob = await registerUser(h.app, "bob");
    const admin = await registerUser(h.app, "admin");
    await h.pool.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);

    const post = (
      await h.app.inject({
        method: "POST",
        url: "/v1/posts",
        headers: auth(bob.token),
        payload: { body: "Reported content", audience: "public" },
      })
    ).json();

    const report = await h.app.inject({
      method: "POST",
      url: "/v1/reports",
      headers: auth(alice.token),
      payload: { targetType: "post", targetId: post.id, reason: "spam" },
    });
    expect(report.statusCode).toBe(201);

    // A non-admin cannot read the queue.
    const denied = await h.app.inject({ method: "GET", url: "/v1/admin/reports", headers: auth(alice.token) });
    expect(denied.statusCode).toBe(403);

    const queue = await h.app.inject({ method: "GET", url: "/v1/admin/reports", headers: auth(admin.token) });
    expect(queue.json().reports).toHaveLength(1);

    const action = await h.app.inject({
      method: "POST",
      url: `/v1/admin/reports/${report.json().id}/action`,
      headers: auth(admin.token),
      payload: { action: "remove", reason: "spam confirmed" },
    });
    expect(action.statusCode).toBe(200);

    const postRow = await h.pool.query("SELECT status FROM posts WHERE id = $1", [post.id]);
    expect(postRow.rows[0].status).toBe("removed");

    const audit = await h.app.inject({ method: "GET", url: "/v1/admin/audit", headers: auth(admin.token) });
    expect(audit.json().events.some((e: { action: string }) => e.action === "moderation.action")).toBe(true);
  });
});

describe("webhook boundary", () => {
  it("rejects unsigned webhooks and ignores duplicates", async () => {
    const body = JSON.stringify({ eventId: "evt_1", type: "payment_succeeded", amount: { amount: 100, currency: "NGN" } });

    const unsigned = await h.app.inject({
      method: "POST",
      url: "/v1/webhooks/payments",
      payload: body,
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.statusCode).toBe(401);

    // Sign it the way the stub provider expects.
    const { hmacHex } = await import("../src/ids.js");
    const signature = hmacHex("test-webhook-secret", body);

    const first = await h.app.inject({
      method: "POST",
      url: "/v1/webhooks/payments",
      payload: body,
      headers: { "content-type": "application/json", "x-vibe-signature": signature },
    });
    expect(first.statusCode).toBe(202);

    const duplicate = await h.app.inject({
      method: "POST",
      url: "/v1/webhooks/payments",
      payload: body,
      headers: { "content-type": "application/json", "x-vibe-signature": signature },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().status).toBe("duplicate_ignored");

    const rows = await h.pool.query("SELECT count(*)::int AS n FROM provider_webhook_events");
    expect(rows.rows[0].n).toBe(1);
  });
});
