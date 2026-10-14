import { describe, expect, it } from "vitest";
import {
  allocateByWeights,
  formatMinorUnits,
  parseToMinorUnits,
  splitByPercentage,
  splitCustom,
  splitEqual,
  splitItemized,
  sumAllocations,
  MoneyError,
} from "@vibe/shared";

describe("money parsing and formatting", () => {
  it("parses decimal strings to integer minor units", () => {
    expect(parseToMinorUnits("12.34", "USD")).toBe(1234);
    expect(parseToMinorUnits("0.05", "NGN")).toBe(5);
    expect(parseToMinorUnits("100", "USD")).toBe(10000);
  });

  it("respects currencies with no minor unit", () => {
    expect(parseToMinorUnits("500", "JPY")).toBe(500);
    expect(formatMinorUnits(500, "JPY")).toBe("500");
  });

  it("rejects more precision than the currency supports", () => {
    expect(() => parseToMinorUnits("1.005", "USD")).toThrow(MoneyError);
  });

  it("round-trips through formatting", () => {
    expect(formatMinorUnits(1234, "USD")).toBe("12.34");
    expect(formatMinorUnits(5, "NGN")).toBe("0.05");
  });

  it("rejects non-integer minor units", () => {
    expect(() => formatMinorUnits(12.5, "USD")).toThrow(MoneyError);
  });
});

describe("equal split", () => {
  it("sums to the total exactly", () => {
    const allocations = splitEqual(1000, ["a", "b", "c"]);
    expect(sumAllocations(allocations)).toBe(1000);
  });

  it("distributes the remainder deterministically", () => {
    const allocations = splitEqual(100, ["a", "b", "c"]);
    expect(sumAllocations(allocations)).toBe(100);
    // 100 / 3 = 33.33..., largest remainder gives the first participant the extra unit.
    expect(allocations.map((a) => a.amount)).toEqual([34, 33, 33]);
    expect(splitEqual(100, ["a", "b", "c"])).toEqual(allocations);
  });

  it("refuses to split a non-zero total across nobody", () => {
    expect(() => splitEqual(500, [])).toThrow(MoneyError);
  });
});

describe("custom split", () => {
  it("accepts allocations that sum exactly", () => {
    const allocations = splitCustom(1000, [
      { participantId: "a", amount: 400 },
      { participantId: "b", amount: 600 },
    ]);
    expect(sumAllocations(allocations)).toBe(1000);
  });

  it("rejects allocations that do not sum to the total", () => {
    expect(() =>
      splitCustom(1000, [
        { participantId: "a", amount: 400 },
        { participantId: "b", amount: 500 },
      ]),
    ).toThrow(MoneyError);
  });
});

describe("percentage split", () => {
  it("sums to the total exactly", () => {
    const allocations = splitByPercentage(1000, [
      { participantId: "a", basisPoints: 3333 },
      { participantId: "b", basisPoints: 3333 },
      { participantId: "c", basisPoints: 3334 },
    ]);
    expect(sumAllocations(allocations)).toBe(1000);
  });

  it("requires percentages to total 100%", () => {
    expect(() =>
      splitByPercentage(1000, [
        { participantId: "a", basisPoints: 5000 },
        { participantId: "b", basisPoints: 4000 },
      ]),
    ).toThrow(MoneyError);
  });
});

describe("itemized split", () => {
  it("splits shared lines equally and sums exactly", () => {
    const allocations = splitItemized(
      900,
      [
        { amount: 600, participantIds: ["a", "b"] },
        { amount: 300, participantIds: ["c"] },
      ],
      ["a", "b", "c"],
    );
    expect(sumAllocations(allocations)).toBe(900);
    expect(allocations).toEqual([
      { participantId: "a", amount: 300 },
      { participantId: "b", amount: 300 },
      { participantId: "c", amount: 300 },
    ]);
  });

  it("rejects lines that do not sum to the total", () => {
    expect(() =>
      splitItemized(1000, [{ amount: 500, participantIds: ["a"] }], ["a"]),
    ).toThrow(MoneyError);
  });
});

describe("weighted allocation", () => {
  it("never loses or invents a unit", () => {
    for (let total = 1; total <= 200; total += 1) {
      const allocations = allocateByWeights(total, [
        { participantId: "a", weight: 1 },
        { participantId: "b", weight: 1 },
        { participantId: "c", weight: 1 },
      ]);
      expect(sumAllocations(allocations)).toBe(total);
    }
  });
});
