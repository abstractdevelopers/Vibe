import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * Immersive activities addendum: rooms, honest state, spoiler safety, the viral
 * loop, official/automated hosts and GPS-driven Explore.
 */
let h: Harness;
let host: TestUser;
let fan: TestUser;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.pool);
  host = await registerUser(h.app, "roomhost");
  fan = await registerUser(h.app, "roomfan");
});
afterAll(async () => h.close());

const soon = () => new Date(Date.now() + 5 * 60_000);
const past = () => new Date(Date.now() - 5 * 60_000);

async function makeRoom(overrides: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: "POST", url: "/v1/activities/rooms",
    headers: auth(host.token),
    payload: {
      kind: "sports", title: "Eagles vs Ghana", startsAt: soon().toISOString(),
      durationMinutes: 120, visibility: "public", ...overrides,
    },
  });
  return res;
}

describe("activity rooms", () => {
  it("derives live state from the clock and never claims live early", async () => {
    const res = await makeRoom({ startsAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
    expect(res.statusCode).toBe(201);
    const { room } = res.json();
    expect(room.state).toBe("scheduled");

    const live = await makeRoom({ title: "Live now", startsAt: past().toISOString(), durationMinutes: 120 });
    expect(live.json().room.state).toBe("live");

    const soonRes = await makeRoom({ title: "Soon", startsAt: soon().toISOString(), durationMinutes: 120 });
    expect(soonRes.json().room.state).toBe("starting_soon");
  });

  it("lists live rooms ahead of scheduled ones and shows the honest host label", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/activities/live", headers: auth(fan.token) });
    expect(res.statusCode).toBe(200);
    const { rooms } = res.json();
    const states = rooms.map((r: { state: string }) => r.state);
    const firstScheduled = states.indexOf("scheduled");
    const lastLive = states.lastIndexOf("live");
    if (firstScheduled !== -1 && lastLive !== -1) expect(lastLive).toBeLessThan(firstScheduled);
    expect(rooms[0].host.kind).toBe("person");
  });

  it("refuses a synchronized room with no licensed service link", async () => {
    const res = await makeRoom({ kind: "movie", title: "Film night", playbackMode: "synchronized" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/licensed service/i);
  });

  it("hides spoilers in a spoiler-safe room", async () => {
    const room = (await makeRoom({ kind: "movie", title: "Spoiler-safe", spoilerPolicy: "spoiler_safe" })).json().room;
    await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/posts`, headers: auth(host.token),
      payload: { body: "The twist is that he was dead all along" },
    });
    const res = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${room.id}/posts`, headers: auth(fan.token) });
    const post = res.json().posts[0];
    expect(post.hidden).toBe(true);
    expect(post.body).toBeNull();
  });

  it("counts poll votes without framing them as wagers", async () => {
    const room = (await makeRoom({ title: "Score call" })).json().room;
    const poll = (await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/polls`, headers: auth(host.token),
      payload: { question: "Who wins?", options: ["Eagles", "Ghana"] },
    })).json().poll;
    await h.app.inject({
      method: "POST", url: `/v1/activities/polls/${poll.id}/votes`, headers: auth(fan.token),
      payload: { optionId: "o1" },
    });
    const tally = await h.app.inject({ method: "GET", url: `/v1/activities/polls/${poll.id}`, headers: auth(fan.token) });
    const body = tally.json().poll;
    expect(body.totalVotes).toBe(1);
    expect(body.options.find((o: { id: string }) => o.id === "o1").votes).toBe(1);
  });

  it("keeps a private room out of a non-member's reach", async () => {
    const room = (await makeRoom({ title: "Private", visibility: "private" })).json().room;
    const res = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${room.id}`, headers: auth(fan.token) });
    expect(res.statusCode).toBe(404);
  });

  it("lets only the host remove a post", async () => {
    const room = (await makeRoom({ title: "Mod" })).json().room;
    const post = (await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/posts`, headers: auth(fan.token),
      payload: { body: "hello" },
    })).json().post;
    const denied = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/moderate`, headers: auth(fan.token),
      payload: { action: "remove_post", targetId: post.id },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/moderate`, headers: auth(host.token),
      payload: { action: "remove_post", targetId: post.id },
    });
    expect(ok.statusCode).toBe(200);
    const posts = (await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${room.id}/posts`, headers: auth(fan.token) })).json().posts;
    expect(posts.length).toBe(0);
  });
});


// A voice room is a stage plus an audience, the way Clubhouse and Spaces work:
// you arrive as a listener, raise your hand, and the host decides who speaks.
// Joining must never put you on the stage with a live mic. These tests pin that
// a joiner is audience, and that only a host promotion moves them up.
describe("voice room stage", () => {
  const stageOf = async (roomId: string, token: string) => {
    const res = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${roomId}/members`, headers: auth(token) });
    return res.json() as { stage: Array<{ id: string }>; audience: Array<{ id: string }> };
  };

  it("puts a joiner in the audience, never on the stage", async () => {
    const room = await makeRoom({ kind: "voice", title: "Open mic", layout: "stage" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });
    const { stage, audience } = await stageOf(id, host.token);
    expect(audience.some((m) => m.id === fan.id)).toBe(true);
    expect(stage.some((m) => m.id === fan.id)).toBe(false);
  });

  it("lets the host bring a listener up, and only the host", async () => {
    const room = await makeRoom({ kind: "voice", title: "Approval", layout: "stage" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });

    // A listener cannot promote themselves.
    const asFan = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/stage`,
      headers: auth(fan.token), payload: { userId: fan.id, action: "promote" },
    });
    expect(asFan.statusCode).toBeGreaterThanOrEqual(400);

    // The host can.
    const asHost = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/stage`,
      headers: auth(host.token), payload: { userId: fan.id, action: "promote" },
    });
    expect(asHost.statusCode).toBeLessThan(300);
    const { stage } = await stageOf(id, host.token);
    expect(stage.some((m) => m.id === fan.id)).toBe(true);
  });

  it("keeps a listener in the audience of a broadcast voice room", async () => {
    const room = await makeRoom({ kind: "voice", title: "Broadcast", layout: "broadcast" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });
    const { stage, audience } = await stageOf(id, host.token);
    expect(stage.some((m) => m.id === fan.id)).toBe(false);
    expect(audience.some((m) => m.id === fan.id)).toBe(true);
  });

  it("keeps a listener in the audience of a music room", async () => {
    const room = await makeRoom({ kind: "listen", title: "Listening party" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });
    const { audience } = await stageOf(id, host.token);
    expect(audience.some((m) => m.id === fan.id)).toBe(true);
  });

  it("lets the host decline a raised hand without moving the listener", async () => {
    const room = await makeRoom({ kind: "voice", title: "Decline", layout: "stage" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/hand`, headers: auth(fan.token), payload: { raised: true } });
    expect((await stageOf(id, host.token)).audience.some((m) => m.id === fan.id)).toBe(true);

    const res = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/stage`,
      headers: auth(host.token), payload: { userId: fan.id, action: "decline" },
    });
    expect(res.statusCode).toBeLessThan(300);
    const members = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${id}/members`, headers: auth(host.token) });
    const body = members.json() as { audience: Array<{ id: string; handRaised: boolean }> };
    const row = body.audience.find((m) => m.id === fan.id);
    expect(row?.handRaised).toBe(false);
  });
});

// Clubhouse lets a host close the hand queue, and tells the audience. Without
// it the only tool was to keep ignoring hands.
describe("host-controlled hand raising", () => {
  it("defaults to open and lets the host close and reopen it", async () => {
    const room = await makeRoom({ kind: "voice", title: "Hands switch", layout: "stage" });
    const id = room.json().room.id as string;
    expect(room.json().room.allowHands).toBe(true);

    const close = await h.app.inject({
      method: "PATCH", url: `/v1/activities/rooms/${id}`,
      headers: auth(host.token), payload: { allowHands: false },
    });
    expect(close.statusCode).toBeLessThan(300);
    expect(close.json().room.allowHands).toBe(false);

    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });
    const raised = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/hand`,
      headers: auth(fan.token), payload: { raised: true },
    });
    expect(raised.statusCode).toBeGreaterThanOrEqual(400);

    const reopen = await h.app.inject({
      method: "PATCH", url: `/v1/activities/rooms/${id}`,
      headers: auth(host.token), payload: { allowHands: true },
    });
    expect(reopen.json().room.allowHands).toBe(true);
    const raised2 = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/hand`,
      headers: auth(fan.token), payload: { raised: true },
    });
    expect(raised2.statusCode).toBeLessThan(300);
  });

  it("only lets the host change the setting", async () => {
    const room = await makeRoom({ kind: "voice", title: "Hands authz", layout: "stage" });
    const id = room.json().room.id as string;
    const res = await h.app.inject({
      method: "PATCH", url: `/v1/activities/rooms/${id}`,
      headers: auth(fan.token), payload: { allowHands: false },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// Leaving a room used to be invisible: the client navigated away and the member
// row stayed behind, so the room reported a crowd that was not there. The client
// now calls leave, and these pin the server side of that.
describe("leaving a room", () => {
  const membersOf = async (roomId: string, token: string) => {
    const res = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${roomId}/members`, headers: auth(token) });
    return res.json() as { stage: Array<{ id: string }>; audience: Array<{ id: string }> };
  };

  it("removes the leaver from the room and from the member count", async () => {
    const room = await makeRoom({ kind: "voice", title: "Leave test", layout: "stage" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });
    expect((await membersOf(id, host.token)).audience.some((m) => m.id === fan.id)).toBe(true);

    const leave = await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/leave`, headers: auth(fan.token), payload: {} });
    expect(leave.statusCode).toBe(200);

    const after = await membersOf(id, host.token);
    expect(after.stage.some((m) => m.id === fan.id)).toBe(false);
    expect(after.audience.some((m) => m.id === fan.id)).toBe(false);
    const room2 = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${id}`, headers: auth(host.token) });
    expect(room2.json().room.memberCount).toBe(1);
  });
});

// Ending a room is the "meeting is over" control. Before this it only set a flag,
// so a room could still look live and a later visit still reported everyone who
// had been in it.
describe("ending a room", () => {
  it("closes the room and clears its members for the host", async () => {
    const room = await makeRoom({ kind: "voice", title: "End test", startsAt: past().toISOString(), durationMinutes: 120 });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });

    const res = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/moderate`,
      headers: auth(host.token), payload: { action: "close_room" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().room.state).toBe("ended");

    const members = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${id}/members`, headers: auth(host.token) });
    const body = members.json() as { stage: unknown[]; audience: unknown[] };
    expect(body.stage.length).toBe(0);
    expect(body.audience.length).toBe(0);
  });

  it("refuses to end a room you do not host", async () => {
    const room = await makeRoom({ kind: "voice", title: "Not yours" });
    const id = room.json().room.id as string;
    const res = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/moderate`,
      headers: auth(fan.token), payload: { action: "close_room" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// The roster: a host can remove someone, and can silence the whole stage. Before
// this a host could see a name in the audience and do nothing about it.
describe("room roster controls", () => {
  const membersOf = async (roomId: string, token: string) => {
    const res = await h.app.inject({ method: "GET", url: `/v1/activities/rooms/${roomId}/members`, headers: auth(token) });
    return res.json() as { stage: Array<{ id: string; muted: boolean }>; audience: Array<{ id: string }> };
  };

  it("lets the host remove a guest, and refuses when a non-host tries", async () => {
    const room = await makeRoom({ kind: "voice", title: "Kick test", layout: "stage" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });

    const asGuest = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/moderate`,
      headers: auth(fan.token), payload: { action: "kick", targetId: host.id },
    });
    expect(asGuest.statusCode).toBe(403);

    const asHost = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/moderate`,
      headers: auth(host.token), payload: { action: "kick", targetId: fan.id },
    });
    expect(asHost.statusCode).toBe(200);
    const after = await membersOf(id, host.token);
    expect(after.stage.some((m) => m.id === fan.id)).toBe(false);
    expect(after.audience.some((m) => m.id === fan.id)).toBe(false);
  });

  it("refuses to remove the host from their own room", async () => {
    const room = await makeRoom({ kind: "voice", title: "Self kick" });
    const id = room.json().room.id as string;
    const res = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/moderate`,
      headers: auth(host.token), payload: { action: "kick", targetId: host.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("mutes the whole stage but leaves the host alone", async () => {
    const room = await makeRoom({ kind: "voice", title: "Mute all", layout: "stage" });
    const id = room.json().room.id as string;
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${id}/join`, headers: auth(fan.token), payload: {} });
    // Bring the listener up first: a joiner is audience now, and mute_all is
    // about the stage.
    await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/stage`,
      headers: auth(host.token), payload: { userId: fan.id, action: "promote" },
    });
    expect((await membersOf(id, host.token)).stage.some((m) => m.id === fan.id && !m.muted)).toBe(true);

    const res = await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${id}/moderate`,
      headers: auth(host.token), payload: { action: "mute_all" },
    });
    expect(res.statusCode).toBe(200);
    const after = await membersOf(id, host.token);
    expect(after.stage.find((m) => m.id === fan.id)?.muted).toBe(true);
    expect(after.stage.find((m) => m.id === host.id)?.muted).toBe(false);
  });
});


describe("viral loop", () => {
  it("previews a link without a session, then returns the member to the room", async () => {
    const room = (await makeRoom({ title: "Share me" })).json().room;
    const link = (await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/share`, headers: auth(host.token), payload: {},
    })).json().link;
    // Anonymous preview: useful, and does not leak the conversation.
    const preview = await h.app.inject({ method: "GET", url: `/v1/activities/preview/${link.token}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview.title).toBe("Share me");
    expect(preview.json().preview).not.toHaveProperty("posts");

    const opened = await h.app.inject({
      method: "POST", url: `/v1/activities/links/${link.token}/open`, headers: auth(fan.token), payload: {},
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().room.id).toBe(room.id);
    expect(["react_or_vote", "set_reminder"]).toContain(opened.json().firstAction);
  });

  it("stops working once a link is revoked", async () => {
    const room = (await makeRoom({ title: "Revoke me" })).json().room;
    const link = (await h.app.inject({
      method: "POST", url: `/v1/activities/rooms/${room.id}/share`, headers: auth(host.token), payload: {},
    })).json().link;
    await h.app.inject({ method: "POST", url: `/v1/activities/links/${link.token}/revoke`, headers: auth(host.token), payload: {} });
    const preview = await h.app.inject({ method: "GET", url: `/v1/activities/preview/${link.token}` });
    expect(preview.statusCode).toBe(404);
  });
});

describe("official hosts and launch seeding", () => {
  it("labels official hosts honestly and never as a person", async () => {
    const admin = await registerUser(h.app, "launchadmin");
    await h.pool.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
    const res = await h.app.inject({
      method: "POST", url: "/v1/launch/seed-official", headers: auth(admin.token),
      payload: { schedule: [{ kind: "sports", title: "Vibe Matchday: Eagles", startsAt: soon().toISOString(), recurrence: "weekly" }] },
    });
    expect(res.statusCode).toBe(200);
    const hosts = (await h.app.inject({ method: "GET", url: "/v1/launch/official-hosts", headers: auth(fan.token) })).json().hosts;
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.every((h: { host_kind: string }) => h.host_kind !== "person")).toBe(true);
    expect(hosts.every((h: { host_disclosure: string }) => /official/i.test(h.host_disclosure))).toBe(true);
  });

  it("requires admin to seed official programming", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/launch/seed-official", headers: auth(fan.token), payload: { schedule: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("publishes a schedule a new visitor can read", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/launch/schedule", headers: auth(fan.token) });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().schedule)).toBe(true);
  });
});

describe("GPS-driven explore", () => {
  it("rounds a stored position to a coarse band and never returns a precise point", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/me/location", headers: auth(fan.token),
      payload: { lat: 6.524379, lng: 3.379206 },
    });
    expect(res.statusCode).toBe(200);
    const { location } = res.json();
    expect(location.lat).toBe(6.52);
    expect(location.lng).toBe(3.38);
  });

  it("orders Explore by distance when a position is known", async () => {
    await h.app.inject({ method: "POST", url: "/v1/me/location", headers: auth(fan.token), payload: { lat: 6.52, lng: 3.38 } });
    const res = await h.app.inject({ method: "GET", url: "/v1/explore?kind=place", headers: auth(fan.token) });
    expect(res.statusCode).toBe(200);
    // Any place carrying a band gets a distance reason; nothing exposes a point.
    for (const r of res.json().results) {
      expect(r).not.toHaveProperty("lat");
      expect(r).not.toHaveProperty("lng");
    }
  });

  it("clears the stored position on request", async () => {
    await h.app.inject({ method: "DELETE", url: "/v1/me/location", headers: auth(fan.token) });
    const res = await h.app.inject({ method: "GET", url: "/v1/me/location", headers: auth(fan.token) });
    expect(res.json().location).toBeNull();
  });
});

describe("realtime room access", () => {
  it("lets anyone subscribe to a public room, but only members to a private one", async () => {
    const { canAccessRoom } = await import("../src/modules/activities-live.js");
    const publicRoom = (await h.app.inject({
      method: "POST", url: "/v1/activities/rooms", headers: auth(host.token),
      payload: { kind: "voice", title: "Open mic", startsAt: soon().toISOString(), durationMinutes: 60, visibility: "public" },
    })).json().room;
    const privateRoom = (await h.app.inject({
      method: "POST", url: "/v1/activities/rooms", headers: auth(host.token),
      payload: { kind: "voice", title: "Closed", startsAt: soon().toISOString(), durationMinutes: 60, visibility: "private" },
    })).json().room;

    const ctx = { pool: h.pool } as never;
    // A public room is open to any signed-in user.
    expect(await canAccessRoom(ctx, publicRoom.id, fan.id)).toBe(true);
    // A private room is not — not even for a fan who is not a member.
    expect(await canAccessRoom(ctx, privateRoom.id, fan.id)).toBe(false);
    // The host always has access to their own private room.
    expect(await canAccessRoom(ctx, privateRoom.id, host.id)).toBe(true);
    // After joining, the fan is a member and may subscribe.
    await h.app.inject({ method: "POST", url: `/v1/activities/rooms/${privateRoom.id}/join`, headers: auth(host.token), payload: {} });
    await h.pool.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [privateRoom.id, fan.id],
    );
    expect(await canAccessRoom(ctx, privateRoom.id, fan.id)).toBe(true);
    // An unknown room is never accessible.
    expect(await canAccessRoom(ctx, "00000000-0000-0000-0000-000000000000", fan.id)).toBe(false);
  });
});
