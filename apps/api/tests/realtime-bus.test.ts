import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { createPool } from "../src/db.js";
import { PostgresBus, RealtimeHub } from "../src/realtime.js";

/**
 * The cross-instance bus, exercised against the real database.
 *
 * Two hubs stand in for two API containers. Each has its own LISTEN connection,
 * exactly as two processes would. An event published on hub A must reach a
 * socket subscribed on hub B — that is what makes a room work when its members
 * are spread across containers.
 */
let pool: pg.Pool;
let clientA: pg.PoolClient;
let clientB: pg.PoolClient;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL ?? "postgres://vibe:vibe@localhost:5432/vibe", 4);
  clientA = await pool.connect();
  clientB = await pool.connect();
});
afterAll(async () => {
  clientA.release();
  clientB.release();
  await pool.end();
});

function fakeSocket() {
  const sent: string[] = [];
  return { sent, readyState: 1, OPEN: 1, send: (d: string) => sent.push(d) } as unknown as import("ws").WebSocket & { sent: string[] };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("postgres realtime bus", () => {
  it("relays a room event from one instance to another", async () => {
    const busA = new PostgresBus(clientA);
    const busB = new PostgresBus(clientB);
    const hubA = new RealtimeHub(busA);
    const hubB = new RealtimeHub(busB);

    const socketOnB = fakeSocket();
    hubB.subscribe(socketOnB, "user-b", []);
    hubB.joinRoom(socketOnB, "room-x");

    // Publish on instance A. Nothing is local to A for this room.
    hubA.publishToRoom("room-x", { type: "room.reaction", entityId: "room-x", payload: { emoji: "🔥" } });

    // NOTIFY delivery is asynchronous; give it a beat.
    for (let i = 0; i < 40 && socketOnB.sent.length === 0; i += 1) await wait(50);

    expect(socketOnB.sent.length).toBe(1);
    expect(JSON.parse(socketOnB.sent[0]!).type).toBe("room.reaction");

    await busA.close();
    await busB.close();
  });

  it("does not double-deliver to the publishing instance", async () => {
    const busA = new PostgresBus(clientA);
    const hubA = new RealtimeHub(busA);
    const socket = fakeSocket();
    hubA.subscribe(socket, "user-a", []);
    hubA.joinRoom(socket, "room-y");

    hubA.publishToRoom("room-y", { type: "room.gift", entityId: "room-y", payload: {} });
    // Local delivery is synchronous.
    expect(socket.sent.length).toBe(1);
    // Wait past the NOTIFY round-trip; the echo must be ignored, not delivered.
    await wait(600);
    expect(socket.sent.length).toBe(1);

    await busA.close();
  });
});
