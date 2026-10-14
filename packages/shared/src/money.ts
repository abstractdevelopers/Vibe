/**
 * Money handling for Vibe.
 *
 * Spec rule: store currency amounts as integer minor units and never use
 * floating-point arithmetic for money. Every split must sum to the total
 * exactly, with deterministic rounding that is shown to the user.
 */

export type MinorUnits = number;

export interface Money {
  amount: MinorUnits;
  currency: string; // ISO 4217, upper-case
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** ISO 4217 currencies whose minor unit is not 2 decimal places. */
const EXPONENTS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  XOF: 0,
  XAF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  return EXPONENTS[code] ?? 2;
}

export function assertValidCurrency(currency: string): string {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new MoneyError(`Invalid ISO 4217 currency code: ${currency}`);
  }
  return code;
}

export function assertMinorUnits(value: number, label = "amount"): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of minor units, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds the safe integer range`);
  }
}

/**
 * Parse a human decimal string ("12.34") into minor units without ever going
 * through a float. Rejects more precision than the currency supports.
 */
export function parseToMinorUnits(input: string, currency: string): MinorUnits {
  const exponent = currencyExponent(currency);
  const raw = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new MoneyError(`Cannot parse "${input}" as a decimal amount`);
  }
  const negative = raw.startsWith("-");
  const [whole = "0", frac = ""] = raw.replace("-", "").split(".");
  if (frac.length > exponent) {
    throw new MoneyError(
      `Amount "${input}" has more precision than ${currency.toUpperCase()} supports (${exponent} decimals)`,
    );
  }
  const padded = frac.padEnd(exponent, "0");
  const value = Number(whole) * 10 ** exponent + Number(padded || "0");
  assertMinorUnits(value);
  return negative ? -value : value;
}

/** Render minor units as a decimal string for display. */
export function formatMinorUnits(amount: MinorUnits, currency: string): string {
  assertMinorUnits(amount);
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(amount);
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const divisor = 10 ** exponent;
  const whole = Math.floor(abs / divisor);
  const frac = String(abs % divisor).padStart(exponent, "0");
  return `${sign}${whole}.${frac}`;
}

export interface Allocation {
  participantId: string;
  amount: MinorUnits;
}

/**
 * Distribute `total` across participants by integer weights.
 *
 * Uses the largest-remainder method so the result is deterministic and sums to
 * the total exactly. Remainder ties are broken by participant order, so the
 * same input always produces the same allocation.
 */
export function allocateByWeights(
  total: MinorUnits,
  weights: Array<{ participantId: string; weight: number }>,
): Allocation[] {
  assertMinorUnits(total, "total");
  if (weights.length === 0) {
    if (total !== 0) throw new MoneyError("Cannot split a non-zero total across no participants");
    return [];
  }
  for (const w of weights) {
    if (!Number.isFinite(w.weight) || w.weight < 0) {
      throw new MoneyError(`Weight for ${w.participantId} must be a non-negative number`);
    }
  }
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight <= 0) {
    throw new MoneyError("At least one participant must carry a positive weight");
  }

  const floors: Allocation[] = [];
  const remainders: Array<{ index: number; remainder: number }> = [];
  let distributed = 0;

  weights.forEach((w, index) => {
    const exact = (total * w.weight) / totalWeight;
    const floor = Math.floor(exact);
    floors.push({ participantId: w.participantId, amount: floor });
    remainders.push({ index, remainder: exact - floor });
    distributed += floor;
  });

  let leftover = total - distributed;
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remainders.length && leftover > 0; i += 1) {
    const target = remainders[i]!;
    floors[target.index]!.amount += 1;
    leftover -= 1;
  }

  return floors;
}

/** Split equally across participants. */
export function splitEqual(total: MinorUnits, participantIds: string[]): Allocation[] {
  if (participantIds.length === 0) {
    if (total !== 0) throw new MoneyError("Cannot split a non-zero total across no participants");
    return [];
  }
  return allocateByWeights(
    total,
    participantIds.map((participantId) => ({ participantId, weight: 1 })),
  );
}

/**
 * Split by explicit amounts. The caller's amounts must already sum to the total
 * exactly; this is the "custom amount" mode and mismatches are an error, not a
 * silent correction.
 */
export function splitCustom(total: MinorUnits, amounts: Allocation[]): Allocation[] {
  assertMinorUnits(total, "total");
  const sum = amounts.reduce((acc, a) => {
    assertMinorUnits(a.amount, `allocation for ${a.participantId}`);
    return acc + a.amount;
  }, 0);
  if (sum !== total) {
    throw new MoneyError(`Custom allocations sum to ${sum} but the total is ${total}`);
  }
  return amounts.map((a) => ({ ...a }));
}

/** Split by percentages given in basis points (10000 = 100%). */
export function splitByPercentage(
  total: MinorUnits,
  shares: Array<{ participantId: string; basisPoints: number }>,
): Allocation[] {
  const sumBp = shares.reduce((acc, s) => {
    if (!Number.isInteger(s.basisPoints) || s.basisPoints < 0) {
      throw new MoneyError(`Percentage for ${s.participantId} must be integer basis points`);
    }
    return acc + s.basisPoints;
  }, 0);
  if (sumBp !== 10000) {
    throw new MoneyError(`Percentages must sum to 10000 basis points, got ${sumBp}`);
  }
  return allocateByWeights(
    total,
    shares.map((s) => ({ participantId: s.participantId, weight: s.basisPoints })),
  );
}

/**
 * Split by itemized line items, each assigned to one participant. Items that
 * belong to several participants are split equally among them.
 */
export interface ItemizedLine {
  amount: MinorUnits;
  participantIds: string[];
}

export function splitItemized(
  total: MinorUnits,
  lines: ItemizedLine[],
  allParticipantIds: string[],
): Allocation[] {
  assertMinorUnits(total, "total");
  const totals = new Map<string, MinorUnits>();
  for (const id of allParticipantIds) totals.set(id, 0);

  let itemized = 0;
  for (const line of lines) {
    assertMinorUnits(line.amount, "line item");
    if (line.participantIds.length === 0) {
      throw new MoneyError("Every line item needs at least one participant");
    }
    itemized += line.amount;
    for (const alloc of splitEqual(line.amount, line.participantIds)) {
      if (!totals.has(alloc.participantId)) {
        throw new MoneyError(`Line item references unknown participant ${alloc.participantId}`);
      }
      totals.set(alloc.participantId, totals.get(alloc.participantId)! + alloc.amount);
    }
  }

  if (itemized !== total) {
    throw new MoneyError(`Itemized lines sum to ${itemized} but the total is ${total}`);
  }

  return allParticipantIds.map((participantId) => ({
    participantId,
    amount: totals.get(participantId)!,
  }));
}

export function sumAllocations(allocations: Allocation[]): MinorUnits {
  return allocations.reduce((acc, a) => acc + a.amount, 0);
}
