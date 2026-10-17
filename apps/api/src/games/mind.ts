/**
 * Mind, action and casino engines.
 *
 * Mind games are turn-based puzzles and wordplay. Action games are quick
 * duels. Casino games are seeded so a spin or a crash is reproducible and the
 * server — never the client — decides the result, which is what makes a staked
 * round safe.
 */

import { nextSeat, nextRandom, shuffle, type EngineContext, type EngineResult, type GameEngine } from "./engine.js";

// ---- Memory Match ---------------------------------------------------------

interface MemoryState {
  cards: number[]; // symbol ids, two of each
  revealed: (number | null)[]; // currently face-up indices this turn
  matched: number[]; // indices already matched
  scores: Record<string, number>;
  order: string[];
  turn: number;
  winner: string | null;
  draw: boolean;
}

const MEMORY_SYMBOLS = ["🍋", "🍇", "🍒", "🍑", "🥑", "🌶️", "🍍", "🥕"];

export const memory: GameEngine<MemoryState> = {
  id: "memory",
  create(ctx): MemoryState {
    const pairs = 8;
    const deck: number[] = [];
    for (let i = 0; i < pairs; i += 1) deck.push(i, i);
    const cards = shuffle(deck, ctx.seed);
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { cards, revealed: [], matched: [], scores, order: ctx.players, turn: 0, winner: null, draw: false };
  },
  apply(state, userId, move): EngineResult<MemoryState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const { index } = move as { index?: number };
    if (!Number.isInteger(index) || index! < 0 || index! >= state.cards.length) throw new Error("Pick a card on the board");
    if (state.matched.includes(index!) || state.revealed.includes(index!)) throw new Error("That card is already face up");
    state.revealed.push(index!);
    if (state.revealed.length < 2) return { state, finished: false, winnerId: null };
    const [a, b] = state.revealed as [number, number];
    if (state.cards[a] === state.cards[b]) {
      state.matched.push(a, b);
      state.scores[userId] = (state.scores[userId] ?? 0) + 1;
      state.revealed = [];
      if (state.matched.length === state.cards.length) {
        const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
        const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
        if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
        state.winner = best;
        return { state, finished: true, winnerId: best };
      }
      return { state, finished: false, winnerId: null };
    }
    state.revealed = [];
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      size: state.cards.length,
      symbols: MEMORY_SYMBOLS,
      // Only face-up (this turn) or matched cards reveal their symbol.
      revealed: state.revealed,
      matched: state.matched,
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
  autoMove(state) {
    const faceDown = state.cards.map((_, i) => i).filter((i) => !state.matched.includes(i) && !state.revealed.includes(i));
    if (state.revealed.length === 1) {
      const first = state.revealed[0]!;
      const pair = faceDown.find((i) => state.cards[i] === state.cards[first]);
      if (pair !== undefined) return { index: pair };
    }
    return faceDown.length ? { index: faceDown[0]! } : null;
  },
  lastEvent: () => "flipped",
};

// ---- Hangman --------------------------------------------------------------

const HANGMAN_WORDS = [
  "LAGOS", "MARKET", "JOURNEY", "HARMONY", "VILLAGE", "PENGUIN", "GUITAR", "LANTERN",
  "MONSOON", "COMPASS", "ORCHARD", "WHISPER", "KETTLE", "RAINBOW", "GALAXY", "CACTUS",
  "FESTIVAL", "MOUNTAIN", "SAPPHIRE", "TORNADO", "BICYCLE", "CHOCOLATE", "DOLPHIN", "ELEPHANT",
];

interface HangmanState {
  word: string;
  guessed: string[];
  wrong: number;
  scores: Record<string, number>;
  order: string[];
  turn: number;
  winner: string | null;
  draw: boolean;
  maxWrong: number;
}

export const hangman: GameEngine<HangmanState> = {
  id: "hangman",
  create(ctx): HangmanState {
    const word = HANGMAN_WORDS[Math.floor(nextRandom(ctx.seed).value * HANGMAN_WORDS.length)]!;
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { word, guessed: [], wrong: 0, scores, order: ctx.players, turn: 0, winner: null, draw: false, maxWrong: 6 };
  },
  apply(state, userId, move): EngineResult<HangmanState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const letter = String((move as { letter?: string }).letter ?? "").toUpperCase();
    if (!/^[A-Z]$/.test(letter)) throw new Error("Guess a single letter");
    if (state.guessed.includes(letter)) throw new Error("That letter was already guessed");
    state.guessed.push(letter);
    if (state.word.includes(letter)) {
      state.scores[userId] = (state.scores[userId] ?? 0) + 1;
    } else {
      state.wrong += 1;
      state.turn = nextSeat(state.order, state.turn);
    }
    const solved = [...state.word].every((ch) => state.guessed.includes(ch));
    if (solved || state.wrong >= state.maxWrong) {
      const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
      const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
      if (tied.length > 1 || state.scores[best] === 0) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = best;
      return { state, finished: true, winnerId: best };
    }
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      masked: [...state.word].map((ch) => (state.guessed.includes(ch) ? ch : "_")).join(" "),
      length: state.word.length,
      guessed: state.guessed,
      wrong: state.wrong,
      maxWrong: state.maxWrong,
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
  autoMove(state) {
    const remaining = [...new Set(state.word.split(""))].filter((ch) => !state.guessed.includes(ch));
    return { letter: remaining[0] ?? "A" };
  },
  lastEvent: () => "guessed",
};

// ---- Word Chain -----------------------------------------------------------

const DICTIONARY = new Set([
  "apple", "orange", "egg", "grape", "elephant", "tree", "eagle", "ember", "river", "rock",
  "kite", "engine", "echo", "ocean", "nest", "tiger", "rain", "night", "table", "lemon",
  "melon", "note", "song", "goal", "lion", "star", "road", "drum", "mango", "onion",
  "yarn", "nut", "tower", "wave", "queen", "moon", "sun", "idea", "ant", "leaf",
  "frog", "goat", "top", "pen", "name", "eggplant", "tomato", "olive", "end", "dog",
  "gate", "eggcup", "pear", "rat", "tent", "toast", "treehouse", "eye", "ear", "rose",
]);

interface ChainState {
  lastWord: string;
  used: string[];
  order: string[];
  turn: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
  round: number;
  maxRounds: number;
}

export const wordchain: GameEngine<ChainState> = {
  id: "wordchain",
  create(ctx): ChainState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { lastWord: "", used: [], order: ctx.players, turn: 0, scores, winner: null, draw: false, round: 0, maxRounds: ctx.players.length * 3 };
  },
  apply(state, userId, move): EngineResult<ChainState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const word = String((move as { word?: string }).word ?? "").trim().toLowerCase();
    if (!/^[a-z]{2,}$/.test(word)) throw new Error("Give a word of letters");
    if (!DICTIONARY.has(word)) throw new Error("That word is not in the dictionary");
    if (state.used.includes(word)) throw new Error("That word was already used");
    if (state.lastWord && word[0] !== state.lastWord[state.lastWord.length - 1]) {
      throw new Error(`Your word must start with "${state.lastWord[state.lastWord.length - 1]!.toUpperCase()}"`);
    }
    state.used.push(word);
    state.lastWord = word;
    state.scores[userId] = (state.scores[userId] ?? 0) + 1;
    state.round += 1;
    state.turn = nextSeat(state.order, state.turn);
    if (state.round >= state.maxRounds) {
      const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
      const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
      if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = best;
      return { state, finished: true, winnerId: best };
    }
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    const nextLetter = state.lastWord ? state.lastWord[state.lastWord.length - 1]!.toUpperCase() : null;
    return {
      lastWord: state.lastWord || null,
      nextLetter,
      used: state.used,
      scores: state.scores,
      round: state.round,
      maxRounds: state.maxRounds,
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
  autoMove(state) {
    const need = state.lastWord ? state.lastWord[state.lastWord.length - 1]! : null;
    for (const w of DICTIONARY) {
      if (state.used.includes(w)) continue;
      if (!need || w[0] === need) return { word: w };
    }
    return null;
  },
  lastEvent: (s) => s.lastWord || null,
};

// ---- Simon Says -----------------------------------------------------------

const SIMON_COLORS = ["red", "green", "blue", "yellow"];

interface SimonState {
  sequence: string[];
  submissions: Record<string, string[]>;
  order: string[];
  turn: number;
  eliminated: string[];
  answered: number;
  round: number;
  maxRounds: number;
  winner: string | null;
  draw: boolean;
  seed: number;
}

export const simon: GameEngine<SimonState> = {
  id: "simon",
  create(ctx): SimonState {
    const seq: string[] = [];
    let s = ctx.seed;
    for (let i = 0; i < 3; i += 1) { const r = nextRandom(s); s = r.seed; seq.push(SIMON_COLORS[Math.floor(r.value * 4)]!); }
    return { sequence: seq, submissions: {}, order: ctx.players, turn: 0, eliminated: [], answered: 0, round: 0, maxRounds: 8, winner: null, draw: false, seed: s };
  },
  apply(state, userId, move): EngineResult<SimonState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.eliminated.includes(userId)) throw new Error("You are out of this round");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const guess = (move as { sequence?: string[] }).sequence ?? [];
    if (JSON.stringify(guess) !== JSON.stringify(state.sequence)) state.eliminated.push(userId);
    state.answered += 1;
    const alive = state.order.filter((id) => !state.eliminated.includes(id));
    if (alive.length <= 1) {
      if (alive.length === 0) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = alive[0]!;
      return { state, finished: true, winnerId: state.winner };
    }
    if (state.answered >= alive.length) {
      // Everyone still in has answered: a new, longer round begins.
      state.answered = 0;
      state.round += 1;
      const r = nextRandom(state.seed);
      state.seed = r.seed;
      state.sequence = [...state.sequence, SIMON_COLORS[Math.floor(r.value * 4)]!];
      // Perfect play never eliminates anyone; cap the round count so the game
      // always settles. Survivors share the pot.
      if (state.round >= state.maxRounds) {
        if (alive.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
        state.winner = alive[0]!;
        return { state, finished: true, winnerId: state.winner };
      }
      // Start the new round with the first surviving seat.
      let first = state.turn;
      do { first = nextSeat(state.order, first); } while (state.eliminated.includes(state.order[first]!) && first !== state.turn);
      state.turn = first;
      return { state, finished: false, winnerId: null };
    }
    let next = state.turn;
    do { next = nextSeat(state.order, next); } while (state.eliminated.includes(state.order[next]!) && next !== state.turn);
    state.turn = next;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      colors: SIMON_COLORS,
      sequence: state.sequence,
      eliminated: state.eliminated,
      alive: state.order.filter((id) => !state.eliminated.includes(id)),
      round: state.round,
      maxRounds: state.maxRounds,
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
  autoMove(state) { return { sequence: state.sequence }; },
  lastEvent: () => "repeated",
};

// ---- Trivia Duel ----------------------------------------------------------

const TRIVIA: { q: string; options: string[]; answer: number }[] = [
  { q: "What is the largest continent?", options: ["Africa", "Asia", "Europe", "America"], answer: 1 },
  { q: "How many colours are in a rainbow?", options: ["5", "6", "7", "9"], answer: 2 },
  { q: "What is the capital of Nigeria?", options: ["Lagos", "Kano", "Abuja", "Ibadan"], answer: 2 },
  { q: "Which planet is closest to the sun?", options: ["Venus", "Mercury", "Mars", "Earth"], answer: 1 },
  { q: "What is H2O?", options: ["Salt", "Sugar", "Water", "Air"], answer: 2 },
  { q: "How many sides does a hexagon have?", options: ["5", "6", "7", "8"], answer: 1 },
  { q: "Who wrote Things Fall Apart?", options: ["Wole Soyinka", "Chinua Achebe", "Ngugi wa Thiong'o", "Ben Okri"], answer: 1 },
  { q: "What is the largest ocean?", options: ["Atlantic", "Indian", "Arctic", "Pacific"], answer: 3 },
];

interface TriviaState {
  rounds: { q: string; options: string[]; answer: number }[];
  round: number;
  scores: Record<string, number>;
  order: string[];
  turn: number;
  answered: string[];
  winner: string | null;
  draw: boolean;
}

export const trivia: GameEngine<TriviaState> = {
  id: "trivia",
  create(ctx): TriviaState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    const rounds = shuffle(TRIVIA, ctx.seed).slice(0, Math.min(6, TRIVIA.length));
    return { rounds, round: 0, scores, order: ctx.players, turn: 0, answered: [], winner: null, draw: false };
  },
  apply(state, userId, move): EngineResult<TriviaState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    if (state.answered.includes(userId)) throw new Error("You answered this round");
    const choice = (move as { choice?: number }).choice;
    const current = state.rounds[state.round]!;
    if (!Number.isInteger(choice) || choice! < 0 || choice! >= current.options.length) throw new Error("Pick one of the options");
    if (choice === current.answer) state.scores[userId] = (state.scores[userId] ?? 0) + 1;
    state.answered.push(userId);
    if (state.answered.length >= state.order.length) {
      state.answered = [];
      state.round += 1;
      if (state.round >= state.rounds.length) {
        const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
        const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
        if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
        state.winner = best;
        return { state, finished: true, winnerId: best };
      }
    }
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    const current = state.rounds[state.round];
    return {
      round: state.round,
      totalRounds: state.rounds.length,
      question: current?.q ?? null,
      options: current?.options ?? [],
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
  autoMove(state) { return { choice: state.rounds[state.round]?.answer ?? 0 }; },
  lastEvent: () => "answered",
};

// ---- Word Scramble --------------------------------------------------------

const SCRAMBLE_WORDS = ["banana", "computer", "festival", "guitar", "harmony", "journey", "lantern", "mountain", "notebook", "umbrella"];

interface ScrambleState {
  answer: string;
  scrambled: string;
  guesses: Record<string, number>;
  order: string[];
  turn: number;
  round: number;
  maxRounds: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
}

export const wordscramble: GameEngine<ScrambleState> = {
  id: "wordscramble",
  create(ctx): ScrambleState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    const answer = SCRAMBLE_WORDS[Math.floor(nextRandom(ctx.seed).value * SCRAMBLE_WORDS.length)]!;
    let scrambled = answer;
    let s = ctx.seed;
    while (scrambled === answer) { scrambled = shuffle(answer.split(""), s).join(""); s += 1; }
    return { answer, scrambled, guesses: {}, order: ctx.players, turn: 0, round: 0, maxRounds: 5, scores, winner: null, draw: false };
  },
  apply(state, userId, move, ctx): EngineResult<ScrambleState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const guess = String((move as { guess?: string }).guess ?? "").trim().toLowerCase();
    if (guess === state.answer) {
      state.scores[userId] = (state.scores[userId] ?? 0) + 1;
      // Next round with a fresh word.
      state.round += 1;
      if (state.round >= state.maxRounds) {
        const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
        const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
        if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
        state.winner = best;
        return { state, finished: true, winnerId: best };
      }
      const answer = SCRAMBLE_WORDS[Math.floor(nextRandom(ctx.seed + state.round * 31).value * SCRAMBLE_WORDS.length)]!;
      let scrambled = answer;
      let s = ctx.seed + state.round * 31;
      while (scrambled === answer) { scrambled = shuffle(answer.split(""), s).join(""); s += 1; }
      state.answer = answer;
      state.scrambled = scrambled;
      state.turn = 0;
      return { state, finished: false, winnerId: null };
    }
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      scrambled: state.scrambled,
      length: state.answer.length,
      round: state.round,
      maxRounds: state.maxRounds,
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
  autoMove(state) { return { guess: state.answer }; },
  lastEvent: () => "guessed",
};

// ---- Dice Duel ------------------------------------------------------------

interface DiceState {
  rolls: Record<string, number[]>;
  order: string[];
  turn: number;
  round: number;
  maxRounds: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
  seed: number;
}

function rollDice(seed: number, count: number): { rolls: number[]; seed: number } {
  const rolls: number[] = [];
  let s = seed;
  for (let i = 0; i < count; i += 1) { const r = nextRandom(s); s = r.seed; rolls.push(1 + Math.floor(r.value * 6)); }
  return { rolls, seed: s };
}

export const dice: GameEngine<DiceState> = {
  id: "dice",
  create(ctx): DiceState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { rolls: {}, order: ctx.players, turn: 0, round: 0, maxRounds: 5, scores, winner: null, draw: false, seed: ctx.seed };
  },
  apply(state, userId, move): EngineResult<DiceState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    if ((move as { action?: string }).action !== "roll") throw new Error("The only move is to roll");
    const r = rollDice(state.seed, 2);
    state.seed = r.seed;
    state.rolls[userId] = r.rolls;
    const total = r.rolls.reduce((a, b) => a + b, 0);
    state.scores[userId] = (state.scores[userId] ?? 0) + total;
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    state.round += 1;
    state.rolls = {};
    if (state.round >= state.maxRounds) {
      const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
      const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
      if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = best;
      return { state, finished: true, winnerId: best };
    }
    state.turn = 0;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      lastRolls: state.rolls,
      scores: state.scores,
      round: state.round,
      maxRounds: state.maxRounds,
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
  autoMove() { return { action: "roll" }; },
  lastEvent: (s) => (s.rolls[Object.keys(s.rolls)[0] ?? ""] ? `rolled ${s.rolls[Object.keys(s.rolls)[0]!]!.join("+")}` : null),
};

// ---- Slots (solo, seeded payout) -----------------------------------------

const SLOT_SYMBOLS = ["🍒", "🍋", "🔔", "⭐", "💎"];

interface SlotsState {
  reels: string[];
  spins: number;
  maxSpins: number;
  payout: number;
  winner: string | null;
  seed: number;
  order: string[];
}

export const slots: GameEngine<SlotsState> = {
  id: "slots",
  create(ctx): SlotsState {
    return { reels: [], spins: 0, maxSpins: 5, payout: 0, winner: null, seed: ctx.seed, order: ctx.players };
  },
  apply(state, userId, move): EngineResult<SlotsState> {
    if (state.winner !== null) throw new Error("This game has finished");
    if (state.order[0] !== userId) throw new Error("This is a solo machine");
    if ((move as { action?: string }).action !== "spin") throw new Error("Spin the reels");
    const r = rollDice(state.seed, 3);
    state.seed = r.seed;
    state.reels = r.rolls.map((n) => SLOT_SYMBOLS[(n - 1) % SLOT_SYMBOLS.length]!);
    state.spins += 1;
    if (state.reels[0] === state.reels[1] && state.reels[1] === state.reels[2]) {
      state.payout += state.reels[0] === "💎" ? 100 : 20;
    } else if (state.reels[0] === state.reels[1] || state.reels[1] === state.reels[2] || state.reels[0] === state.reels[2]) {
      state.payout += 5;
    }
    if (state.spins >= state.maxSpins) {
      state.winner = state.payout > 0 ? userId : null;
      return { state, finished: true, winnerId: state.winner };
    }
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      symbols: SLOT_SYMBOLS,
      reels: state.reels,
      spins: state.spins,
      maxSpins: state.maxSpins,
      payout: state.payout,
      yourTurn: state.order[0] === userId && state.winner === null,
      turnUserId: state.winner === null ? state.order[0] ?? null : null,
      winnerId: state.winner,
      finished: state.winner !== null || state.spins >= state.maxSpins,
    };
  },
  turnUserId: (s) => (s.winner === null && s.spins < s.maxSpins ? s.order[0] ?? null : null),
  finished: (s) => s.winner !== null || s.spins >= s.maxSpins,
  winnerId: (s) => s.winner,
  autoMove() { return { action: "spin" }; },
  lastEvent: (s) => (s.reels.length ? s.reels.join(" ") : null),
};

// ---- Roulette -------------------------------------------------------------

interface RouletteState {
  spins: number;
  maxSpins: number;
  bets: Record<string, { kind: "red" | "black" | "number"; number?: number }>;
  history: number[];
  scores: Record<string, number>;
  order: string[];
  turn: number;
  phase: "bet" | "done";
  winner: string | null;
  draw: boolean;
  seed: number;
}

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export const roulette: GameEngine<RouletteState> = {
  id: "roulette",
  create(ctx): RouletteState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { spins: 0, maxSpins: 3, bets: {}, history: [], scores, order: ctx.players, turn: 0, phase: "bet", winner: null, draw: false, seed: ctx.seed };
  },
  apply(state, userId, move): EngineResult<RouletteState> {
    if (state.phase === "done") throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const bet = (move as { bet?: { kind: string; number?: number } }).bet;
    if (!bet || (bet.kind !== "red" && bet.kind !== "black" && bet.kind !== "number")) throw new Error("Bet red, black or a number");
    state.bets[userId] = { kind: bet.kind, number: bet.number };
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    const r = nextRandom(state.seed);
    state.seed = r.seed;
    const pocket = Math.floor(r.value * 37);
    state.history.push(pocket);
    state.spins += 1;
    for (const id of state.order) {
      const b = state.bets[id]!;
      const isRed = RED_NUMBERS.has(pocket);
      if (b.kind === "red" && isRed && pocket !== 0) state.scores[id] = (state.scores[id] ?? 0) + 1;
      else if (b.kind === "black" && !isRed && pocket !== 0) state.scores[id] = (state.scores[id] ?? 0) + 1;
      else if (b.kind === "number" && b.number === pocket) state.scores[id] = (state.scores[id] ?? 0) + 3;
    }
    state.bets = {};
    if (state.spins >= state.maxSpins) {
      const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
      const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
      state.phase = "done";
      if (tied.length > 1 || state.scores[best] === 0) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = best;
      return { state, finished: true, winnerId: best };
    }
    state.turn = 0;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      history: state.history,
      spins: state.spins,
      maxSpins: state.maxSpins,
      scores: state.scores,
      yourBet: state.bets[userId] ?? null,
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.phase === "bet" && state.order[state.turn] === userId,
      winnerId: state.winner,
      draw: state.draw,
      finished: state.phase === "done",
    };
  },
  turnUserId: (s) => (s.phase === "bet" ? s.order[s.turn] ?? null : null),
  finished: (s) => s.phase === "done",
  winnerId: (s) => s.winner,
  autoMove() { return { bet: { kind: "red" } }; },
  lastEvent: (s) => (s.history.length ? `landed ${s.history[s.history.length - 1]}` : null),
};

// ---- Crash (choose a cash-out multiplier) --------------------------------

interface CrashState {
  cashouts: Record<string, number>;
  order: string[];
  turn: number;
  crashPoint: number;
  round: number;
  maxRounds: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
  seed: number;
  revealed: boolean;
}

export const crash: GameEngine<CrashState> = {
  id: "crash",
  create(ctx): CrashState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    const r = nextRandom(ctx.seed);
    return {
      cashouts: {}, order: ctx.players, turn: 0,
      crashPoint: Math.max(1.01, Math.round((1 / (1 - r.value * 0.9)) * 100) / 100),
      round: 0, maxRounds: 3, scores, winner: null, draw: false, seed: r.seed, revealed: false,
    };
  },
  apply(state, userId, move, ctx): EngineResult<CrashState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const target = Number((move as { cashout?: number }).cashout);
    if (!Number.isFinite(target) || target < 1.01 || target > 100) throw new Error("Cash out between 1.01x and 100x");
    state.cashouts[userId] = target;
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    state.revealed = true;
    for (const id of state.order) if (state.cashouts[id]! <= state.crashPoint) state.scores[id] = (state.scores[id] ?? 0) + Math.floor(state.cashouts[id]!);
    state.round += 1;
    state.cashouts = {};
    state.revealed = false;
    if (state.round >= state.maxRounds) {
      const best = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
      const tied = state.order.filter((id) => state.scores[id] === state.scores[best]);
      if (tied.length > 1 || state.scores[best] === 0) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = best;
      return { state, finished: true, winnerId: best };
    }
    const r = nextRandom(state.seed);
    state.seed = r.seed;
    state.crashPoint = Math.max(1.01, Math.round((1 / (1 - r.value * 0.9)) * 100) / 100);
    state.turn = 0;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      round: state.round,
      maxRounds: state.maxRounds,
      scores: state.scores,
      yourCashout: state.cashouts[userId] ?? null,
      revealedCrash: state.revealed ? state.crashPoint : null,
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
  autoMove() { return { cashout: 1.5 }; },
  lastEvent: (s) => (s.revealed ? `crashed at ${s.crashPoint}x` : null),
};

// ---- Plinko (solo, seeded path) ------------------------------------------

interface PlinkoState {
  drops: number;
  maxDrops: number;
  path: number[];
  slots: number[];
  payout: number;
  seed: number;
  winner: string | null;
  order: string[];
}

export const plinko: GameEngine<PlinkoState> = {
  id: "plinko",
  create(ctx): PlinkoState {
    return { drops: 0, maxDrops: 5, path: [], slots: [], payout: 0, seed: ctx.seed, winner: null, order: ctx.players };
  },
  apply(state, userId, move): EngineResult<PlinkoState> {
    if (state.winner !== null) throw new Error("This game has finished");
    if (state.order[0] !== userId) throw new Error("This is a solo machine");
    if ((move as { action?: string }).action !== "drop") throw new Error("Drop the ball");
    const r = nextRandom(state.seed);
    state.seed = r.seed;
    let pos = 0;
    const path: number[] = [];
    for (let i = 0; i < 8; i += 1) { const step = nextRandom(state.seed); state.seed = step.seed; const right = step.value > 0.5 ? 1 : 0; pos += right; path.push(right); }
    state.path = path;
    state.slots = state.slots.concat(pos);
    state.drops += 1;
    // Centre slots pay least, edges pay most.
    state.payout += Math.abs(pos - 4) >= 3 ? 10 : Math.abs(pos - 4) === 2 ? 3 : 0;
    if (state.drops >= state.maxDrops) {
      state.winner = state.payout > 0 ? userId : null;
      return { state, finished: true, winnerId: state.winner };
    }
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      drops: state.drops,
      maxDrops: state.maxDrops,
      path: state.path,
      slots: state.slots,
      payout: state.payout,
      yourTurn: state.order[0] === userId && state.winner === null && state.drops < state.maxDrops,
      turnUserId: state.winner === null && state.drops < state.maxDrops ? state.order[0] ?? null : null,
      winnerId: state.winner,
      finished: state.winner !== null || state.drops >= state.maxDrops,
    };
  },
  turnUserId: (s) => (s.winner === null && s.drops < s.maxDrops ? s.order[0] ?? null : null),
  finished: (s) => s.winner !== null || s.drops >= s.maxDrops,
  winnerId: (s) => s.winner,
  autoMove() { return { action: "drop" }; },
  lastEvent: () => "dropped",
};

// ---- Penalty Shootout -----------------------------------------------------

interface PenaltyState {
  rounds: Record<string, number>;
  order: string[];
  turn: number;
  round: number;
  maxRounds: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
  last: string | null;
}

export const penalty: GameEngine<PenaltyState> = {
  id: "penalty",
  create(ctx): PenaltyState {
    if (ctx.players.length !== 2) throw new Error("Penalty shootout is for two players");
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { rounds: {}, order: ctx.players, turn: 0, round: 0, maxRounds: 5, scores, winner: null, draw: false, last: null };
  },
  apply(state, userId, move): EngineResult<PenaltyState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const corner = Number((move as { corner?: number }).corner);
    if (!Number.isInteger(corner) || corner! < 0 || corner! > 3) throw new Error("Pick a corner from 0 to 3");
    state.rounds[userId] = corner!;
    const shooter = state.order[state.turn]!;
    const keeper = state.order[nextSeat(state.order, state.turn)]!;
    if (state.rounds[keeper] !== undefined && state.rounds[shooter] !== undefined) {
      // Both have chosen: a goal when the corners differ.
      if (state.rounds[shooter] !== state.rounds[keeper]) state.scores[shooter] = (state.scores[shooter] ?? 0) + 1;
      state.last = `${shooter} ${state.rounds[shooter] === state.rounds[keeper] ? "saved" : "scored"}`;
    }
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    state.round += 1;
    state.rounds = {};
    if (state.round >= state.maxRounds) {
      const [a, b] = state.order as [string, string];
      if (state.scores[a] === state.scores[b]) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = state.scores[a]! > state.scores[b]! ? a : b;
      return { state, finished: true, winnerId: state.winner };
    }
    state.turn = 0;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      scores: state.scores,
      round: state.round,
      maxRounds: state.maxRounds,
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
  autoMove(state) { return { corner: state.round % 4 }; },
  lastEvent: (s) => s.last,
};

// ---- Reaction Duel (closest to a hidden target) --------------------------

interface ReactionState {
  picks: Record<string, number>;
  target: number;
  order: string[];
  turn: number;
  round: number;
  maxRounds: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
  seed: number;
}

export const reaction: GameEngine<ReactionState> = {
  id: "reaction",
  create(ctx): ReactionState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    const r = nextRandom(ctx.seed);
    return { picks: {}, target: 1 + Math.floor(r.value * 100), order: ctx.players, turn: 0, round: 0, maxRounds: 3, scores, winner: null, draw: false, seed: r.seed };
  },
  apply(state, userId, move, ctx): EngineResult<ReactionState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const value = Number((move as { value?: number }).value);
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Pick a number from 1 to 100");
    state.picks[userId] = value;
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    let best = state.order[0]!;
    for (const id of state.order) {
      if (Math.abs(state.picks[id]! - state.target) < Math.abs(state.picks[best]! - state.target)) best = id;
    }
    state.scores[best] = (state.scores[best] ?? 0) + 1;
    state.round += 1;
    state.picks = {};
    if (state.round >= state.maxRounds) {
      const top = state.order.reduce((m, id) => (state.scores[id]! > state.scores[m]! ? id : m), state.order[0]!);
      const tied = state.order.filter((id) => state.scores[id] === state.scores[top]);
      if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = top;
      return { state, finished: true, winnerId: top };
    }
    const r = nextRandom(state.seed);
    state.seed = r.seed;
    state.target = 1 + Math.floor(r.value * 100);
    state.turn = 0;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      target: state.target,
      picks: state.picks,
      round: state.round,
      maxRounds: state.maxRounds,
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
  autoMove(state) { return { value: state.target }; },
  lastEvent: (s) => `target ${s.target}`,
};

// ---- Rock Paper Scissors --------------------------------------------------

const RPS_MOVES = ["rock", "paper", "scissors"] as const;

interface RpsState {
  choices: Record<string, string>;
  order: string[];
  turn: number;
  round: number;
  maxRounds: number;
  scores: Record<string, number>;
  winner: string | null;
  draw: boolean;
}

export const rps: GameEngine<RpsState> = {
  id: "rps",
  create(ctx): RpsState {
    const scores: Record<string, number> = {};
    for (const p of ctx.players) scores[p] = 0;
    return { choices: {}, order: ctx.players, turn: 0, round: 0, maxRounds: 5, scores, winner: null, draw: false };
  },
  apply(state, userId, move): EngineResult<RpsState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const choice = String((move as { choice?: string }).choice ?? "");
    if (!RPS_MOVES.includes(choice as never)) throw new Error("Choose rock, paper or scissors");
    state.choices[userId] = choice;
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    const [a, b] = state.order as [string, string];
    const beats: Record<string, string> = { rock: "scissors", paper: "rock", scissors: "paper" };
    if (beats[state.choices[a]!] === state.choices[b]) state.scores[a] = (state.scores[a] ?? 0) + 1;
    else if (beats[state.choices[b]!] === state.choices[a]) state.scores[b] = (state.scores[b] ?? 0) + 1;
    state.choices = {};
    state.round += 1;
    if (state.round >= state.maxRounds) {
      if (state.scores[a] === state.scores[b]) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = state.scores[a]! > state.scores[b]! ? a : b;
      return { state, finished: true, winnerId: state.winner };
    }
    state.turn = 0;
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      choices: state.choices,
      round: state.round,
      maxRounds: state.maxRounds,
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
  autoMove() { return { choice: "rock" }; },
  lastEvent: () => "played",
};
