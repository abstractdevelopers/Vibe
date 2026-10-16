import { createHmac, randomUUID } from "node:crypto";
import { formatMinorUnits, parseToMinorUnits, type Money } from "@vibe/shared";
import { hmacHex, safeEqual } from "../ids.js";

/**
 * Payment provider boundary.
 *
 * The spec marks provider selection, country/currency support, fees and
 * settlement as VERIFY. Until a provider is approved, the only implementation
 * is the stub below, which performs no network calls and always reports that
 * nothing has actually been charged. Swapping in a real provider means adding
 * an implementation of this interface, not changing call sites.
 */

export interface CheckoutSession {
  providerRef: string;
  redirectUrl: string | null;
  providerAccepted: boolean;
  requiresConfirmation: boolean;
}

export interface ProviderPaymentEvent {
  provider: string;
  eventId: string;
  type:
    | "payment_succeeded"
    | "payment_failed"
    | "refund_succeeded"
    | "payout_paid"
    | "payout_failed"
    | "payout_reversed"
    | "unknown";
  providerRef: string;
  amount: Money;
  orderReference: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: {
    amount: Money;
    reference: string;
    description: string;
  }): Promise<CheckoutSession>;
  verifyWebhook(rawBody: string, signature: string | undefined, timestamp?: string): boolean;
  parseWebhook(rawBody: string): ProviderPaymentEvent;
}

/**
 * Normalise a provider's raw event name to the internal union.
 *
 * Shared by every adapter so a `payout.paid` from Bachs and a `payout_paid`
 * from the stub are the same event to the webhook handler. Payout events carry
 * a `WD-` order reference; collection events carry a `GIFT-` one.
 */
export function mapProviderEventType(raw: string | undefined): ProviderPaymentEvent["type"] {
  switch (raw) {
    case "collection.succeeded":
    case "checkout.completed":
    case "payment_succeeded":
      return "payment_succeeded";
    case "collection.failed":
    case "collection.underpaid":
    case "payment_failed":
      return "payment_failed";
    case "refund.paid":
    case "refund_succeeded":
      return "refund_succeeded";
    case "payout.paid":
    case "payout.completed":
    case "transfer.succeeded":
    case "payout_paid":
      return "payout_paid";
    case "payout.failed":
    case "transfer.failed":
    case "payout_failed":
      return "payout_failed";
    case "payout.reversed":
    case "transfer.reversed":
    case "payout_reversed":
      return "payout_reversed";
    default:
      return "unknown";
  }
}

class StubPaymentProvider implements PaymentProvider {
  readonly name = "stub";

  constructor(private readonly webhookSecret: string) {}

  async createCheckout(_input: { amount: Money; reference: string; description: string }): Promise<CheckoutSession> {
    return {
      providerRef: `stub_${randomUUID()}`,
      redirectUrl: null,
      providerAccepted: false,
      requiresConfirmation: true,
    };
  }

  verifyWebhook(rawBody: string, signature: string | undefined, _timestamp?: string): boolean {
    if (!signature) return false;
    return safeEqual(signature, hmacHex(this.webhookSecret, rawBody));
  }

  parseWebhook(rawBody: string): ProviderPaymentEvent {
    const parsed = JSON.parse(rawBody) as Partial<ProviderPaymentEvent> & { id?: string };
    return {
      provider: this.name,
      // Bachs (and our own test payloads) carry the event id as `id`; the
      // normalised `eventId` is the fallback.
      eventId: parsed.eventId ?? parsed.id ?? "unknown",
      type: mapProviderEventType(parsed.type),
      providerRef: parsed.providerRef ?? "unknown",
      amount: parsed.amount ?? { amount: 0, currency: "NGN" },
      orderReference: parsed.orderReference ?? null,
    };
  }
}

/**
 * Bachs provider adapter.
 *
 * This is a real integration, not a stub: it calls the Bachs REST API to create
 * a hosted checkout session and verifies the signature on every webhook. It is
 * only constructed when an operator supplies credentials
 * (`PAYMENTS_PROVIDER=bachs` + `BACHS_API_KEY`).
 *
 * Two things this adapter deliberately does NOT do:
 *   1. It never reports a payment as succeeded. Only a signature-verified
 *      webhook can do that (the caller applies it via the webhook inbox).
 *   2. It never treats a redirect or a browser event as proof of payment.
 *
 * Money note: Vibe stores integer minor units; Bachs takes a decimal string
 * ("29.00"). The conversion goes through `formatMinorUnits`, so it is exact.
 */
class BachsPaymentProvider implements PaymentProvider {
  readonly name = "bachs";

  constructor(
    private readonly apiKey: string,
    private readonly webhookSecret: string,
    private readonly baseUrl: string,
    private readonly webUrl: string,
    private readonly apiUrl: string,
  ) {}

  async createCheckout(input: { amount: Money; reference: string; description: string }): Promise<CheckoutSession> {
    const body = {
      // Bachs charges a raw amount via `pricing`, with no catalog product.
      pricing: {
        type: "fixed",
        amount: formatMinorUnits(input.amount.amount, input.amount.currency),
        currency: input.amount.currency.toUpperCase(),
      },
      success_url: `${this.webUrl}/payments/return?reference=${encodeURIComponent(input.reference)}`,
      cancel_url: `${this.webUrl}/payments/cancel?reference=${encodeURIComponent(input.reference)}`,
      reference: input.reference,
      description: input.description,
      // Where Bachs delivers state changes. Fulfilment happens on this webhook.
      webhook_url: `${this.apiUrl}/v1/webhooks/payments`,
    };

    const res = await fetch(`${this.baseUrl}/v1/checkout-sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        // Idempotent on Bachs' side too, so a retry cannot create two sessions.
        "idempotency-key": input.reference,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Bachs checkout failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as { checkout_id?: string; checkout_url?: string; status?: string };
    return {
      providerRef: json.checkout_id ?? input.reference,
      redirectUrl: json.checkout_url ?? null,
      // Bachs has accepted the request, not the payment. Success still requires
      // a verified webhook, so the client sees "awaiting_confirmation".
      providerAccepted: true,
      requiresConfirmation: true,
    };
  }

  verifyWebhook(rawBody: string, signature: string | undefined, timestamp?: string): boolean {
    if (!signature || !timestamp) return false;
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    // Reject stale deliveries to blunt replay (§4.7: webhook replay).
    if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
    // Bachs signs "{timestamp}.{raw_body}" with HMAC-SHA256, hex.
    const expected = hmacHex(this.webhookSecret, `${timestamp}.${rawBody}`);
    const provided = signature.includes("v1=") ? (signature.split("v1=")[1]?.split(",")[0] ?? "") : signature;
    return safeEqual(provided, expected);
  }

  parseWebhook(rawBody: string): ProviderPaymentEvent {
    const parsed = JSON.parse(rawBody) as {
      id?: string;
      type?: string;
      data?: {
        id?: string;
        reference?: string;
        amount?: string | number;
        currency?: string;
        checkout_id?: string;
        metadata?: { reference?: string };
      };
    };
    const type = parsed.type ?? "unknown";
    const amountRaw = parsed.data?.amount;
    const currency = (parsed.data?.currency ?? "NGN").toUpperCase();
    let amount: Money = { amount: 0, currency };
    if (amountRaw !== undefined && amountRaw !== null) {
      // Bachs reports a decimal string; parse it into minor units exactly.
      amount = { amount: parseToMinorUnits(String(amountRaw), currency), currency };
    }
    const mapped: ProviderPaymentEvent["type"] = mapProviderEventType(type);
    return {
      provider: this.name,
      eventId: parsed.id ?? "unknown",
      type: mapped,
      providerRef: parsed.data?.checkout_id ?? parsed.data?.id ?? "unknown",
      amount,
      orderReference: parsed.data?.reference ?? parsed.data?.metadata?.reference ?? null,
    };
  }
}

export function createPaymentProvider(
  name: string,
  webhookSecret: string,
  opts?: { apiKey?: string; baseUrl?: string; webUrl?: string; apiUrl?: string },
): PaymentProvider {
  if (name === "stub") return new StubPaymentProvider(webhookSecret);
  if (name === "bachs") {
    if (!opts?.apiKey) throw new Error("BACHS_API_KEY is required for the bachs provider");
    if (!opts.baseUrl) throw new Error("BACHS_BASE_URL is required for the bachs provider");
    return new BachsPaymentProvider(
      opts.apiKey,
      webhookSecret,
      opts.baseUrl,
      opts.webUrl ?? "http://localhost:12001",
      opts.apiUrl ?? "http://localhost:12000",
    );
  }
  throw new Error(`Unknown payment provider "${name}". Use "stub" or "bachs".`);
}
