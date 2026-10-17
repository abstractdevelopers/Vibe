import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type Harness } from "./helpers.js";

/**
 * Security headers. These only shape what a browser may do with a response, so
 * they can never lock an operator out of the box; the tests pin the ones that
 * matter and the one that must stay conditional.
 */
let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => h.close());

describe("security headers", () => {
  it("sets baseline hardening headers on every response", async () => {
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'self'");
  });

  it("does not send HSTS over plain HTTP", async () => {
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends HSTS when the proxy reports https", async () => {
    const res = await h.app.inject({
      method: "GET", url: "/health", headers: { "x-forwarded-proto": "https" },
    });
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
  });
});
