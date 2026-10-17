import { describe, expect, it } from "vitest";
import { engineIds, getEngine } from "../src/games/engine.js";
import { registerAllEngines } from "../src/games/registry.js";

registerAllEngines();

/** Games that only make sense with a fixed number of seats. */
const PLAYERS: Record<string, string[]> = {
  slots: ["solo"],
  plinko: ["solo"],
};

/**
 * Every registered engine must be able to reach a finish when driven by its own
 * `autoMove`. That single property is what makes it safe to stake: the server
 * can always resolve a game, and the autoplay is also what a lone player faces.
 */
describe("every engine plays to a finish", () => {
  const ids = engineIds();

  it("registers more than thirty games", () => {
    expect(ids.length).toBeGreaterThanOrEqual(30);
  });

  for (const id of ids) {
    it(`${id} reaches a finish via autoMove`, () => {
      const engine = getEngine(id)!;
      const players = PLAYERS[id] ?? ["a", "b"];
      const ctx = { gameId: id, players, seed: 12345, stakeMinor: 0 };
      let state = engine.create(ctx);
      let guard = 0;
      while (!engine.finished(state) && guard < 5000) {
        guard += 1;
        const turn = engine.turnUserId(state, ctx);
        if (!turn) throw new Error(`${id}: no turn user but game not finished`);
        const move = engine.autoMove(state, turn, ctx);
        if (move === null || move === undefined) throw new Error(`${id}: autoMove returned nothing for ${turn}`);
        const result = engine.apply(state, turn, move, ctx);
        state = result.state;
      }
      expect(engine.finished(state)).toBe(true);
      if (!engine.finished(state)) return;
      const winner = engine.winnerId(state);
      // A finish either names a winner among the players, or is an honest draw.
      if (winner !== null) expect(players).toContain(winner);
      // The view must be serialisable and must never leak another player's hand
      // for card games — a smoke check that it returns an object at all.
      const view = engine.view(state, players[0]!, ctx);
      expect(view).toBeTypeOf("object");
      expect(() => JSON.stringify(view)).not.toThrow();
    });
  }
});
