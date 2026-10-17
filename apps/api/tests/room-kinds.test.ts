import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * Per-kind room features: a match room's scoreboard (which must cite a source),
 * a listening room's queue, and the broadcast/open-mic format.
 */
let h: Harness;
let host: TestUser;
let fan: TestUser;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.pool);
  host = await registerUser(h.app, "kindhost");
  fan = await registerUser(h.app, "kindfan");
});
afterAll(async () => h.close());

const soon = () => new Date(Date.now() + 5 * 60_000);

async function makeRoom(kind: string, extra: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: "POST", url: "/v1/activities/rooms", headers: auth(host.token),
    payload: { kind, title: `${kind} room`, startsAt: soon().toISOString(), durationMinutes: 60, visibility: "public", ...extra },
  });
  return res.json().room;
}

describe("per-kind room features", () => {
  it("keeps a scoreboard only for a match room", async () => {
    const voice = await makeRoom("voice");
    const res = await h.app.inject({
      method: "PUT", url: `/v1/activities/rooms/${voice.id}/score`, headers: auth(host.token),
      payload: { homeLabel: "A", awayLabel: "B", homeScore: 1, awayScore: 0, sourceName: "X" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a score without a source, and stores one with it", async () => {
    const room = await makeRoom("sports");
    const noSource = await h.app.inject({
      method: "PUT", url: `/v1/activities/rooms/${room.id}/score`, headers: auth(host.token),
      payload: { homeLabel: "Eagles", awayLabel: "Ghana", homeScore: 1, awayScore: 0 },
    });
    expect(noSource.statusCode).toBe(422);

    const ok = await h.app.inject({
      method: "PUT", url: `/v1/activities/rooms/${room.id}/score`, headers: auth(host.token),
      payload: { homeLabel: "Eagles", awayLabel: "Ghana", homeScore: 2, awayScore: 1, minute: "67'", sourceName: "BBC Sport", sourceUrl: "https://bbc.co.uk/sport" },
    });
    expect(ok.statusCode).toBe(200);
    const view = ok.json().score;
    expect(view.homeScore).toBe(2);
    expect(view.sourceName).toBe("BBC Sport");

    // Anyone who can see the room can read the score, source included.
    const read = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${room.id}/score`, headers: auth(fan.token) });
    expect(read.json().score.sourceName).toBe("BBC Sport");
  });

  it("only the host may post a score", async () => {
    const room = await makeRoom("sports");
    const res = await h.app.inject({
      method: "PUT", url: `/v1/activities/rooms/${room.id}/score`, headers: auth(fan.token),
      payload: { homeLabel: "A", awayLabel: "B", homeScore: 1, awayScore: 0, sourceName: "X" },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("queues tracks in a listening room and advances them", async () => {
    const room = await makeRoom("listen");
    const add = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/queue`, headers: auth(host.token),
      payload: { title: "Essence", artist: "Wizkid" },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().queue.length).toBe(1);

    await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/queue`, headers: auth(host.token),
      payload: { title: "Last Last", artist: "Burna Boy" },
    });

    const next = await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${room.id}/queue/next`, headers: auth(host.token), payload: {} });
    expect(next.statusCode).toBe(200);
    // The first track is now playing; the second is still queued.
    expect(next.json().room.audioTrack.title).toBe("Essence");
    expect(next.json().queue.length).toBe(1);
    expect(next.json().queue[0].title).toBe("Last Last");
  });

  it("has no queue on a match room", async () => {
    const room = await makeRoom("sports");
    const res = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/queue`, headers: auth(host.token), payload: { title: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("remembers a room's format", async () => {
    const stage = await makeRoom("voice");
    expect(stage.layout).toBe("stage");
    const broadcast = await makeRoom("voice", { layout: "broadcast" });
    expect(broadcast.layout).toBe("broadcast");
    // A host can switch format later.
    const patched = await h.app.inject({
      method: "PATCH", url: `/v1/activities/rooms/${stage.id}`, headers: auth(host.token), payload: { layout: "broadcast" },
    });
    expect(patched.json().room.layout).toBe("broadcast");
  });
});
