import { describe, expect, it } from "vitest";
import { formatMoney } from "../src/money";

describe("formatMoney", () => {
  it("renders whole amounts with a symbol and thousands separators", () => {
    expect(formatMoney(125000, "NGN")).toBe("₦1,250");
    expect(formatMoney(100000000, "NGN")).toBe("₦1,000,000");
    expect(formatMoney(0, "NGN")).toBe("₦0");
  });

  it("keeps the cents when there are any, and pads them", () => {
    expect(formatMoney(1250, "USD")).toBe("$12.50");
    expect(formatMoney(1205, "USD")).toBe("$12.05");
    expect(formatMoney(125000, "USD")).toBe("$1,250");
  });

  it("renders the sign on a negative amount", () => {
    expect(formatMoney(-125000, "NGN")).toBe("-₦1,250");
    expect(formatMoney(-1250, "USD")).toBe("-$12.50");
  });

  it("does not divide a zero-exponent currency", () => {
    // JPY has no minor unit, so 1250 is 1,250 yen, not 12.50.
    expect(formatMoney(1250, "JPY")).toBe("JPY 1,250");
  });

  it("falls back to the code for an unknown currency", () => {
    expect(formatMoney(125000, "ZAR")).toBe("ZAR 1,250");
    expect(formatMoney(125000, "zar")).toBe("ZAR 1,250");
  });

  it("handles a missing currency without throwing", () => {
    expect(formatMoney(125000, "")).toBe(" 1,250");
  });
});
