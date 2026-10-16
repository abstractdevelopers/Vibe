import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * Phase 5 AI assistance (§4.10) and the cross-cutting push and search surfaces.
 *
 * The AI rule under test: the endpoint only ever *proposes*. Accepting a
 * suggestion records intent and creates nothing, so an AI cannot take a
 * consequential action on its own.
 */
describe("ai assistance, push, and search", () => {
  let h: Harness;
  let me: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    me = await registerUser(h.app, "planner");
  });
  afterAll(async () => h.close());

  it("proposes a draft plan without creating one", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/assist/propose", headers: auth(me.token),
      payload: { kind: "draft_plan", prompt: "Sunday brunch" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().generated).toBe(true);
    expect(res.json().title).toMatch(/draft plan/i);
    // Nothing was created: accepting would be the next, separate, human step.
    const plans = await h.pool.query("SELECT count(*)::int AS n FROM plans");
    expect(plans.rows[0].n).toBe(0);
  });

  it("summarizes a Circle only for a member", async () => {
    const circle = await h.app.inject({
      method: "POST", url: "/v1/circles", headers: auth(me.token),
      payload: { name: "Housemates", privacy: "private" },
    });
    const circleId = circle.json().id;
    const res = await h.app.inject({
      method: "POST", url: "/v1/assist/propose", headers: auth(me.token),
      payload: { kind: "summarize_circle", entityId: circleId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().body).toMatch(/member/i);

    const outsider = await registerUser(h.app, "outsider");
    const denied = await h.app.inject({
      method: "POST", url: "/v1/assist/propose", headers: auth(outsider.token),
      payload: { kind: "summarize_circle", entityId: circleId },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("proposes a budget using integer minor units", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/assist/propose", headers: auth(me.token),
      payload: { kind: "propose_budget", totalMinor: 1000, people: 3 },
    });
    expect(res.json().fields.perHeadMinor).toBe(334);
  });

  it("accepting a suggestion records intent and creates nothing", async () => {
    const proposed = await h.app.inject({
      method: "POST", url: "/v1/assist/propose", headers: auth(me.token),
      payload: { kind: "draft_plan", prompt: "Picnic" },
    });
    const id = proposed.json().id;
    const accepted = await h.app.inject({
      method: "POST", url: `/v1/assist/suggestions/${id}/accept`, headers: auth(me.token),
    });
    expect(accepted.json().status).toBe("accepted");
    const plans = await h.pool.query("SELECT count(*)::int AS n FROM plans");
    expect(plans.rows[0].n).toBe(0);
  });

  it("registers a device token and never echoes the raw token", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/push/devices", headers: auth(me.token),
      payload: { platform: "android", token: "device-token-abcdef123456" },
    });
    expect(res.statusCode).toBe(201);
    const list = await h.app.inject({ method: "GET", url: "/v1/push/devices", headers: auth(me.token) });
    expect(list.json().devices[0].tokenHint).toBe("123456");
    expect(JSON.stringify(list.json())).not.toContain("device-token-abcdef123456");
    // The delivery seam is honestly reported as the no-op stub.
    expect(list.json().deliveryProvider).toBe("stub");
  });

  it("searches only content the searcher may see", async () => {
    // A public post is findable by anyone.
    const publicPost = await h.app.inject({
      method: "POST", url: "/v1/posts", headers: auth(me.token),
      payload: { body: "sunset picnic at the marina", audience: "public" },
    });
    expect(publicPost.statusCode).toBe(201);

    const stranger = await registerUser(h.app, "stranger");
    const found = await h.app.inject({
      method: "GET", url: "/v1/search/posts?q=picnic", headers: auth(stranger.token),
    });
    expect(found.json().items.map((i: { id: string }) => i.id)).toContain(publicPost.json().id);

    // A private post is not findable by a stranger.
    const privatePost = await h.app.inject({
      method: "POST", url: "/v1/posts", headers: auth(me.token),
      payload: { body: "secret picnic plan", audience: "private" },
    });
    const notFound = await h.app.inject({
      method: "GET", url: "/v1/search/posts?q=secret", headers: auth(stranger.token),
    });
    expect(notFound.json().items.map((i: { id: string }) => i.id)).not.toContain(privatePost.json().id);
  });

  it("publishes an OpenAPI document that lists the new surfaces", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/v1/feed"].get).toBeTruthy();
    expect(doc.paths["/v1/events/{id}/checkin"].post).toBeTruthy();
    expect(doc.paths["/v1/admin/campaigns"].get).toBeTruthy();
    expect(doc.paths["/v1/assist/propose"].post).toBeTruthy();
    expect(doc.paths["/v1/pass"].post).toBeTruthy();
  });

  it("lists only my merchants, with verification state", async () => {
    const owner = await registerUser(h.app, "shopkeep");
    await h.app.inject({ method: "POST", url: "/v1/merchants", headers: auth(owner.token), payload: { name: "My Store" } });
    await h.app.inject({ method: "POST", url: "/v1/merchants", headers: auth(me.token), payload: { name: "Mine" } });
    const mine = await h.app.inject({ method: "GET", url: "/v1/merchants/mine", headers: auth(me.token) });
    const names = mine.json().merchants.map((m: { name: string }) => m.name);
    expect(names).toContain("Mine");
    expect(names).not.toContain("My Store");
  });
});
