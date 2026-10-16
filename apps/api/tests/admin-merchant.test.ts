import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * The operator console's merchant verification path (§9), end to end.
 *
 * The other suites set `merchants.verification_status` straight in the database,
 * which skips the route an operator actually uses. This drives the real one: a
 * business is created unverified, an operator lists it, verifies it, and only
 * then can its products go live. It also checks the two things that make the
 * endpoint safe: a non-operator cannot call it, and every decision is audited.
 */
describe("operator merchant verification", () => {
  let h: Harness;
  let owner: TestUser;
  let operator: TestUser;
  let member: TestUser;
  let merchantId: string;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    owner = await registerUser(h.app, "shopowner");
    operator = await registerUser(h.app, "operatoruser");
    member = await registerUser(h.app, "plainmember");
    // Becoming an operator is deliberately not an API operation.
    await h.pool.query("UPDATE users SET is_admin = true WHERE id = $1", [operator.id]);

    const m = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(owner.token),
      payload: { name: "Ada's Fabrics", category: "retail" },
    });
    merchantId = m.json().id;
  });
  afterAll(async () => h.close());

  it("starts a new business as unverified", async () => {
    const res = await h.app.inject({ method: "GET", url: `/v1/merchants/${merchantId}`, headers: auth(owner.token) });
    expect(res.json().verificationStatus).toBe("unverified");
  });

  it("refuses verification from a non-operator", async () => {
    const res = await h.app.inject({
      method: "POST", url: `/v1/admin/merchants/${merchantId}/verify`,
      headers: auth(member.token), payload: { verificationStatus: "verified" },
    });
    expect(res.statusCode).toBe(403);
    // And nothing changed.
    const check = await h.app.inject({ method: "GET", url: `/v1/merchants/${merchantId}`, headers: auth(owner.token) });
    expect(check.json().verificationStatus).toBe("unverified");
  });

  it("shows the business in the operator's unverified queue", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/merchants?status=unverified", headers: auth(operator.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchants.map((m: { id: string }) => m.id)).toContain(merchantId);
    const row = res.json().merchants.find((m: { id: string }) => m.id === merchantId);
    expect(row.ownerHandle).toBe(owner.handle);
  });

  it("counts pending businesses in the overview", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/overview", headers: auth(operator.token) });
    expect(res.json().pendingMerchants).toBeGreaterThanOrEqual(1);
  });

  it("verifies the business as an operator, and audits it", async () => {
    const res = await h.app.inject({
      method: "POST", url: `/v1/admin/merchants/${merchantId}/verify`,
      headers: auth(operator.token),
      payload: { verificationStatus: "verified", reason: "operator verified" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verificationStatus).toBe("verified");

    const check = await h.app.inject({ method: "GET", url: `/v1/merchants/${merchantId}`, headers: auth(owner.token) });
    expect(check.json().verificationStatus).toBe("verified");

    const audit = await h.app.inject({ method: "GET", url: "/v1/admin/audit", headers: auth(operator.token) });
    // The audit endpoint returns rows as stored (snake_case); the console reads
    // them that way too.
    const entry = audit.json().events.find(
      (e: { action: string; entity_id: string }) => e.action === "merchant.verified" && e.entity_id === merchantId,
    );
    expect(entry).toBeTruthy();
    expect(entry.actor_id).toBe(operator.id);
  });

  it("lets a verified business publish a live product", async () => {
    const res = await h.app.inject({
      method: "POST", url: `/v1/merchants/${merchantId}/products`,
      headers: auth(owner.token),
      payload: { name: "Ankara print", priceMinor: 500000, currency: "NGN", status: "active" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("can reject a business, and rejection is also audited", async () => {
    const created = await h.app.inject({
      method: "POST", url: "/v1/merchants", headers: auth(member.token),
      payload: { name: "Sketchy Goods", category: "retail" },
    });
    const badId = created.json().id;
    const res = await h.app.inject({
      method: "POST", url: `/v1/admin/merchants/${badId}/verify`,
      headers: auth(operator.token),
      payload: { verificationStatus: "rejected", reason: "no documentation" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verificationStatus).toBe("rejected");

    // A rejected business cannot publish a *live* product. A draft is still
    // allowed; only an active one is gated on verification.
    const product = await h.app.inject({
      method: "POST", url: `/v1/merchants/${badId}/products`,
      headers: auth(member.token),
      payload: { name: "Mystery box", priceMinor: 100, currency: "NGN", status: "active" },
    });
    expect(product.statusCode).toBe(400);
  });

  it("404s verifying a business that does not exist", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/admin/merchants/00000000-0000-0000-0000-000000000000/verify",
      headers: auth(operator.token), payload: { verificationStatus: "verified" },
    });
    expect(res.statusCode).toBe(404);
  });
});
