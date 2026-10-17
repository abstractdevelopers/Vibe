import { describe, expect, it } from "vitest";
import {
  BASE_ALIASES,
  THEMES,
  baseForGame,
  baseForRoom,
  getTheme,
  themeForGame,
  themeForRoom,
} from "../src/themes";

/**
 * Regression cover for the theme-resolution defect.
 *
 * The catalogue names its base palettes `whot`, `blackjack`, `trivia`… while the
 * API names a game's *category* `cards`, `mind`, `action`… The resolver used to
 * look up `${category}-classic`, which only exists for three of the eight
 * categories, and fell back to the board palette when it missed. Every game in
 * cards, mind, action, rooms and social therefore wore the board environment.
 */

const FAMILIES = ["cards", "board", "mind", "action", "casino", "party"];

// The real ids the API serves, so the test breaks if a game is added without a
// palette decision.
const GAME_IDS = [
  "whot", "blackjack", "poker", "war",
  "checkers", "reversi", "battleship", "snakes", "dots",
  "trivia", "memory", "hangman", "simon",
  "reaction", "penalty", "rps",
  "roulette", "slots", "crash", "dice", "plinko",
  "truthdare", "charades",
  "gofish", "crazyeights", "baccarat", "wordchain", "wordscramble",
];

describe("theme resolution", () => {
  it("gives a game in a category its category's palette, not the board fallback", () => {
    // The defect: memory is a mind game but resolved to the board palette.
    expect(themeForGame("memory", "mind").family).toBe("mind");
    expect(themeForGame("rps", "action").family).toBe("action");
    expect(themeForGame("blackjack", "cards").family).toBe("cards");
  });

  it("prefers the game's own palette when the catalogue has one", () => {
    expect(baseForGame("poker", "cards")).toBe("poker");
    expect(themeForGame("poker", "cards").id).toBe("poker-classic");
  });

  it("uses an explicit alias for a game with no palette of its own", () => {
    expect(baseForGame("gofish", "cards")).toBe(BASE_ALIASES.gofish);
    expect(baseForGame("chess", "board")).toBe("board-classic");
  });

  it("resolves every real game id to a theme in the expected family", () => {
    for (const id of GAME_IDS) {
      const theme = themeForGame(id, undefined);
      expect(theme, `no theme for ${id}`).toBeTruthy();
      expect(getTheme(theme.id)).toBeTruthy();
      expect(FAMILIES).toContain(theme.family);
    }
  });

  it("never silently returns the board palette for a non-board game", () => {
    for (const id of ["memory", "hangman", "trivia", "rps", "penalty", "simon"]) {
      expect(themeForGame(id, "mind").family).not.toBe("board");
    }
  });

  it("resolves every room kind to a room theme", () => {
    for (const kind of ["voice", "listen", "music", "movie", "sports", "match", "watch"]) {
      const theme = themeForRoom(kind);
      expect(theme, `no theme for room ${kind}`).toBeTruthy();
      expect(theme.family).toBe("rooms");
    }
  });

  it("falls back to the voice lounge for an unknown room kind", () => {
    expect(baseForRoom("nonsense")).toBe("voice");
  });

  it("keeps every alias pointing at a palette that exists", () => {
    for (const [game, base] of Object.entries(BASE_ALIASES)) {
      expect(getTheme(`${base}-classic`), `${game} -> ${base} has no palette`).toBeTruthy();
    }
  });

  it("keeps the catalogue at 4 signature environments", () => {
    expect(THEMES.filter((t) => t.family === "signature")).toHaveLength(4);
  });
});
