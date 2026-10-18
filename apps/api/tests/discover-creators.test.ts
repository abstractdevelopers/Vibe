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

async function creators(token: string) {
  const res = await h.app.inject({ method: "GET", url: "/v1/discover/creators", headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json().users as Array<{ id: string; handle: string }>;
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
});
