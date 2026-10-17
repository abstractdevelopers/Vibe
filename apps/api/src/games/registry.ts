/**
 * The engine registry: importing this module registers every game Vibe can play.
 *
 * `whot.ts` predates the generic contract, so it is wrapped here rather than
 * rewritten — its rules are unchanged, only its shape is adapted. Adding a game
 * means implementing `GameEngine` and registering it here; the routes, the
 * catalogue and the autoplay test all pick it up automatically.
 */

import {
  applyWhotMove,
  createWhotState,
  isPlayable,
  whotView,
  type WhotMove,
  type WhotState,
} from "./whot.js";
import { registerEngine, type EngineContext, type EngineResult, type GameEngine } from "./engine.js";

import { blackjack, war, gofish, crazyeights, poker, baccarat } from "./cards.js";
import { tictactoe, connect4, gomoku, checkers, reversi, battleship, dots, snakes } from "./board.js";
import {
  memory, hangman, wordchain, simon, trivia, wordscramble, dice, slots, roulette, crash, plinko, penalty, reaction, rps,
} from "./mind.js";
import { wyr, neverhave, truthdare, charades, twentyq } from "./party.js";

/** Whot, adapted to the generic engine contract. */
const whotEngine: GameEngine<WhotState> = {
  id: "whot",
  create(ctx: EngineContext): WhotState {
    return createWhotState(ctx.players, ctx.seed);
  },
  apply(state, userId, move): EngineResult<WhotState> {
    const next = applyWhotMove(state, userId, move as WhotMove);
    return { state: next, finished: next.finished, winnerId: next.winnerId };
  },
  view(state, userId) {
    return whotView(state, userId);
  },
  turnUserId: (state) => state.order[state.turn] ?? null,
  finished: (state) => state.finished,
  winnerId: (state) => state.winnerId,
  autoMove(state, userId) {
    const hand = state.hands[userId] ?? [];
    const playable = hand.find((c) => isPlayable(state, c));
    if (playable) {
      return playable.shape === "whot"
        ? { type: "play", card: playable, callShape: "circle" }
        : { type: "play", card: playable };
    }
    return { type: "draw" };
  },
  lastEvent: (state) => state.lastEvent,
};

let registered = false;

/** Register every engine once. Safe to call repeatedly. */
export function registerAllEngines(): void {
  if (registered) return;
  registered = true;
  for (const engine of [
    whotEngine,
    blackjack, war, gofish, crazyeights, poker, baccarat,
    tictactoe, connect4, gomoku, checkers, reversi, battleship, dots, snakes,
    memory, hangman, wordchain, simon, trivia, wordscramble, dice, slots, roulette, crash, plinko, penalty, reaction, rps,
    wyr, neverhave, truthdare, charades, twentyq,
  ]) {
    registerEngine(engine);
  }
}
