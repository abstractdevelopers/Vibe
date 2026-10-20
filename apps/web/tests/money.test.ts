import { describe, expect, it } from "vitest";
import { formatMoney, toMinorUnits } from "../src/money";

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

describe("toMinorUnits", () => {
  it("scales a two-decimal amount by 100", () => {
    expect(toMinorUnits("12.50", "NGN")).toBe(1250);
    expect(toMinorUnits("5000", "NGN")).toBe(500000);
    expect(toMinorUnits("0.01", "USD")).toBe(1);
  });

  it("does not scale a zero-decimal currency", () => {
    // The old forms did `Number(x) * 100`, so a 500 yen budget became 50,000.
    expect(toMinorUnits("500", "JPY")).toBe(500);
    expect(toMinorUnits("1250", "KRW")).toBe(1250);
  });

  it("round-trips through formatMoney", () => {
    for (const [input, currency] of [["12.50", "USD"], ["500", "JPY"], ["12.05", "NGN"]] as const) {
      const minor = toMinorUnits(input, currency);
      expect(formatMoney(minor!, currency).replace(/[^0-9.]/g, "")).toBe(input);
    }
  });

  it("rejects text that is not an amount", () => {
    expect(toMinorUnits("", "NGN")).toBeNull();
    expect(toMinorUnits("abc", "NGN")).toBeNull();
    expect(toMinorUnits("1.2.3", "NGN")).toBeNull();
  });

  it("rejects more precision than the currency supports", () => {
    expect(toMinorUnits("1.234", "NGN")).toBeNull();
    expect(toMinorUnits("1.5", "JPY")).toBeNull();
  });
});
