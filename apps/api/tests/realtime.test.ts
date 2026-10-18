import { describe, expect, it } from "vitest";
import { RealtimeHub, type RealtimeBus, type RealtimeEvent } from "../src/realtime.js";

/** A fake socket that records what it received. */
function fakeSocket() {
  const sent: string[] = [];
  return {
    sent,
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
  } as unknown as import("ws").WebSocket & { sent: string[] };
}

/** An in-memory bus that records publishes and can echo them back. */
function fakeBus() {
  const published: Array<{ scope: string; key: string; event: RealtimeEvent }> = [];
  let handler: ((scope: "room" | "circle" | "users", key: string, event: RealtimeEvent) => void) | null = null;
  const bus: RealtimeBus = {
    publish(scope, key, event) { published.push({ scope, key, event }); },
    onMessage(h) { handler = h; },
    async close() { /* nothing */ },
  };
  return { bus, published, echo: (scope: "room" | "circle" | "users", key: string, event: RealtimeEvent) => handler?.(scope, key, event) };
}

describe("realtime hub", () => {
  // The Live list is not inside any room, so a room ending or being deleted used
  // to be invisible to it until a manual refresh. A broadcast reaches every
  // socket, including one that never joined a room.
  it("broadcasts a public lifecycle change to sockets that are in no room", () => {
    const hub = new RealtimeHub();
    const watcher = fakeSocket();
    hub.subscribe(watcher, "user-watch", []);
    hub.publishBroadcast({ type: "rooms.changed", entityId: "room-9", payload: { roomId: "room-9", change: "deleted" } });
    expect(watcher.sent.length).toBe(1);
    expect(JSON.parse(watcher.sent[0]!).type).toBe("rooms.changed");
  });

  it("delivers a room event only to sockets present in that room", () => {
    const hub = new RealtimeHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.subscribe(a, "user-a", []);
    hub.subscribe(b, "user-b", []);
    hub.joinRoom(a, "room-1");
    hub.publishToRoom("room-1", { type: "room.reaction", entityId: "room-1", payload: { emoji: "🔥" } });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(0);
  });

  it("skips the sender for addressed signalling", () => {
    const hub = new RealtimeHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.subscribe(a, "user-a", []);
    hub.subscribe(b, "user-b", []);
    hub.joinRoom(a, "room-1");
    hub.joinRoom(b, "room-1");
    hub.publishToRoom("room-1", { type: "rtc.offer", entityId: "room-1", payload: {} }, a);
    expect(a.sent.length).toBe(0);
    expect(b.sent.length).toBe(1);
  });

  it("relays a bus message from another instance to local sockets", () => {
    const { bus, published, echo } = fakeBus();
    const hub = new RealtimeHub(bus);
    const a = fakeSocket();
    hub.subscribe(a, "user-a", []);
    hub.joinRoom(a, "room-1");
    // A publish goes out locally and onto the bus.
    hub.publishToRoom("room-1", { type: "room.updated", entityId: "room-1", payload: {} });
    expect(a.sent.length).toBe(1);
    expect(published.length).toBe(1);
    // A message from a *different* instance arrives through the bus and reaches
    // this instance's socket too — that is the whole point of the bus.
    echo("room", "room-1", { id: "evt_x", type: "room.gift", entityId: "room-1", timestamp: new Date().toISOString(), payload: {} });
    expect(a.sent.length).toBe(2);
  });

  it("sheds load at its socket ceiling", () => {
    const hub = new RealtimeHub(undefined, 2);
    expect(hub.atCapacity()).toBe(false);
    const a = fakeSocket(); const b = fakeSocket();
    hub.subscribe(a, "u1", []);
    hub.subscribe(b, "u2", []);
    expect(hub.atCapacity()).toBe(true);
    expect(hub.socketCount()).toBe(2);
  });

  it("tracks room presence per socket and forgets it on leave", () => {
    const hub = new RealtimeHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.subscribe(a, "user-a", []);
    hub.subscribe(b, "user-b", []);
    hub.joinRoom(a, "room-1");
    hub.joinRoom(b, "room-1");
    expect(hub.roomMembers("room-1").length).toBe(2);
    hub.leaveRoom(a, "room-1");
    expect(hub.roomMembers("room-1").length).toBe(1);
    // A second join is idempotent — no duplicate delivery.
    hub.joinRoom(b, "room-1");
    expect(hub.roomMembers("room-1").length).toBe(1);
  });

  it("delivers circle events only to members of that circle", () => {
    const hub = new RealtimeHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.subscribe(a, "user-a", ["circle-1"]);
    hub.subscribe(b, "user-b", ["circle-2"]);
    hub.publishToCircle("circle-1", { type: "circle.post", entityId: "circle-1", payload: {} });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(0);
  });

  it("delivers a user event to each named user exactly once", () => {
    const hub = new RealtimeHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.subscribe(a, "user-a", []);
    hub.subscribe(b, "user-b", []);
    // The same user named twice must not double-deliver.
    hub.publishToUsers(["user-a", "user-a", "user-b"], { type: "plan.updated", entityId: "p", payload: {} });
    expect(a.sent.length).toBe(1);
    expect(b.sent.length).toBe(1);
  });

  it("drops a socket from every index when it unsubscribes", () => {
    const hub = new RealtimeHub();
    const a = fakeSocket();
    const unsubscribe = hub.subscribe(a, "user-a", ["circle-1"]);
    hub.joinRoom(a, "room-1");
    unsubscribe();
    expect(hub.socketCount()).toBe(0);
    expect(hub.roomMembers("room-1").length).toBe(0);
    // Nothing reaches the socket after unsubscribe, through any scope.
    hub.publishToRoom("room-1", { type: "room.reaction", entityId: "room-1", payload: {} });
    hub.publishToCircle("circle-1", { type: "circle.post", entityId: "circle-1", payload: {} });
    hub.publishToUsers(["user-a"], { type: "plan.updated", entityId: "p", payload: {} });
    expect(a.sent.length).toBe(0);
  });
});
