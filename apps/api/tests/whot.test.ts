import { describe, expect, it } from "vitest";
import { buildDeck, createWhotState, applyWhotMove, isPlayable, type WhotState } from "../src/games/whot.js";

function totalCards(s: WhotState): number {
  const hands = Object.values(s.hands).reduce((n, h) => n + h.length, 0);
  return hands + s.market.length + s.discard.length;
}

describe("Whot deck", () => {
  it("has 59 cards: 24+23 short shapes, 2 long, 5 whot", () => {
    const deck = buildDeck();
    expect(deck.length).toBe(59);
    expect(deck.filter((c) => c.shape === "whot").length).toBe(5);
    expect(deck.filter((c) => c.shape === "circle").length).toBe(12);
    expect(deck.filter((c) => c.shape === "cross").length).toBe(9);
  });

  it("deals six each and turns up a non-whot card", () => {
    const s = createWhotState(["a", "b", "c"], 42);
    expect(s.hands.a!.length).toBe(6);
    expect(s.hands.b!.length).toBe(6);
    expect(s.discard[0]!.shape).not.toBe("whot");
    expect(totalCards(s)).toBe(59);
  });
});

describe("Whot rules", () => {
  it("matches by shape or number, and a whot is always playable", () => {
    const s = createWhotState(["a", "b"], 7);
    s.discard = [{ shape: "circle", number: 5 }];
    s.calledShape = null;
    expect(isPlayable(s, { shape: "circle", number: 9 })).toBe(true); // shape
    expect(isPlayable(s, { shape: "star", number: 5 })).toBe(true); // number
    expect(isPlayable(s, { shape: "star", number: 9 })).toBe(false);
    expect(isPlayable(s, { shape: "whot", number: 20 })).toBe(true);
  });

  it("a whot call makes the named shape playable and nothing else", () => {
    const s = createWhotState(["a", "b"], 7);
    s.discard = [{ shape: "circle", number: 5 }];
    s.calledShape = "star";
    expect(isPlayable(s, { shape: "star", number: 12 })).toBe(true);
    expect(isPlayable(s, { shape: "circle", number: 5 })).toBe(false);
  });

  it("refuses a move when it is not your turn", () => {
    const s = createWhotState(["a", "b"], 11);
    expect(s.order[s.turn]).toBe("a");
    expect(() => applyWhotMove(s, "b", { type: "draw" })).toThrow(/not your turn/i);
  });

  it("refuses a card the player does not hold", () => {
    const s = createWhotState(["a", "b"], 11);
    s.discard = [{ shape: "circle", number: 1 }];
    s.hands.a = [{ shape: "circle", number: 3 }];
    s.calledShape = null;
    expect(() => applyWhotMove(s, "a", { type: "play", card: { shape: "star", number: 7 } })).toThrow();
  });

  it("conserves the deck across a long random game", () => {
    const s = createWhotState(["a", "b", "c", "d"], 99);
    let guard = 0;
    while (!s.finished && guard < 2000) {
      guard += 1;
      const player = s.order[s.turn]!;
      const hand = s.hands[player]!;
      const playable = hand.find((c) => isPlayable(s, c));
      if (playable) {
        const move = playable.shape === "whot"
          ? { type: "play" as const, card: playable, callShape: "circle" as const }
          : { type: "play" as const, card: playable };
        applyWhotMove(s, player, move);
      } else {
        applyWhotMove(s, player, { type: "draw" });
      }
      expect(totalCards(s)).toBe(59);
    }
    expect(s.finished).toBe(true);
    expect(s.winnerId).toBeTruthy();
    expect(s.hands[s.winnerId!]!.length).toBe(0);
  });

  it("the pick-two makes the next player draw and skips their turn", () => {
    const s = createWhotState(["a", "b", "c"], 3);
    s.discard = [{ shape: "circle", number: 2 }];
    s.hands.a = [{ shape: "circle", number: 2 }, { shape: "star", number: 9 }];
    s.calledShape = null;
    const before = s.hands.b!.length;
    applyWhotMove(s, "a", { type: "play", card: { shape: "circle", number: 2 } });
    expect(s.hands.b!.length).toBe(before + 2);
    expect(s.order[s.turn]).toBe("c");
  });

  it("suspension skips the next player, hold-on keeps the turn", () => {
    const s = createWhotState(["a", "b", "c"], 5);
    s.calledShape = null;
    s.discard = [{ shape: "circle", number: 8 }];
    s.hands.a = [{ shape: "circle", number: 8 }, { shape: "star", number: 9 }];
    applyWhotMove(s, "a", { type: "play", card: { shape: "circle", number: 8 } });
    expect(s.order[s.turn]).toBe("c");

    const s2 = createWhotState(["a", "b"], 5);
    s2.calledShape = null;
    s2.discard = [{ shape: "circle", number: 1 }];
    s2.hands.a = [{ shape: "circle", number: 1 }, { shape: "star", number: 9 }];
    applyWhotMove(s2, "a", { type: "play", card: { shape: "circle", number: 1 } });
    expect(s2.order[s2.turn]).toBe("a");
  });
});
