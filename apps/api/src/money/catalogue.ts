/**
 * Paid gift catalogue.
 *
 * Prices are in integer minor units (kobo). The spread is deliberate and starts
 * low: a gift someone can actually afford on a whim, up to a full-screen
 * spectacle. `feeBps` is Vibe's cut, stored per gift so a purchase's split is
 * reproducible even after the fee changes.
 *
 * `tier` drives the presentation only: 1 is a single element, 2 fills the card,
 * 3 takes the screen. It carries no money.
 */
export interface CatalogueGift {
  id: string;
  label: string;
  hint: string;
  emoji: string;
  tier: 1 | 2 | 3;
  priceMinor: number;
  currency: string;
  feeBps: number;
  sortOrder: number;
}

/** Vibe's share of a gift. 30% — the remainder is creator earnings. */
export const GIFT_FEE_BPS = 3000;

export const GIFT_CATALOGUE: CatalogueGift[] = [
  { id: "rose", label: "Rose", hint: "A small thank you", emoji: "🌹", tier: 1, priceMinor: 20_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 10 },
  { id: "spark", label: "Spark", hint: "You lit this up", emoji: "✨", tier: 1, priceMinor: 50_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 20 },
  { id: "heart", label: "Heart", hint: "Genuine love", emoji: "💖", tier: 1, priceMinor: 100_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 30 },
  { id: "fire", label: "Fire", hint: "This is great", emoji: "🔥", tier: 2, priceMinor: 200_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 40 },
  { id: "drum", label: "Talking drum", hint: "Make some noise", emoji: "🪘", tier: 2, priceMinor: 500_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 50 },
  { id: "crown", label: "Crown", hint: "For royalty", emoji: "👑", tier: 2, priceMinor: 1_000_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 60 },
  { id: "rocket", label: "Rocket", hint: "Take off", emoji: "🚀", tier: 3, priceMinor: 2_500_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 70 },
  { id: "galaxy", label: "Galaxy", hint: "The whole room sees it", emoji: "🌌", tier: 3, priceMinor: 5_000_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 80 },
  { id: "lion", label: "Lion", hint: "Bold support", emoji: "🦁", tier: 3, priceMinor: 10_000_000, currency: "NGN", feeBps: GIFT_FEE_BPS, sortOrder: 90 },
];

/** Split a purchase into what Vibe keeps and what the recipient earns. */
export function splitGift(amountMinor: number, feeBps: number): { feeMinor: number; recipientMinor: number } {
  // Floor the fee so rounding never takes more than the stated share, and the
  // recipient's half is never short.
  const feeMinor = Math.floor((amountMinor * feeBps) / 10_000);
  return { feeMinor, recipientMinor: amountMinor - feeMinor };
}
