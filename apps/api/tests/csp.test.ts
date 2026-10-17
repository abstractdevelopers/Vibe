import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, testConfig, type Harness } from "./helpers.js";

/**
 * When the API is on its own origin the web client's fetches are cross-origin,
 * and a `connect-src 'self'` CSP blocks them in the browser — the page loads but
 * every call fails, which looks like a server outage and is easy to misdiagnose.
 * The API origin must therefore be named in connect-src.
 */
describe("content security policy", () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("allows the configured API origin and its WebSocket", async () => {
    const res = await h.app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toBeTruthy();
    expect(csp).toContain(testConfig.PUBLIC_API_URL);
    expect(csp).toContain(testConfig.PUBLIC_API_URL.replace(/^http/, "ws"));
  });
});
