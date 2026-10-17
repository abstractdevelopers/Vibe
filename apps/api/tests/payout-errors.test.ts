import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness } from "./helpers.js";
import { ProviderError, type PayoutProvider, type PayoutDestination, type PayoutResult } from "../src/payments/payouts.js";

/**
 * A payout provider that fails the way Bachs does: a bad bank account is a
 * 400, an outage is a 502. The route must translate those into a client error
 * and a `provider_unavailable`, never a generic 500 with "Something went
 * wrong" — which is what a live run produced before this mapping existed.
 */
class FailingPayoutProvider implements PayoutProvider {
  readonly name = "bachs";
  constructor(private readonly error: ProviderError) {}
  async createDestination(): Promise<PayoutDestination> {
    throw this.error;
  }
  async listDestinations(): Promise<PayoutDestination[]> {
    return [];
  }
  async createPayout(): Promise<PayoutResult> {
    throw this.error;
  }
  async getPayout(): Promise<PayoutResult | null> {
    return null;
  }
}

let harness: Harness;

describe("payout provider errors are not 500s", () => {
  beforeAll(async () => {
    harness = await createHarness(
      undefined,
      new FailingPayoutProvider(
        new ProviderError("We could not confirm this bank account.", 400, "BANK_ACCOUNT_NOT_VERIFIED"),
      ),
    );
    await resetDb(harness.pool);
  });
  afterAll(async () => {
    await harness.close();
  });

  it("maps a provider 4xx to a 400 with the provider's message", async () => {
    const user = await registerUser(harness.app, "payout400");
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/money/destinations",
      headers: auth(user.token),
      payload: { bankCode: "058", accountNumber: "0123456789", accountName: "Test User" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
    expect(res.json().error.message).toContain("bank account");
  });
});

describe("payout provider outage is a 503", () => {
  beforeAll(async () => {
    harness = await createHarness(undefined, new FailingPayoutProvider(new ProviderError("upstream down", 502)));
    await resetDb(harness.pool);
  });
  afterAll(async () => {
    await harness.close();
  });

  it("maps a provider 5xx to provider_unavailable", async () => {
    const user = await registerUser(harness.app, "payout503");
    const res = await harness.app.inject({
      method: "POST",
      url: "/v1/money/destinations",
      headers: auth(user.token),
      payload: { bankCode: "058", accountNumber: "0123456789", accountName: "Test User" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
  });
});
