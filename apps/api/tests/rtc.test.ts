import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { turnCredentials } from "../src/modules/rtc.js";

/**
 * WebRTC config is easy to get subtly wrong and hard to notice until a real call
 * fails on a mobile network. Pin the credential scheme here; the browser-side
 * audio profile is covered in the web suite.
 */
describe("TURN credentials", () => {
  it("mints coturn's time-limited username and HMAC-SHA1 password", () => {
    const secret = "shared-secret";
    const now = 1_700_000_000_000;
    const { username, credential, expiry } = turnCredentials(secret, 3600, "user-1", now);

    const expectedExpiry = Math.floor(now / 1000) + 3600;
    expect(expiry).toBe(expectedExpiry);
    expect(username).toBe(`${expectedExpiry}:user-1`);
    const expected = createHmac("sha1", secret).update(username).digest("base64");
    expect(credential).toBe(expected);
  });

  it("expires credentials within the TTL window", () => {
    const now = 1_700_000_000_000;
    const { expiry } = turnCredentials("s", 60, "u", now);
    expect(expiry - Math.floor(now / 1000)).toBe(60);
  });
});
