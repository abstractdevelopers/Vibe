/**
 * Payout boundary.
 *
 * Vibe does not move money itself. A payout provider registers a bank account
 * and executes the transfer; Vibe records what is owed in the ledger and asks
 * the provider to settle it. Swapping providers means adding an implementation
 * of this interface, not changing the ledger or the routes.
 *
 * Every method returns the provider's own reference so a result can be
 * reconciled later. Nothing here reports a payout as paid: only a
 * signature-verified provider webhook can do that, exactly like a charge.
 */

import { formatMinorUnits, parseToMinorUnits } from "@vibe/shared";

/**
 * A provider refused a call. `status` is the provider's HTTP status, so a bad
 * bank account (400/422) can be reported as a client error and an outage
 * (5xx) as `provider_unavailable`, instead of surfacing as a generic 500.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface PayoutDestination {
  providerDestinationId: string;
  /** Provider-side review state. A destination is unusable until approved. */
  status: "pending" | "approved" | "rejected" | "disabled";
  bankName: string | null;
  bankCode: string | null;
  accountName: string | null;
  accountLast4: string | null;
  currency: string;
  isUsable: boolean;
}

export interface PayoutResult {
  providerRef: string;
  status: "requested" | "processing" | "paid" | "failed";
  feeMinor: number | null;
  failureReason: string | null;
}

export interface PayoutProvider {
  readonly name: string;
  createDestination(input: {
    accountName: string;
    accountNumber: string;
    bankCode: string;
    currency: string;
    label: string;
  }): Promise<PayoutDestination>;
  listDestinations(): Promise<PayoutDestination[]>;
  createPayout(input: {
    providerDestinationId: string;
    amountMinor: number;
    currency: string;
    reference: string;
    narration: string;
  }): Promise<PayoutResult>;
  getPayout(providerRef: string): Promise<PayoutResult | null>;
}

/** Refuses every call. The default, so an unconfigured deployment cannot pay out. */
class DisabledPayoutProvider implements PayoutProvider {
  readonly name = "disabled";
  private fail(): never {
    throw new Error("Payouts are not configured for this deployment");
  }
  async createDestination(): Promise<PayoutDestination> { this.fail(); }
  async listDestinations(): Promise<PayoutDestination[]> { return []; }
  async createPayout(): Promise<PayoutResult> { this.fail(); }
  async getPayout(): Promise<PayoutResult | null> { return null; }
}

interface BachsDestinationPayload {
  id: string;
  status?: string;
  currency?: string;
  account_number?: string | null;
  account_name?: string | null;
  bank_code?: string | null;
  bank_name?: string | null;
  is_usable?: boolean;
}

/**
 * Bachs payouts. Confirmed against the live API: POST /v1/payouts takes
 * `destination` plus an amount and currency; POST /v1/payouts/destinations
 * registers a bank account and returns a `pd_...` id that must reach
 * `approved` before it can be paid.
 */
class BachsPayoutProvider implements PayoutProvider {
  readonly name = "bachs";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let code: string | null = null;
      let message = `The payout provider refused this request (${res.status}).`;
      try {
        const parsed = JSON.parse(detail) as { error_code?: string; detail?: string };
        code = parsed.error_code ?? null;
        if (parsed.detail) message = parsed.detail;
      } catch {
        // Non-JSON body; keep the generic message.
      }
      throw new ProviderError(message, res.status, code);
    }
    return res.json();
  }

  private static mapDestination(d: BachsDestinationPayload): PayoutDestination {
    const raw = (d.status ?? "pending").toLowerCase();
    const status: PayoutDestination["status"] =
      raw === "approved" ? "approved" : raw === "rejected" ? "rejected" : raw === "disabled" ? "disabled" : "pending";
    return {
      providerDestinationId: d.id,
      status,
      bankName: d.bank_name ?? null,
      bankCode: d.bank_code ?? null,
      accountName: d.account_name ?? null,
      // Never return the full account number to the client; last 4 is enough
      // for a person to recognise their own account.
      accountLast4: d.account_number ? d.account_number.slice(-4) : null,
      currency: (d.currency ?? "NGN").toUpperCase(),
      isUsable: d.is_usable ?? false,
    };
  }

  async createDestination(input: {
    accountName: string;
    accountNumber: string;
    bankCode: string;
    currency: string;
    label: string;
  }): Promise<PayoutDestination> {
    const json = (await this.call("/v1/payouts/destinations", {
      method: "POST",
      body: JSON.stringify({
        type: "bank_account",
        currency: input.currency.toUpperCase(),
        name: input.label,
        account_name: input.accountName,
        account_number: input.accountNumber,
        bank_code: input.bankCode,
      }),
    })) as BachsDestinationPayload;
    return BachsPayoutProvider.mapDestination(json);
  }

  async listDestinations(): Promise<PayoutDestination[]> {
    const json = (await this.call("/v1/payouts/destinations")) as { destinations?: BachsDestinationPayload[] };
    return (json.destinations ?? []).map(BachsPayoutProvider.mapDestination);
  }

  async createPayout(input: {
    providerDestinationId: string;
    amountMinor: number;
    currency: string;
    reference: string;
    narration: string;
  }): Promise<PayoutResult> {
    const json = (await this.call("/v1/payouts", {
      method: "POST",
      // The provider's own idempotency, so a retried request cannot pay twice.
      headers: { "idempotency-key": input.reference },
      body: JSON.stringify({
        destination: input.providerDestinationId,
        // Bachs takes a decimal string ("1000.00"); the conversion is exact.
        amount: formatMinorUnits(input.amountMinor, input.currency),
        currency: input.currency.toUpperCase(),
        reference: input.reference,
        narration: input.narration,
      }),
    })) as { id?: string; status?: string; fee?: string; failure_reason?: string | null };
    const raw = (json.status ?? "requested").toLowerCase();
    return {
      providerRef: json.id ?? input.reference,
      status: raw === "paid" || raw === "completed" ? "paid" : raw === "failed" ? "failed" : "processing",
      feeMinor: json.fee ? parseToMinorUnits(String(json.fee), input.currency) : null,
      failureReason: json.failure_reason ?? null,
    };
  }

  async getPayout(providerRef: string): Promise<PayoutResult | null> {
    const json = (await this.call(`/v1/payouts/${encodeURIComponent(providerRef)}`)) as {
      id?: string;
      status?: string;
      fee?: string;
      currency?: string;
      failure_reason?: string | null;
    };
    const raw = (json.status ?? "").toLowerCase();
    return {
      providerRef: json.id ?? providerRef,
      status: raw === "paid" || raw === "completed" ? "paid" : raw === "failed" ? "failed" : "processing",
      // The provider reports its fee in the payout's currency; convert exactly.
      feeMinor: json.fee ? parseToMinorUnits(String(json.fee), json.currency ?? "NGN") : null,
      failureReason: json.failure_reason ?? null,
    };
  }
}

export function createPayoutProvider(
  name: string,
  opts?: { apiKey?: string; baseUrl?: string },
): PayoutProvider {
  if (name === "bachs" && opts?.apiKey && opts.baseUrl) {
    return new BachsPayoutProvider(opts.apiKey, opts.baseUrl);
  }
  return new DisabledPayoutProvider();
}
