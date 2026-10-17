import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * Regression: a `room.join` sent the instant the socket opens must not be lost.
 *
 * The web client sends `room.join` in `onopen`, but the server resolves the
 * session (and circle memberships) with awaits before it can register the
 * socket. Frames that arrive during those awaits used to be dropped, so a
 * socket silently received nothing from its room — which is why a live room
 * could look "connected" and still be deaf. This drives the real socket route
 * end to end, with the join fired before the server could possibly be ready.
 */
let h: Harness;
let host: TestUser;
let a: TestUser;
let b: TestUser;
let base: string;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.pool);
  host = await registerUser(h.app, "ws_host");
  a = await registerUser(h.app, "ws_a");
  b = await registerUser(h.app, "ws_b");
  const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
  base = address.replace(/^http/, "ws");
});
afterAll(async () => h.close());

/** Open a socket and join `roomId` immediately on open, like the client does. */
function join(roomId: string, token: string) {
  const ws = new WebSocket(`${base}/v1/realtime?token=${token}`);
  const frames: Array<{ type: string; payload?: unknown }> = [];
  const ready = new Promise<void>((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "room.join", roomId })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "realtime.ready") resolve();
      else frames.push(msg);
    });
    ws.on("error", reject);
  });
  return { ws, frames, ready };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("realtime room join", () => {
  it("does not drop a room.join sent before the server finished setting up", async () => {
    const room = (await h.app.inject({
      method: "POST", url: "/v1/activities/rooms", headers: auth(host.token),
      payload: { kind: "voice", title: "Open mic", startsAt: new Date().toISOString(), durationMinutes: 60, visibility: "public" },
    })).json().room;

    const listener = join(room.id, a.token);
    const speaker = join(room.id, b.token);
    await Promise.all([listener.ready, speaker.ready]);
    // Let the queued joins reach the hub before signalling.
    await settle(300);

    speaker.ws.send(JSON.stringify({ type: "rtc.offer", roomId: room.id, to: a.id, payload: { sdp: "x" } }));
    await settle(400);

    const got = listener.frames.find((f) => f.type === "rtc.offer");
    expect(got, "listener never received the offer — its join was lost").toBeTruthy();
    expect((got!.payload as { from?: string }).from).toBe(b.id);

    listener.ws.close();
    speaker.ws.close();
  });
});
