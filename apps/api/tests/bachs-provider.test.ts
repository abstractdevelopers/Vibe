import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaymentProvider, mapProviderEventType } from "../src/payments/provider.js";

const SECRET = "whsec_test";

/**
 * The Bachs adapter is a real integration, so it is tested against the shape
 * Bachs documents: the `pricing` checkout body, the `X-Bachs-Signature-V2`
 * scheme, and the `data`-nested webhook payload.
 */
function provider() {
  return createPaymentProvider("bachs", SECRET, {
    apiKey: "sk_test_123",
    baseUrl: "https://api.bachs.io",
    webUrl: "https://vibe.example.com",
    apiUrl: "https://api.vibe.example.com",
  });
}

function signV2(raw: string, ts: number, secret = SECRET) {
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;
}

describe("bachs checkout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the documented pricing body and reads back checkout_url", async () => {
    let captured: { url: string; body: any; headers: Record<string, string> } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      };
      return new Response(JSON.stringify({ checkout_id: "chk_123", checkout_url: "https://checkout.bachs.io/c/abc", status: "open" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const session = await provider().createCheckout({
      amount: { amount: 2_950, currency: "NGN" },
      reference: "GIFT-abc",
      description: "Vibe gift",
    });

    expect(captured!.url).toBe("https://api.bachs.io/v1/checkout-sessions");
    // `pricing` is exactly { currency, amount } with a decimal string.
    expect(captured!.body.pricing).toEqual({ currency: "NGN", amount: "29.50" });
    expect(captured!.body).not.toHaveProperty("webhook_url");
    expect(captured!.body.reference).toBe("GIFT-abc");
    expect(captured!.headers.authorization).toBe("Bearer sk_test_123");
    expect(session.redirectUrl).toBe("https://checkout.bachs.io/c/abc");
    expect(session.providerRef).toBe("chk_123");
    expect(session.requiresConfirmation).toBe(true);
  });

  it("never reports a checkout as accepted payment", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ checkout_id: "chk_1", checkout_url: "https://x", status: "open" }), { status: 200 }),
    );
    const session = await provider().createCheckout({
      amount: { amount: 100, currency: "NGN" },
      reference: "GIFT-1",
      description: "x",
    });
    expect(session.requiresConfirmation).toBe(true);
  });
});

describe("bachs webhook verification", () => {
  it("accepts a fresh, correctly signed V2 delivery", () => {
    const ts = Math.floor(Date.now() / 1000);
    const raw = '{"id":"evt_1","type":"collection.succeeded"}';
    expect(provider().verifyWebhook(raw, signV2(raw, ts), String(ts))).toBe(true);
  });

  it("rejects a stale delivery", () => {
    const ts = Math.floor(Date.now() / 1000) - 600;
    const raw = '{"id":"evt_1"}';
    expect(provider().verifyWebhook(raw, signV2(raw, ts), String(ts))).toBe(false);
  });

  it("accepts a match on any v1 during a secret rotation", () => {
    const ts = Math.floor(Date.now() / 1000);
    const raw = '{"id":"evt_2"}';
    const good = createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
    // Two signatures: one from an old secret, one current.
    const header = `t=${ts},v1=deadbeef,v1=${good}`;
    expect(provider().verifyWebhook(raw, header, String(ts))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = Math.floor(Date.now() / 1000);
    const raw = '{"id":"evt_3","amount":"10.00"}';
    const sig = signV2(raw, ts);
    expect(provider().verifyWebhook('{"id":"evt_3","amount":"9999.00"}', sig, String(ts))).toBe(false);
  });
});

describe("bachs webhook parsing", () => {
  it("reads the collection fields from the data envelope", () => {
    const event = provider().parseWebhook(
      JSON.stringify({
        id: "evt_9",
        type: "collection.succeeded",
        data: {
          checkout_id: "chk_9",
          reference: "GIFT-9",
          status: "SUCCEEDED",
          amount: "29.50",
          currency: "NGN",
        },
      }),
    );
    expect(event.type).toBe("payment_succeeded");
    expect(event.providerRef).toBe("chk_9");
    expect(event.orderReference).toBe("GIFT-9");
    expect(event.amount).toEqual({ amount: 2_950, currency: "NGN" });
  });

  it("reads a payout's withdrawal id and reference", () => {
    const event = provider().parseWebhook(
      JSON.stringify({
        id: "evt_10",
        type: "payout.paid",
        data: { withdrawal_id: "pay_10", reference: "WD-10", status: "completed", amount: "500.00", currency: "NGN" },
      }),
    );
    expect(event.type).toBe("payout_paid");
    expect(event.providerRef).toBe("pay_10");
    expect(event.orderReference).toBe("WD-10");
  });

  it("treats an OVERPAID collection as a success for fulfilment", () => {
    const event = provider().parseWebhook(
      JSON.stringify({ id: "evt_11", type: "collection.succeeded", data: { status: "OVERPAID", amount: "30.00", currency: "NGN" } }),
    );
    expect(event.type).toBe("payment_succeeded");
  });

  it("maps the provider's event names to the internal union", () => {
    expect(mapProviderEventType("collection.succeeded")).toBe("payment_succeeded");
    expect(mapProviderEventType("collection.underpaid")).toBe("payment_failed");
    expect(mapProviderEventType("payout.paid")).toBe("payout_paid");
    expect(mapProviderEventType("refund.paid")).toBe("refund_succeeded");
  });
});
