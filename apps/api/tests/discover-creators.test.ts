import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness } from "./helpers.js";

/**
 * The feed's discovery rail shows people worth following. The one rule that
 * matters is that it never shows someone the viewer already follows — a
 * "people to follow" rail full of people you follow is noise — and that it
 * respects the same privacy and safety filters as everything else.
 */
let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

type Creator = { id: string; handle: string; engagement?: number; followerCount?: number; followsBack?: boolean };

async function creators(token: string): Promise<Creator[]> {
  const res = await h.app.inject({ method: "GET", url: "/v1/discover/creators", headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json().users as Creator[];
}

describe("discovery rail: people to follow", () => {
  it("suggests someone the viewer does not follow, and drops them once followed", async () => {
    const me = await registerUser(h.app, "railme");
    const other = await registerUser(h.app, "railother");

    const before = await creators(me.token);
    expect(before.some((u) => u.id === other.id)).toBe(true);

    const follow = await h.app.inject({
      method: "POST", url: "/v1/follows", headers: auth(me.token), payload: { followeeId: other.id },
    });
    expect([200, 201]).toContain(follow.statusCode);

    const after = await creators(me.token);
    expect(after.some((u) => u.id === other.id)).toBe(false);
  });

  it("never suggests the viewer themselves", async () => {
    const me = await registerUser(h.app, "railsolo");
    const list = await creators(me.token);
    expect(list.some((u) => u.id === me.id)).toBe(false);
  });

  it("keeps a blocked account out of the rail", async () => {
    const me = await registerUser(h.app, "railblocker");
    const blocked = await registerUser(h.app, "railblocked");
    await h.app.inject({
      method: "POST", url: `/v1/users/${blocked.id}/block`, headers: auth(me.token), payload: {},
    });
    const list = await creators(me.token);
    expect(list.some((u) => u.id === blocked.id)).toBe(false);
  });

  it("ranks a creator with real engagement above a bigger follower count", async () => {
    const me = await registerUser(h.app, "railviewer");
    const quiet = await registerUser(h.app, "railquiet");
    const lively = await registerUser(h.app, "raillively");
    const fanA = await registerUser(h.app, "railfan1");
    const fanB = await registerUser(h.app, "railfan2");
    const fanC = await registerUser(h.app, "railfan3");

    // The quiet creator has more followers, but no engagement on their posts.
    for (const fan of [fanA, fanB, fanC]) {
      await h.app.inject({ method: "POST", url: "/v1/follows", headers: auth(fan.token), payload: { followeeId: quiet.id } });
    }
    await h.app.inject({ method: "POST", url: "/v1/posts", headers: auth(quiet.token), payload: { body: "quiet", audience: "public" } });

    // The lively creator has no followers, but their post draws real replies.
    const livelyPost = await h.app.inject({ method: "POST", url: "/v1/posts", headers: auth(lively.token), payload: { body: "lively", audience: "public" } });
    const postId = livelyPost.json().id as string;
    for (const fan of [fanA, fanB, fanC]) {
      await h.app.inject({ method: "POST", url: `/v1/posts/${postId}/comments`, headers: auth(fan.token), payload: { body: "nice" } });
    }

    const list = await creators(me.token);
    const livelyRow = list.find((u) => u.id === lively.id);
    const quietRow = list.find((u) => u.id === quiet.id);
    expect(livelyRow?.engagement ?? 0).toBeGreaterThan(quietRow?.engagement ?? 0);
    expect(list.findIndex((u) => u.id === lively.id)).toBeLessThan(list.findIndex((u) => u.id === quiet.id));
  });

  it("puts someone who follows the viewer at the top of the rail", async () => {
    const me = await registerUser(h.app, "railback");
    const admirer = await registerUser(h.app, "railadmirer");
    // Admire me first, so the rail's default (newest first) would not favour them.
    await h.app.inject({ method: "POST", url: "/v1/follows", headers: auth(admirer.token), payload: { followeeId: me.id } });
    await registerUser(h.app, "railnewer");

    const list = await creators(me.token);
    expect(list[0]?.id).toBe(admirer.id);
    expect(list[0]?.followsBack).toBe(true);
  });
});
