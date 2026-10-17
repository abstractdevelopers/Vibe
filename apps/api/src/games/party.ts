/**
 * Party engines: Would You Rather, Never Have I Ever, Truth or Dare, Charades
 * and 20 Questions.
 *
 * These are deterministic by design. A party game with free-text judging cannot
 * be settled by a server, so each one is built as picks or guesses from a fixed
 * set: the server knows the answer and can therefore decide the winner without
 * trusting anyone. That keeps staking honest even in a party room.
 */

import { nextRandom, shuffle, type EngineContext, type EngineResult, type GameEngine } from "./engine.js";

// ---- Would You Rather / Never Have I Ever: pick the minority side ---------

interface SideState {
  prompts: string[][];
  round: number;
  maxRounds: number;
  picks: Record<string, number>;
  order: string[];
  turn: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
}

function makePickSide(id: string, prompts: string[][], maxRounds: number): GameEngine<SideState> {
  return {
    id,
    create(ctx): SideState {
      const scores: Record<string, number> = {};
      for (const p of ctx.players) scores[p] = 0;
      return { prompts: shuffle(prompts, ctx.seed).slice(0, Math.min(maxRounds, prompts.length)), round: 0, maxRounds: Math.min(maxRounds, prompts.length), picks: {}, order: ctx.players, turn: 0, scores, winner: null, draw: false };
    },
    apply(state, userId, move): EngineResult<SideState> {
      if (state.winner !== null || state.draw) throw new Error("This game has finished");
      if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
      const side = (move as { side?: number }).side;
      if (side !== 0 && side !== 1) throw new Error("Pick side 0 or 1");
      state.picks[userId] = side;
      if (state.turn + 1 < state.order.length) {
        state.turn += 1;
        return { state, finished: false, winnerId: null };
      }
      // The minority side scores; if everyone agrees, everyone scores.
      const zeros = state.order.filter((id) => state.picks[id] === 0);
      const ones = state.order.filter((id) => state.picks[id] === 1);
      const minority = zeros.length === ones.length ? null : zeros.length < ones.length ? zeros : ones;
      const winners = minority ?? state.order;
      for (const id of winners) state.scores[id] = (state.scores[id] ?? 0) + 1;
      state.picks = {};
      state.round += 1;
      if (state.round >= state.maxRounds) {
        const best = state.order.reduce((m, id2) => (state.scores[id2]! > state.scores[m]! ? id2 : m), state.order[0]!);
        const tied = state.order.filter((id2) => state.scores[id2] === state.scores[best]);
        if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
        state.winner = best;
        return { state, finished: true, winnerId: best };
      }
      state.turn = 0;
      return { state, finished: false, winnerId: null };
    },
    view(state, userId) {
      return {
        prompt: state.prompts[state.round] ?? [],
        round: state.round,
        maxRounds: state.maxRounds,
        picks: state.picks,
        scores: state.scores,
        turnUserId: state.order[state.turn] ?? null,
        yourTurn: state.order[state.turn] === userId,
        winnerId: state.winner,
        draw: state.draw,
        finished: state.winner !== null || state.draw,
      };
    },
    turnUserId: (s) => s.order[s.turn] ?? null,
    finished: (s) => s.winner !== null || s.draw,
    winnerId: (s) => s.winner,
    autoMove(state) { return { side: (state.round + state.order.length) % 2 }; },
    lastEvent: () => "picked",
  };
}

export const wyr = makePickSide("wyr", [
  ["Be able to fly", "Be able to read minds"],
  ["Always be 10 minutes late", "Always be 20 minutes early"],
  ["Have unlimited money", "Have unlimited time"],
  ["Live without music", "Live without film"],
  ["Know how you die", "Know when you die"],
  ["Fight one horse-sized duck", "Fight a hundred duck-sized horses"],
  ["Never use social media again", "Never watch another series"],
  ["Be the funniest person in the room", "Be the smartest"],
], 6);

export const neverhave = makePickSide("neverhave", [
  ["I have sung karaoke in public", "I have never"],
  ["I have missed a flight", "I have never"],
  ["I have eaten something I could not identify", "I have never"],
  ["I have sent a text to the wrong person", "I have never"],
  ["I have fallen asleep in a cinema", "I have never"],
  ["I have lied about my age", "I have never"],
  ["I have danced in the rain", "I have never"],
  ["I have pulled an all-nighter for fun", "I have never"],
], 6);

// ---- Truth or Dare (server picks who performs) ----------------------------

const TRUTHS = ["What is the most embarrassing thing on your phone?", "Who do you text the most?", "What is your worst habit?", "What is the biggest lie you have told this year?"];
const DARES = ["Send a voice note singing your favourite song", "Do ten push-ups on camera", "Talk in an accent for the next round", "Show the last photo in your gallery"];

interface TruthDareState {
  round: number;
  maxRounds: number;
  order: string[];
  turn: number;
  picks: Record<string, "truth" | "dare">;
  chosen: string | null;
  task: string | null;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
  seed: number;
}

export const truthdare: GameEngine<TruthDareState> = {
  id: "truthdare",
  create(ctx): TruthDareState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { round: 0, maxRounds: 5, order: ctx.players, turn: 0, picks: {}, chosen: null, task: null, scores, winner: null, draw: false, seed: ctx.seed };
  },
  apply(state, userId, move): EngineResult<TruthDareState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const pick = (move as { pick?: string }).pick;
    if (pick !== "truth" && pick !== "dare") throw new Error("Choose truth or dare");
    state.picks[userId] = pick;
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    const r = nextRandom(state.seed);
    state.seed = r.seed;
    state.chosen = state.order[Math.floor(r.value * state.order.length)]!;
    const kind = state.picks[state.chosen] ?? "truth";
    state.task = kind === "truth" ? TRUTHS[state.seed % TRUTHS.length]! : DARES[state.seed % DARES.length]!;
    state.scores[state.chosen] = (state.scores[state.chosen] ?? 0) + 1;
    state.round += 1;
    if (state.round >= state.maxRounds) {
      const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
      const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
      if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = best;
      return { state, finished: true, winnerId: best };
    }
    state.picks = {};
    state.turn = 0;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      round: state.round,
      maxRounds: state.maxRounds,
      picks: state.picks,
      chosen: state.chosen,
      task: state.task,
      scores: state.scores,
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.order[state.turn] === userId,
      winnerId: state.winner,
      draw: state.draw,
      finished: state.winner !== null || state.draw,
    };
  },
  turnUserId: (s) => s.order[s.turn] ?? null,
  finished: (s) => s.winner !== null || s.draw,
  winnerId: (s) => s.winner,
  autoMove() { return { pick: "truth" }; },
  lastEvent: (s) => s.task,
};

// ---- Charades / 20 Questions: guess from options --------------------------

interface GuessState {
  rounds: { prompt: string; options: string[]; answer: number }[];
  round: number;
  order: string[];
  turn: number;
  answered: string[];
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
  last: string | null;
}

function makeGuess(id: string, rounds: { prompt: string; options: string[]; answer: number }[], maxRounds: number): GameEngine<GuessState> {
  return {
    id,
    create(ctx): GuessState {
      const scores: Record<string, number> = {};
      for (const p of ctx.players) scores[p] = 0;
      return { rounds: shuffle(rounds, ctx.seed).slice(0, Math.min(maxRounds, rounds.length)), round: 0, order: ctx.players, turn: 0, answered: [], scores, winner: null, draw: false, last: null };
    },
    apply(state, userId, move): EngineResult<GuessState> {
      if (state.winner !== null || state.draw) throw new Error("This game has finished");
      if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
      const current = state.rounds[state.round]!;
      const choice = (move as { choice?: number }).choice;
      if (!Number.isInteger(choice) || choice! < 0 || choice! >= current.options.length) throw new Error("Pick one of the options");
      state.answered.push(userId);
      if (choice === current.answer) {
        state.scores[userId] = (state.scores[userId] ?? 0) + 1;
        state.last = `${userId} got it`;
        // A correct guess ends the round.
        state.answered = [];
        state.round += 1;
        if (state.round >= state.rounds.length) {
          const best = state.order.reduce((m, id2) => (state.scores[id2]! > state.scores[m]! ? id2 : m), state.order[0]!);
          const tied = state.order.filter((id2) => state.scores[id2] === state.scores[best]);
          if (tied.length > 1 || state.scores[best] === 0) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
          state.winner = best;
          return { state, finished: true, winnerId: best };
        }
        state.turn = 0;
        return { state, finished: false, winnerId: null };
      }
      state.last = `${userId} missed`;
      if (state.answered.length >= state.order.length) {
        // Everyone missed: reveal and move on.
        state.answered = [];
        state.round += 1;
        if (state.round >= state.rounds.length) {
          const best = state.order.reduce((m, id2) => (state.scores[id2]! > state.scores[m]! ? id2 : m), state.order[0]!);
          const tied = state.order.filter((id2) => state.scores[id2] === state.scores[best]);
          if (tied.length > 1 || state.scores[best] === 0) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
          state.winner = best;
          return { state, finished: true, winnerId: best };
        }
        state.turn = 0;
        return { state, finished: false, winnerId: null };
      }
      state.turn = (state.turn + 1) % state.order.length;
      return { state, finished: false, winnerId: null };
    },
    view(state, userId) {
      const current = state.rounds[state.round];
      return {
        prompt: current?.prompt ?? null,
        options: current?.options ?? [],
        round: state.round,
        totalRounds: state.rounds.length,
        answered: state.answered,
        scores: state.scores,
        last: state.last,
        turnUserId: state.order[state.turn] ?? null,
        yourTurn: state.order[state.turn] === userId,
        winnerId: state.winner,
        draw: state.draw,
        finished: state.winner !== null || state.draw,
      };
    },
    turnUserId: (s) => s.order[s.turn] ?? null,
    finished: (s) => s.winner !== null || s.draw,
    winnerId: (s) => s.winner,
    autoMove(state) { return { choice: state.rounds[state.round]?.answer ?? 0 }; },
    lastEvent: (s) => s.last,
  };
}

export const charades = makeGuess("charades", [
  { prompt: "Act it out: a person rowing a boat", options: ["Rowing", "Swimming", "Fishing", "Sailing"], answer: 0 },
  { prompt: "Act it out: an elephant drinking water", options: ["A cat", "An elephant", "A horse", "A dog"], answer: 1 },
  { prompt: "Act it out: a chef tasting soup", options: ["A waiter", "A chef", "A singer", "A boxer"], answer: 1 },
  { prompt: "Act it out: someone late for a bus", options: ["Sleeping", "Running late", "Dancing", "Cooking"], answer: 1 },
  { prompt: "Act it out: a robot running out of battery", options: ["A robot", "A baby", "A tree", "A car"], answer: 0 },
  { prompt: "Act it out: a magician's big reveal", options: ["A chef", "A magician", "A pilot", "A farmer"], answer: 1 },
], 5);

export const twentyq = makeGuess("20q", [
  { prompt: "I am thinking of an animal that lives in water and has eight arms.", options: ["Dolphin", "Octopus", "Shark", "Whale"], answer: 1 },
  { prompt: "I am thinking of something you use to write, and it has ink inside.", options: ["Pencil", "Pen", "Brush", "Chalk"], answer: 1 },
  { prompt: "I am thinking of a place with many books you can borrow.", options: ["Museum", "Library", "Market", "School"], answer: 1 },
  { prompt: "I am thinking of a fruit that is yellow and monkeys love it.", options: ["Mango", "Banana", "Apple", "Orange"], answer: 1 },
  { prompt: "I am thinking of a vehicle that flies and carries many people.", options: ["Train", "Airplane", "Boat", "Bus"], answer: 1 },
  { prompt: "I am thinking of something in the sky at night that shines.", options: ["Cloud", "Star", "Bird", "Kite"], answer: 1 },
], 5);

// ---- Memory is in mind.ts; this file's exports are the party set ----------
export type { SideState, GuessState };
