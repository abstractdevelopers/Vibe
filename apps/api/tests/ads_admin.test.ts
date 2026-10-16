import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * Ad delivery and reporting (§4.8) plus the operator console (§9). These cover
 * the parts the spec is strict about: a campaign only runs for a verified
 * business, impressions/clicks cannot be inflated by retries or replays, hide is
 * respected by delivery, and account actions actually take effect.
 */
describe("ad delivery, reporting and admin console", () => {
  let h: Harness;
  let advertiser: TestUser;
  let viewer: TestUser;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    advertiser = await registerUser(h.app, "advertiser");
    viewer = await registerUser(h.app, "viewer");
    const m = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(advertiser.token),
      payload: { name: "Coffee Co", category: "food" },
    });
    merchantId = m.json().id;
  });
  afterAll(async () => h.close());

  async function makeApprovedCampaign(): Promise<string> {
    await h.pool.query("UPDATE merchants SET verification_status = 'verified' WHERE id = $1", [merchantId]);
    // Retire earlier campaigns so delivery picks the one this test just made.
    await h.pool.query("UPDATE campaigns SET status = 'completed' WHERE status IN ('approved', 'active')");
    const created = await h.app.inject({
      method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token),
      payload: {
        name: "Cold brew", objective: "awareness", creative: "Try our cold brew",
        creativeTitle: "Cold brew season", creativeBody: "Iced, smooth, local.",
        creativeCta: "Order now", destinationUrl: "https://example.com/brew",
        budgetMinor: 250000, currency: "NGN", merchantId, frequencyCap: 2,
      },
    });
    const id = created.json().id;
    await h.app.inject({ method: "POST", url: `/v1/campaigns/${id}/submit`, headers: auth(advertiser.token) });
    await h.pool.query("UPDATE users SET is_admin = true WHERE id = $1", [advertiser.id]);
    await h.app.inject({
      method: "POST", url: `/v1/admin/campaigns/${id}/review`, headers: auth(advertiser.token),
      payload: { decision: "approved" },
    });
    return id;
  }

  it("does not deliver a campaign for an unverified business", async () => {
    await h.pool.query("UPDATE campaigns SET status = 'completed' WHERE status IN ('approved', 'active')");
    await h.pool.query("UPDATE merchants SET verification_status = 'unverified' WHERE id = $1", [merchantId]);
    const created = await h.app.inject({
      method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token),
      payload: {
        name: "Hidden", objective: "awareness", creative: "x", destinationUrl: "https://example.com",
        budgetMinor: 1, currency: "NGN", merchantId,
      },
    });
    const id = created.json().id;
    await h.app.inject({ method: "POST", url: `/v1/campaigns/${id}/submit`, headers: auth(advertiser.token) });
    await h.app.inject({
      method: "POST", url: `/v1/admin/campaigns/${id}/review`, headers: auth(advertiser.token),
      payload: { decision: "approved" },
    });
    const feed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(viewer.token) });
    // Either no ad, or not this one — an unverified business never runs.
    expect(feed.json().sponsored?.campaignId).not.toBe(id);
    await h.pool.query("UPDATE merchants SET verification_status = 'verified' WHERE id = $1", [merchantId]);
  });

  it("delivers an approved campaign in the feed with an advertiser identity", async () => {
    // Clear other campaigns so this test is deterministic.
    await h.pool.query("DELETE FROM ad_deliveries");
    const id = await makeApprovedCampaign();
    const feed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(viewer.token) });
    const ad = feed.json().sponsored;
    expect(ad).toBeTruthy();
    expect(ad.campaignId).toBe(id);
    expect(ad.advertiserName).toBeTruthy();
    expect(ad.placementId).toBeTruthy();
  });

  it("counts an impression once even if the beacon is retried", async () => {
    const id = await makeApprovedCampaign();
    const feed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(viewer.token) });
    const ad = feed.json().sponsored;
    expect(ad.campaignId).toBe(id);
    const body = { placementId: ad.placementId, surface: "feed" };
    await h.app.inject({ method: "POST", url: `/v1/ads/${id}/impression`, headers: auth(viewer.token), payload: body });
    await h.app.inject({ method: "POST", url: `/v1/ads/${id}/impression`, headers: auth(viewer.token), payload: body });
    const metrics = await h.app.inject({ method: "GET", url: `/v1/campaigns/${id}/metrics`, headers: auth(advertiser.token) });
    expect(metrics.json().reported.impressions).toBe(1);
    expect(metrics.json().verified.served).toBeGreaterThanOrEqual(1);
  });

  it("counts a click once even if replayed", async () => {
    const id = await makeApprovedCampaign();
    const feed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(viewer.token) });
    const ad = feed.json().sponsored;
    const body = { placementId: ad.placementId, surface: "feed" };
    await h.app.inject({ method: "POST", url: `/v1/ads/${id}/click`, headers: auth(viewer.token), payload: body });
    await h.app.inject({ method: "POST", url: `/v1/ads/${id}/click`, headers: auth(viewer.token), payload: body });
    const metrics = await h.app.inject({ method: "GET", url: `/v1/campaigns/${id}/metrics`, headers: auth(advertiser.token) });
    expect(metrics.json().reported.clicks).toBe(1);
  });

  it("honours a hide: a hidden campaign is not delivered again", async () => {
    const id = await makeApprovedCampaign();
    const before = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(viewer.token) });
    expect(before.json().sponsored?.campaignId).toBe(id);
    await h.app.inject({ method: "POST", url: `/v1/ads/${id}/hide`, headers: auth(viewer.token) });
    const after = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(viewer.token) });
    expect(after.json().sponsored?.campaignId).not.toBe(id);
    const hidden = await h.app.inject({ method: "GET", url: "/v1/ads/hidden", headers: auth(viewer.token) });
    expect(hidden.json().hidden.map((x: { campaign_id: string }) => x.campaign_id)).toContain(id);
  });

  it("refuses delivery for a campaign the advertiser does not own the business of", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/campaigns", headers: auth(viewer.token),
      payload: {
        name: "Not mine", objective: "awareness", creative: "x", destinationUrl: "https://example.com",
        budgetMinor: 1, currency: "NGN", merchantId,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists campaigns awaiting review for an operator", async () => {
    const created = await h.app.inject({
      method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token),
      payload: {
        name: "Queue me", objective: "awareness", creative: "x", destinationUrl: "https://example.com",
        budgetMinor: 1, currency: "NGN", merchantId,
      },
    });
    const id = created.json().id;
    await h.app.inject({ method: "POST", url: `/v1/campaigns/${id}/submit`, headers: auth(advertiser.token) });
    // advertiser is now an admin (set in makeApprovedCampaign)
    const queue = await h.app.inject({ method: "GET", url: "/v1/admin/campaigns", headers: auth(advertiser.token) });
    expect(queue.json().campaigns.map((c: { id: string }) => c.id)).toContain(id);
  });

  it("takes an account action that actually blocks the account", async () => {
    const target = await registerUser(h.app, "troublemaker");
    const suspend = await h.app.inject({
      method: "POST", url: `/v1/admin/users/${target.id}/action`, headers: auth(advertiser.token),
      payload: { action: "suspend", reason: "spam", days: 7 },
    });
    expect(suspend.json().moderationStatus).toBe("suspended");
    // The suspended account's existing token no longer works.
    const blocked = await h.app.inject({ method: "GET", url: "/v1/me", headers: auth(target.token) });
    expect(blocked.statusCode).toBeGreaterThanOrEqual(400);
    // Restore makes it work again.
    await h.app.inject({
      method: "POST", url: `/v1/admin/users/${target.id}/action`, headers: auth(advertiser.token),
      payload: { action: "restore", reason: "appeal granted" },
    });
    const ok = await h.app.inject({ method: "GET", url: "/v1/me", headers: auth(target.token) });
    expect(ok.statusCode).toBe(200);
  });

  it("records an audit event for a staff account action", async () => {
    const target = await registerUser(h.app, "auditee");
    await h.app.inject({
      method: "POST", url: `/v1/admin/users/${target.id}/action`, headers: auth(advertiser.token),
      payload: { action: "warn", reason: "behaviour" },
    });
    const audit = await h.app.inject({ method: "GET", url: "/v1/admin/audit", headers: auth(advertiser.token) });
    expect(audit.json().events.some((e: { action: string; entity_id: string }) => e.action === "account.warn" && e.entity_id === target.id)).toBe(true);
  });
});
