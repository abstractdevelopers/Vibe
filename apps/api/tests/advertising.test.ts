import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

describe("advertising manager", () => {
  let h: Harness;
  let advertiser: TestUser;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    advertiser = await registerUser(h.app, "advertiser");
    // A campaign must name a business the advertiser owns. Delivery additionally
    // requires the business to be verified, so this one is verified up front.
    const m = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(advertiser.token),
      payload: { name: "Advertiser Coffee", category: "food" },
    });
    merchantId = m.json().id;
    await h.pool.query("UPDATE merchants SET verification_status = 'verified' WHERE id = $1", [merchantId]);
  });
  afterAll(async () => h.close());

  const base = () => ({
    name: "Launch", objective: "awareness", creative: "Try our coffee",
    destinationUrl: "https://example.com/coffee", budgetMinor: 500000, currency: "NGN",
    merchantId,
  });

  it("creates a campaign as a draft", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token), payload: base() });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("draft");
  });

  it("refuses a regulated category", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token),
      payload: { ...base(), category: "gambling" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not supported/i);
  });

  it("accepts a banner image on a campaign and returns it", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token),
      payload: { ...base(), creativeImageUrl: "/v1/media/abc123.png" },
    });
    expect(res.statusCode).toBe(201);
    const detail = await h.app.inject({
      method: "GET", url: `/v1/campaigns/${res.json().id}`, headers: auth(advertiser.token),
    });
    expect(detail.json().creativeImageUrl).toBe("/v1/media/abc123.png");
  });

  it("refuses a creative image that is not an image URL or media path", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token),
      payload: { ...base(), creativeImageUrl: "javascript:alert(1)" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("moves a draft through submission and only a reviewer can approve", async () => {
    const created = await h.app.inject({ method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token), payload: base() });
    const id = created.json().id;
    const submitted = await h.app.inject({ method: "POST", url: `/v1/campaigns/${id}/submit`, headers: auth(advertiser.token) });
    expect(submitted.json().status).toBe("submitted");

    // The advertiser cannot self-approve.
    const selfApprove = await h.app.inject({
      method: "POST", url: `/v1/admin/campaigns/${id}/review`, headers: auth(advertiser.token),
      payload: { decision: "approved" },
    });
    expect(selfApprove.statusCode).toBe(403);

    // An admin can.
    await h.pool.query("UPDATE users SET is_admin = true WHERE id = $1", [advertiser.id]);
    const adminApprove = await h.app.inject({
      method: "POST", url: `/v1/admin/campaigns/${id}/review`, headers: auth(advertiser.token),
      payload: { decision: "approved" },
    });
    expect(adminApprove.json().status).toBe("approved");
  });

  it("does not let another advertiser view a campaign", async () => {
    const other = await registerUser(h.app, "nosy");
    const created = await h.app.inject({ method: "POST", url: "/v1/campaigns", headers: auth(advertiser.token), payload: base() });
    const res = await h.app.inject({ method: "GET", url: `/v1/campaigns/${created.json().id}`, headers: auth(other.token) });
    expect(res.statusCode).toBe(403);
  });
});
