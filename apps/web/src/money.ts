import { currencyExponent, formatMinorUnits, parseToMinorUnits } from "@vibe/shared";

const SYMBOLS: Record<string, string> = { NGN: "₦", USD: "$", GBP: "£", EUR: "€" };

/**
 * Render an amount held in minor units for display: `₦1,250`, `$12.50`.
 *
 * Every screen used to carry its own copy of this, and they disagreed: the same
 * balance read `₦1,250` on the wallet and `1250 NGN` in advertising, which
 * printed the raw minor units. This is the one place the rule lives.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const code = (currency || "").toUpperCase();
  const symbol = SYMBOLS[code] ?? `${code} `;
  const decimals = currencyExponent(code);
  const plain = formatMinorUnits(amountMinor, code);
  const negative = plain.startsWith("-");
  const [whole = "0", frac] = (negative ? plain.slice(1) : plain).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // A trailing zero fraction is noise; a real fraction keeps its places.
  const shown = frac && Number(frac) !== 0 ? `${grouped}.${frac.padEnd(decimals, "0")}` : grouped;
  return `${negative ? "-" : ""}${symbol}${shown}`;
}

/**
 * Turn what someone typed into minor units, using the currency's own exponent.
 *
 * Forms used `Math.round(Number(x) * 100)`, which is right for naira and wrong
 * for a zero-decimal currency: a ¥500 budget would have been stored as 50000
 * minor units and shown as ¥50,000. Going through the shared parser keeps the
 * one place that knows how many decimals a currency has. Returns null when the
 * text is not a valid amount for that currency.
 */
export function toMinorUnits(input: string, currency: string): number | null {
  try {
    return parseToMinorUnits(input, currency);
  } catch {
    return null;
  }
}
