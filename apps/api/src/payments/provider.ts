import { createHmac, randomUUID } from "node:crypto";
import type { Money } from "@vibe/shared";
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
  type: "payment_succeeded" | "payment_failed" | "refund_succeeded" | "unknown";
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
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  parseWebhook(rawBody: string): ProviderPaymentEvent;
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

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    return safeEqual(signature, hmacHex(this.webhookSecret, rawBody));
  }

  parseWebhook(rawBody: string): ProviderPaymentEvent {
    const parsed = JSON.parse(rawBody) as Partial<ProviderPaymentEvent>;
    return {
      provider: this.name,
      eventId: parsed.eventId ?? "unknown",
      type: parsed.type ?? "unknown",
      providerRef: parsed.providerRef ?? "unknown",
      amount: parsed.amount ?? { amount: 0, currency: "NGN" },
      orderReference: parsed.orderReference ?? null,
    };
  }
}

export function createPaymentProvider(name: string, webhookSecret: string): PaymentProvider {
  if (name === "stub") return new StubPaymentProvider(webhookSecret);
  throw new Error(`Unknown payment provider "${name}". Only "stub" is enabled until a provider is approved.`);
}
