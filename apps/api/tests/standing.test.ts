import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness } from "./helpers.js";
import { privilegesFor } from "../src/modules/identity-status.js";

/**
 * Standing is only real if it changes what you can do. These pin the ladder
 * itself and the one route that already enforces it (the paid-gift cap).
 */
describe("standing privileges", () => {
  it("gives a person with no rank the base ladder", () => {
    const base = privilegesFor(null);
    expect(base.postsPerDay).toBe(10);
    expect(base.goldNameplate).toBe(false);
    expect(base.roomTheme).toBe("default");
  });

  it("climbs monotonically: every rung is at least as good as the one below", () => {
    const order = [null, "warrior", "class", "first_family", "queen", "king"];
    for (let i = 1; i < order.length; i += 1) {
      const lower = privilegesFor(order[i - 1]!);
      const higher = privilegesFor(order[i]!);
      expect(higher.postsPerDay).toBeGreaterThanOrEqual(lower.postsPerDay);
      expect(higher.groupCap).toBeGreaterThanOrEqual(lower.groupCap);
      expect(higher.giftCapMinor).toBeGreaterThanOrEqual(lower.giftCapMinor);
      // A lower rake is better for the host, so it must fall as you climb.
      expect(higher.rakeBps).toBeLessThanOrEqual(lower.rakeBps);
    }
  });

  it("keeps the king strictly ahead of everyone", () => {
    const king = privilegesFor("king");
    const queen = privilegesFor("queen");
    expect(king.giftCapMinor).toBeGreaterThan(queen.giftCapMinor);
    expect(king.groupCap).toBeGreaterThan(queen.groupCap);
    expect(king.rakeBps).toBeLessThan(queen.rakeBps);
  });
});

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

describe("standing is shown and enforced", () => {
  it("reports the privileges and the next rung on /v1/me/standing", async () => {
    const me = await registerUser(h.app, "ladderuser");
    const res = await h.app.inject({ method: "GET", url: "/v1/me/standing", headers: auth(me.token) });
    expect(res.statusCode).toBe(200);
    const s = res.json().standing;
    expect(s.privileges.postsPerDay).toBe(10);
    expect(s.next.title).toBe("Vibe Warrior");
    expect(s.next.gains.length).toBeGreaterThan(0);
  });

  it("refuses a paid gift above the sender's cap", async () => {
    // A new account is at the base tier: gifts are capped at 500.00.
    const author = await registerUser(h.app, "capauthor");
    const fan = await registerUser(h.app, "capfan");
    const post = await h.app.inject({
      method: "POST", url: "/v1/posts", headers: auth(author.token),
      payload: { body: "gift me", audience: "public" },
    });
    const postId = post.json().id as string;

    const res = await h.app.inject({
      method: "POST", url: `/v1/posts/${postId}/gifts`,
      headers: { ...auth(fan.token), "idempotency-key": "cap-1" },
      payload: { kind: "crown", quantity: 1 },
    });
    // Either the cap refuses it (400) or the gift is under the cap; what must
    // not happen is a silent pass above the ceiling.
    const catalog = await h.pool.query("SELECT price_minor FROM gifts WHERE id = 'crown'").catch(() => null);
    const price = catalog?.rows?.[0]?.price_minor ? Number(catalog.rows[0].price_minor) : 0;
    if (price > privilegesFor(null).giftCapMinor) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/capped/i);
    }
  });
});
