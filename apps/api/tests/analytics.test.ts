import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./helpers.js";
import { auth, createHarness, registerUser, resetDb } from "./helpers.js";
import { ANALYTICS_EVENTS, pruneAnalytics } from "../src/modules/analytics.js";

/**
 * Analytics (§10): allow-listed names, no message bodies or payment data, and a
 * retention policy that actually removes old rows.
 */
describe("analytics instrumentation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await resetDb(h.pool);
  });
  afterEach(async () => {
    await h.close();
  });

  it("emits server-side events for real actions", async () => {
    const alice = await registerUser(h.app, "analytics_a");
    await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: { ...auth(alice.token), "idempotency-key": "a1" },
      payload: { body: "a post", audience: "public" },
    });
    // Server events are fire-and-forget so they never block a request, which
    // means they land just after the response. Poll briefly for them.
    const deadline = Date.now() + 2000;
    let names: string[] = [];
    while (Date.now() < deadline) {
      const rows = await h.pool.query<{ name: string }>(
        "SELECT name FROM analytics_events WHERE user_id = $1 ORDER BY created_at",
        [alice.id],
      );
      names = rows.rows.map((r) => r.name);
      if (names.includes("post_created")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(names).toContain("signup_completed");
    expect(names).toContain("post_created");
  });

  it("rejects unknown event names from a tampered client", async () => {
    const alice = await registerUser(h.app, "analytics_b");
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/analytics/events",
      headers: auth(alice.token),
      payload: {
        events: [
          { name: "feed_viewed", properties: { tab: "for_you" } },
          { name: "exfiltrate_everything", properties: { body: "secret" } },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
    const rows = await h.pool.query<{ name: string }>("SELECT name FROM analytics_events WHERE user_id = $1", [alice.id]);
    const names = rows.rows.map((r) => r.name);
    expect(names).toContain("feed_viewed");
    expect(names).not.toContain("exfiltrate_everything");
  });

  it("drops non-allow-listed properties so a body cannot be smuggled in", async () => {
    const alice = await registerUser(h.app, "analytics_c");
    await h.app.inject({
      method: "POST",
      url: "/v1/analytics/events",
      headers: auth(alice.token),
      payload: { events: [{ name: "post_viewed", properties: { entityId: "p1", messageBody: "top secret" } }] },
    });
    const row = await h.pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM analytics_events WHERE user_id = $1 AND name = 'post_viewed'",
      [alice.id],
    );
    expect(row.rows[0]!.properties.entityId).toBe("p1");
    expect(row.rows[0]!.properties.messageBody).toBeUndefined();
    expect(JSON.stringify(row.rows[0]!.properties)).not.toContain("top secret");
  });

  it("enforces the retention window when pruning", async () => {
    const alice = await registerUser(h.app, "analytics_d");
    await h.pool.query(
      "UPDATE analytics_events SET created_at = now() - interval '200 days' WHERE user_id = $1",
      [alice.id],
    );
    const removed = await pruneAnalytics(h.pool, 90);
    expect(removed).toBeGreaterThan(0);
    const left = await h.pool.query("SELECT 1 FROM analytics_events WHERE user_id = $1", [alice.id]);
    expect(left.rowCount).toBe(0);
  });

  it("keeps the event-name list aligned with the spec vocabulary", () => {
    // A guard so a rename cannot silently drop a spec event.
    for (const required of ["signup_completed", "payment_reported", "payment_verified", "ad_impression", "notification_opted_out"]) {
      expect(ANALYTICS_EVENTS).toContain(required as never);
    }
  });
});
