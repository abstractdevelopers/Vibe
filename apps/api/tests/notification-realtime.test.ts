import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RealtimeHub } from "../src/realtime.js";
import { notifyUsers } from "../src/modules/notifications.js";
import type { AppContext } from "../src/http.js";
import { createHarness, registerUser, resetDb, type Harness, type TestUser } from "./helpers.js";

/**
 * A notification row used to be invisible until the recipient reloaded: it was
 * written to Postgres and nothing told the open socket. notifyUsers now
 * publishes to exactly the recipients who actually got a row, so the unread
 * badge moves live — and stays silent for anyone who opted the family out.
 *
 * This drives notifyUsers against the real database and a real hub, with a
 * socket subscribed the same way the app subscribes one.
 */
let h: Harness;
let hub: RealtimeHub;
let user: TestUser;

// notifyUsers touches only ctx.pool and ctx.hub, so the real pool and hub are
// all it needs; the rest of AppContext is unrelated to this path.
const ctx = { pool: undefined as never, hub: undefined as never } as unknown as AppContext;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
  hub = new RealtimeHub();
  ctx.pool = h.pool;
  ctx.hub = hub;
  user = await registerUser(h.app, "notif_target");
});
afterAll(async () => h.close());

function fakeSocket() {
  const sent: string[] = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
  } as unknown as import("ws").WebSocket & { sent: string[] };
}

describe("notification realtime", () => {
  it("publishes notification.created to a recipient with a socket open", async () => {
    const socket = fakeSocket();
    hub.subscribe(socket, user.id, []);
    await notifyUsers(ctx, [user.id], "plan.created", "plan", "de979b23-32e2-4798-acdd-86b4e9ee5184", { title: "Tea" });

    expect(socket.sent.length).toBe(1);
    const frame = JSON.parse(socket.sent[0]!);
    expect(frame.type).toBe("notification.created");
    expect(frame.entityId).toBe("de979b23-32e2-4798-acdd-86b4e9ee5184");
    // The frame is a hint, not the payload: the row is fetched over HTTP.
    expect(frame.payload).toEqual({ type: "plan.created", entityType: "plan", entityId: "de979b23-32e2-4798-acdd-86b4e9ee5184" });
    expect(JSON.stringify(frame.payload)).not.toContain("Tea");
  });

  it("writes the row and does not wobble when no socket is open", async () => {
    await notifyUsers(ctx, [user.id], "plan.created", "plan", "32424d99-94fd-4d8b-a60f-c6fdacd0a3f2", {});
    const rows = await h.pool.query("SELECT type FROM notifications WHERE user_id = $1", [user.id]);
    expect(rows.rows).toEqual([{ type: "plan.created" }]);
  });

  it("stays silent for a recipient who opted the family out", async () => {
    const socket = fakeSocket();
    hub.subscribe(socket, user.id, []);
    await h.pool.query("UPDATE users SET notification_prefs = $2 WHERE id = $1", [user.id, { plan_invite: false }]);
    await notifyUsers(ctx, [user.id], "plan.created", "plan", "de5a7396-eea4-4301-8337-d55a2f2e156c", {});

    expect(socket.sent.length).toBe(0);
    const rows = await h.pool.query("SELECT count(*) AS n FROM notifications WHERE user_id = $1", [user.id]);
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });
});
