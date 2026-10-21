import { describe, expect, it } from "vitest";
import { feltFor, worldFor, worldVars, GAME_WORLDS, WORLD_FELT } from "../src/components/GameArt";

/**
 * The table surface takes its character from the game's world. These guard the
 * seam between the catalogue palette and the table, so a new world cannot be
 * added without a material and a set of surface variables.
 */
describe("game table worlds", () => {
  it("gives each world a distinct material", () => {
    const materials = Object.keys(GAME_WORLDS).map((c) => feltFor(c));
    // Six worlds, but materials may repeat (mind and party share neon) — the
    // point is that not every world collapses to one default.
    expect(new Set(materials).size).toBeGreaterThan(1);
  });

  it("falls back to a felt table for an unknown or missing category", () => {
    expect(feltFor("chess-variant")).toBe("felt");
    expect(feltFor(undefined)).toBe("felt");
  });

  it("maps a world to the surface variables the felt reads", () => {
    const vars = worldVars("casino");
    expect(vars["--felt-from"]).toBe(GAME_WORLDS.casino!.from);
    expect(vars["--felt-to"]).toBe(GAME_WORLDS.casino!.to);
    expect(vars["--felt-accent"]).toBe(GAME_WORLDS.casino!.accent);
  });

  it("uses the arcade palette when a category is unknown", () => {
    expect(worldFor("not-a-world").label).toBe("Arcade");
    expect(worldVars(undefined)["--felt-accent"]).toBe(worldFor(undefined).accent);
  });

  it("has a material defined for every authored world", () => {
    for (const category of Object.keys(GAME_WORLDS)) {
      expect(WORLD_FELT[category]).toBeTruthy();
    }
  });
});
