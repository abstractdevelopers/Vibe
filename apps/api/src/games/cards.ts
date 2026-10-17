/**
 * Card-family engines: Blackjack, War, Go Fish, Crazy Eights, five-card draw
 * Poker and Baccarat.
 *
 * These share a standard 52-card deck and a seeded shuffle, so a hand is dealt
 * identically on every replay. As everywhere in Vibe, the server deals, the
 * server decides, and a client only ever sees its own hand.
 */

import { nextSeat, shuffle, type EngineContext, type EngineResult, type GameEngine } from "./engine.js";

type Suit = "S" | "H" | "D" | "C";
interface PlayingCard { rank: number; suit: Suit } // rank 1..13 (1=A, 11=J, 12=Q, 13=K)

function freshDeck(): PlayingCard[] {
  const suits: Suit[] = ["S", "H", "D", "C"];
  const deck: PlayingCard[] = [];
  for (const suit of suits) for (let rank = 1; rank <= 13; rank += 1) deck.push({ rank, suit });
  return deck;
}
const rankLabel = (r: number): string => ({ 1: "A", 11: "J", 12: "Q", 13: "K" }[r] ?? String(r));
const cardText = (c: PlayingCard): string => `${rankLabel(c.rank)}${c.suit}`;
function bjValue(c: PlayingCard): number {
  if (c.rank === 1) return 11;
  if (c.rank >= 11) return 10;
  return c.rank;
}
function bjTotal(hand: PlayingCard[]): number {
  let total = hand.reduce((n, c) => n + bjValue(c), 0);
  let aces = hand.filter((c) => c.rank === 1).length;
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

// ---- Blackjack (players vs the dealer) ------------------------------------

interface BlackjackState {
  deck: PlayingCard[];
  hands: Record<string, PlayingCard[]>;
  dealer: PlayingCard[];
  order: string[];
  turn: number;
  stood: string[];
  phase: "playing" | "dealer" | "done";
  winner: string | null;
  draw: boolean;
  last: string | null;
}

function drawCard(state: { deck: PlayingCard[] }): PlayingCard {
  const c = state.deck.shift();
  if (!c) throw new Error("The deck ran out");
  return c;
}

export const blackjack: GameEngine<BlackjackState> = {
  id: "blackjack",
  create(ctx): BlackjackState {
    const deck = shuffle(freshDeck(), ctx.seed);
    const hands: Record<string, PlayingCard[]> = {};
    for (const p of ctx.players) hands[p] = [deck.shift()!, deck.shift()!];
    const dealer = [deck.shift()!, deck.shift()!];
    return { deck, hands, dealer, order: ctx.players, turn: 0, stood: [], phase: "playing", winner: null, draw: false, last: null };
  },
  apply(state, userId, move): EngineResult<BlackjackState> {
    if (state.phase === "done") throw new Error("This game has finished");
    if (state.phase !== "playing") throw new Error("The dealer is playing; no moves now");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const action = (move as { action?: string }).action;
    const hand = state.hands[userId]!;
    if (action === "hit") {
      hand.push(drawCard(state));
      state.last = `${userId} hit`;
      if (bjTotal(hand) > 21) {
        state.stood.push(userId);
        state.last = `${userId} bust`;
        return advanceBlackjack(state);
      }
      return { state, finished: false, winnerId: null };
    }
    if (action === "stand") {
      state.stood.push(userId);
      state.last = `${userId} stood`;
      return advanceBlackjack(state);
    }
    throw new Error("A blackjack move is 'hit' or 'stand'");
  },
  view(state, userId) {
    const myTotal = bjTotal(state.hands[userId] ?? []);
    return {
      yourHand: state.hands[userId] ?? [],
      yourTotal: myTotal,
      // The dealer's hole card is hidden while players act.
      dealer: state.phase === "playing" ? [state.dealer[0]!] : state.dealer,
      dealerTotal: state.phase === "playing" ? null : bjTotal(state.dealer),
      counts: state.order.map((id) => ({ userId: id, count: state.hands[id]!.length, total: bjTotal(state.hands[id]!) })),
      turnUserId: state.phase === "playing" ? state.order[state.turn] ?? null : null,
      yourTurn: state.phase === "playing" && state.order[state.turn] === userId,
      winnerId: state.winner,
      draw: state.draw,
      finished: state.phase === "done",
    };
  },
  turnUserId: (s) => (s.phase === "playing" ? s.order[s.turn] ?? null : null),
  finished: (s) => s.phase === "done",
  winnerId: (s) => s.winner,
  autoMove(state, userId) {
    return { action: bjTotal(state.hands[userId]!) < 17 ? "hit" : "stand" };
  },
  lastEvent: (s) => s.last,
};

function advanceBlackjack(state: BlackjackState): EngineResult<BlackjackState> {
  if (state.turn + 1 < state.order.length) {
    state.turn += 1;
    return { state, finished: false, winnerId: null };
  }
  // Everyone has acted: the dealer draws to 17.
  while (bjTotal(state.dealer) < 17) state.dealer.push(drawCard(state));
  const dealerTotal = bjTotal(state.dealer);
  let best: string | null = null;
  let bestTotal = -1;
  for (const p of state.order) {
    const t = bjTotal(state.hands[p]!);
    if (t <= 21 && t > bestTotal && (dealerTotal > 21 || t > dealerTotal)) { best = p; bestTotal = t; }
  }
  state.phase = "done";
  state.winner = best;
  state.draw = best === null;
  state.last = best ? `${best} wins` : "dealer takes it";
  return { state, finished: true, winnerId: best, draw: state.draw };
}

// ---- War (highest card takes the round; most cards wins) ------------------

interface WarState {
  deck: PlayingCard[];
  hands: Record<string, PlayingCard[]>;
  order: string[];
  turn: number;
  last: { a: PlayingCard; b: PlayingCard } | null;
  winner: string | null;
  draw: boolean;
  flips: number;
  maxFlips: number;
}

export const war: GameEngine<WarState> = {
  id: "war",
  create(ctx): WarState {
    if (ctx.players.length !== 2) throw new Error("War is for two players");
    const deck = shuffle(freshDeck(), ctx.seed);
    const [p0, p1] = ctx.players as [string, string];
    return { deck: [], hands: { [p0]: deck.slice(0, 26), [p1]: deck.slice(26) }, order: ctx.players, turn: 0, last: null, winner: null, draw: false, flips: 0, maxFlips: 200 };
  },
  apply(state, userId, move): EngineResult<WarState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    if ((move as { action?: string }).action !== "flip") throw new Error("Play is a single flip");
    const [p0, p1] = state.order as [string, string];
    const a = state.hands[p0]!.shift();
    const b = state.hands[p1]!.shift();
    if (!a || !b) throw new Error("A hand is empty");
    state.last = { a, b };
    state.flips += 1;
    const winnerSeat = a.rank === b.rank ? -1 : a.rank > b.rank ? 0 : 1;
    if (winnerSeat === -1) {
      // War: both cards go back to the bottom, no change of hands.
      state.hands[p0]!.push(a);
      state.hands[p1]!.push(b);
    } else {
      const w = winnerSeat === 0 ? p0 : p1;
      state.hands[w]!.push(a, b);
    }
    if (state.hands[p0]!.length === 0 || state.hands[p1]!.length === 0) {
      state.winner = state.hands[p0]!.length === 0 ? p1 : p0;
      return { state, finished: true, winnerId: state.winner };
    }
    // War can run forever; cap it so a staked game always settles. The larger
    // hand takes it, and a dead heat is a draw (the stakes are refunded).
    if (state.flips >= state.maxFlips) {
      const [n0, n1] = [state.hands[p0]!.length, state.hands[p1]!.length];
      if (n0 === n1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
      state.winner = n0 > n1 ? p0 : p1;
      return { state, finished: true, winnerId: state.winner };
    }
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      yourCount: state.hands[userId]?.length ?? 0,
      counts: state.order.map((id) => ({ userId: id, count: state.hands[id]!.length })),
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
  autoMove() { return { action: "flip" }; },
  lastEvent: (s) => (s.last ? `${cardText(s.last.a)} vs ${cardText(s.last.b)}` : null),
};

// ---- Go Fish --------------------------------------------------------------

interface GoFishState {
  deck: PlayingCard[];
  hands: Record<string, PlayingCard[]>;
  books: Record<string, number>;
  order: string[];
  turn: number;
  last: string | null;
  winner: string | null;
  draw: boolean;
}

export const gofish: GameEngine<GoFishState> = {
  id: "gofish",
  create(ctx): GoFishState {
    const deck = shuffle(freshDeck(), ctx.seed);
    const hands: Record<string, PlayingCard[]> = {};
    const books: Record<string, number> = {};
    for (const p of ctx.players) { hands[p] = deck.splice(0, 5); books[p] = 0; }
    return { deck, hands, books, order: ctx.players, turn: 0, last: null, winner: null, draw: false };
  },
  apply(state, userId, move, ctx): EngineResult<GoFishState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    // A player with no cards either refills from the deck or, if it is empty,
    // passes. Either way they do not ask this turn.
    if (state.hands[userId]!.length === 0) {
      if (state.deck.length > 0) {
        state.hands[userId]!.push(state.deck.shift()!);
        state.last = `${userId} refilled`;
      } else {
        state.last = `${userId} is out of cards`;
      }
      state.turn = nextSeat(state.order, state.turn);
      return finishIfDone(state, ctx);
    }
    const { targetId, rank } = move as { targetId: string; rank: number };
    if (!state.order.includes(targetId) || targetId === userId) throw new Error("Pick another player");
    if (!Number.isInteger(rank) || rank < 1 || rank > 13) throw new Error("Pick a rank from Ace to King");
    if (!state.hands[userId]!.some((c) => c.rank === rank)) throw new Error("You do not hold that rank");
    const taken = state.hands[targetId]!.filter((c) => c.rank === rank);
    if (taken.length > 0) {
      state.hands[targetId] = state.hands[targetId]!.filter((c) => c.rank !== rank);
      state.hands[userId]!.push(...taken);
      state.last = `${userId} took ${taken.length} ${rankLabel(rank)}s from ${targetId}`;
    } else {
      if (state.deck.length > 0) {
        const c = state.deck.shift()!;
        state.hands[userId]!.push(c);
        state.last = `${userId} went fishing`;
      } else {
        state.last = `${userId} asked; nothing left to fish`;
      }
      state.turn = nextSeat(state.order, state.turn);
    }
    collectBooks(state, userId);
    return finishIfDone(state, ctx);
  },
  view(state, userId) {
    return {
      yourHand: state.hands[userId] ?? [],
      counts: state.order.map((id) => ({ userId: id, count: state.hands[id]!.length, books: state.books[id]! })),
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
  autoMove(state, userId) {
    const hand = state.hands[userId]!;
    // With no cards the engine will refill or pass regardless of the move, so a
    // placeholder keeps the caller simple.
    if (hand.length === 0) {
      const other = state.order.find((id) => id !== userId)!;
      return { targetId: other, rank: 1 };
    }
    const rank = hand[0]!.rank;
    const target = state.order.find((id) => id !== userId && state.hands[id]!.some((c) => c.rank === rank))
      ?? state.order.find((id) => id !== userId);
    return target ? { targetId: target, rank } : null;
  },
  lastEvent: (s) => s.last,
};

function collectBooks(state: GoFishState, userId: string): void {
  const hand = state.hands[userId]!;
  const counts = new Map<number, number>();
  for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  for (const [rank, n] of counts) {
    if (n === 4) {
      state.hands[userId] = hand.filter((c) => c.rank !== rank);
      state.books[userId] = (state.books[userId] ?? 0) + 1;
    }
  }
}

function finishIfDone(state: GoFishState, ctx: EngineContext): EngineResult<GoFishState> {
  const totalBooks = state.order.reduce((n, id) => n + (state.books[id] ?? 0), 0);
  const handsEmpty = state.order.every((id) => state.hands[id]!.length === 0);
  if (totalBooks < 13 && !(handsEmpty && state.deck.length === 0)) {
    return { state, finished: false, winnerId: null };
  }
  let best = state.order[0]!;
  for (const id of state.order) if (state.books[id]! > state.books[best]!) best = id;
  const tied = state.order.filter((id) => state.books[id] === state.books[best]);
  if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
  state.winner = best;
  return { state, finished: true, winnerId: best };
}

// ---- Crazy Eights ---------------------------------------------------------

interface EightsState {
  deck: PlayingCard[];
  hands: Record<string, PlayingCard[]>;
  discard: PlayingCard[];
  order: string[];
  turn: number;
  suit: Suit;
  winner: string | null;
  draw: boolean;
  last: string | null;
}

export const crazyeights: GameEngine<EightsState> = {
  id: "crazyeights",
  create(ctx): EightsState {
    const deck = shuffle(freshDeck(), ctx.seed);
    const hands: Record<string, PlayingCard[]> = {};
    for (const p of ctx.players) hands[p] = deck.splice(0, 5);
    const first = deck.shift()!;
    return { deck, hands, discard: [first], order: ctx.players, turn: 0, suit: first.suit, winner: null, draw: false, last: null };
  },
  apply(state, userId, move): EngineResult<EightsState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const { card, suit } = move as { card?: PlayingCard; suit?: Suit; draw?: boolean };
    const hand = state.hands[userId]!;
    const top = state.discard[state.discard.length - 1]!;
    // A player with no legal card draws; if the deck is empty they pass.
    if (!card) {
      if (state.deck.length > 0) {
        hand.push(state.deck.shift()!);
        state.last = `${userId} drew`;
        return { state, finished: false, winnerId: null };
      }
      state.turn = nextSeat(state.order, state.turn);
      state.last = `${userId} passed`;
      return { state, finished: false, winnerId: null };
    }
    const idx = hand.findIndex((c) => c.rank === card.rank && c.suit === card.suit);
    if (idx === -1) throw new Error("You do not hold that card");
    const legal = card.rank === 8 || card.suit === state.suit || card.rank === top.rank;
    if (!legal) throw new Error("That card does not match the suit or rank");
    hand.splice(idx, 1);
    state.discard.push(card);
    state.suit = card.rank === 8 ? (suit ?? card.suit) : card.suit;
    state.last = `${userId} played ${cardText(card)}`;
    if (hand.length === 0) { state.winner = userId; return { state, finished: true, winnerId: userId }; }
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      yourHand: state.hands[userId] ?? [],
      discardTop: state.discard[state.discard.length - 1] ?? null,
      activeSuit: state.suit,
      deckCount: state.deck.length,
      counts: state.order.map((id) => ({ userId: id, count: state.hands[id]!.length })),
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.order[state.turn] === userId,
      winnerId: state.winner,
      finished: state.winner !== null,
    };
  },
  turnUserId: (s) => s.order[s.turn] ?? null,
  finished: (s) => s.winner !== null,
  winnerId: (s) => s.winner,
  autoMove(state, userId) {
    const top = state.discard[state.discard.length - 1]!;
    const hand = state.hands[userId]!;
    const play = hand.find((c) => c.rank === 8 || c.suit === state.suit || c.rank === top.rank);
    // No play and an empty deck would stall; fall back to the lowest card so the
    // engine always makes progress.
    if (!play && state.deck.length === 0 && hand.length > 0) return { card: hand[0]! };
    return play ? { card: play } : { draw: true };
  },
  lastEvent: (s) => s.last,
};

// ---- Five-card draw poker -------------------------------------------------

const HAND_NAMES = ["high card", "pair", "two pair", "three of a kind", "straight", "flush", "full house", "four of a kind", "straight flush"];

/** Score a 5-card hand: a category plus tie-breakers. Higher is better. */
export function scoreHand(hand: PlayingCard[]): { category: number; tiebreak: number[] } {
  const ranks = hand.map((c) => c.rank).sort((a, b) => a - b);
  const suits = new Set(hand.map((c) => c.suit));
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = suits.size === 1;
  const unique = [...new Set(ranks)];
  let straight = false;
  if (unique.length === 5 && unique[4]! - unique[0]! === 4) straight = true;
  // Wheel: A-2-3-4-5.
  const wheel = unique.length === 5 && unique.join(",") === "1,2,3,4,5";
  if (wheel) straight = true;
  if (flush && straight) return { category: 8, tiebreak: wheel ? [5] : [unique[4]!] };
  if (groups[0]![1] === 4) return { category: 7, tiebreak: [groups[0]![0], groups[1]![0]] };
  if (groups[0]![1] === 3 && groups[1]![1] === 2) return { category: 6, tiebreak: [groups[0]![0], groups[1]![0]] };
  if (flush) return { category: 5, tiebreak: ranks.slice().reverse() };
  if (straight) return { category: 4, tiebreak: wheel ? [5] : [unique[4]!] };
  if (groups[0]![1] === 3) return { category: 3, tiebreak: [groups[0]![0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)] };
  if (groups[0]![1] === 2 && groups[1]![1] === 2) {
    const pairs = [groups[0]![0], groups[1]![0]].sort((a, b) => b - a);
    return { category: 2, tiebreak: [...pairs, groups[2]![0]] };
  }
  if (groups[0]![1] === 2) return { category: 1, tiebreak: [groups[0]![0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)] };
  return { category: 0, tiebreak: ranks.slice().reverse() };
}
export function compareHands(a: PlayingCard[], b: PlayingCard[]): number {
  const sa = scoreHand(a); const sb = scoreHand(b);
  if (sa.category !== sb.category) return sa.category - sb.category;
  for (let i = 0; i < Math.max(sa.tiebreak.length, sb.tiebreak.length); i += 1) {
    const d = (sa.tiebreak[i] ?? 0) - (sb.tiebreak[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface PokerState {
  deck: PlayingCard[];
  hands: Record<string, PlayingCard[]>;
  order: string[];
  turn: number;
  discarded: string[];
  phase: "draw" | "done";
  winner: string | null;
  draw: boolean;
  last: string | null;
}

export const poker: GameEngine<PokerState> = {
  id: "poker",
  create(ctx): PokerState {
    const deck = shuffle(freshDeck(), ctx.seed);
    const hands: Record<string, PlayingCard[]> = {};
    for (const p of ctx.players) hands[p] = deck.splice(0, 5);
    return { deck, hands, order: ctx.players, turn: 0, discarded: [], phase: "draw", winner: null, draw: false, last: null };
  },
  apply(state, userId, move): EngineResult<PokerState> {
    if (state.phase === "done") throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const { discard } = move as { discard?: number[] };
    const hand = state.hands[userId]!;
    const picks = Array.isArray(discard) ? discard : [];
    if (picks.length > 5) throw new Error("You can discard at most five cards");
    const next: PlayingCard[] = [];
    const removed: PlayingCard[] = [];
    hand.forEach((c, i) => (picks.includes(i) ? removed.push(c) : next.push(c)));
    for (let i = 0; i < removed.length; i += 1) next.push(drawCard(state));
    state.hands[userId] = next;
    state.last = `${userId} drew ${removed.length}`;
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    // Showdown.
    let best = state.order[0]!;
    for (const id of state.order) if (compareHands(state.hands[id]!, state.hands[best]!) > 0) best = id;
    const tied = state.order.filter((id) => compareHands(state.hands[id]!, state.hands[best]!) === 0);
    state.phase = "done";
    if (tied.length > 1) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
    state.winner = best;
    state.last = `${best} wins with ${HAND_NAMES[scoreHand(state.hands[best]!).category]}`;
    return { state, finished: true, winnerId: best };
  },
  view(state, userId) {
    return {
      yourHand: state.hands[userId] ?? [],
      yourHandName: HAND_NAMES[scoreHand(state.hands[userId] ?? []).category],
      counts: state.order.map((id) => ({ userId: id, count: state.hands[id]!.length })),
      // Hands are only revealed at the showdown.
      showdown: state.phase === "done"
        ? state.order.map((id) => ({ userId: id, hand: state.hands[id]!, name: HAND_NAMES[scoreHand(state.hands[id]!).category] }))
        : null,
      turnUserId: state.phase === "draw" ? state.order[state.turn] ?? null : null,
      yourTurn: state.phase === "draw" && state.order[state.turn] === userId,
      winnerId: state.winner,
      draw: state.draw,
      finished: state.phase === "done",
    };
  },
  turnUserId: (s) => (s.phase === "draw" ? s.order[s.turn] ?? null : null),
  finished: (s) => s.phase === "done",
  winnerId: (s) => s.winner,
  autoMove(state, userId) {
    // Keep any pair or better; redraw the rest.
    const hand = state.hands[userId]!;
    const counts = new Map<number, number>();
    for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
    const discard = hand.map((c, i) => (counts.get(c.rank)! > 1 ? -1 : i)).filter((i) => i >= 0);
    return { discard };
  },
  lastEvent: (s) => s.last,
};

// ---- Baccarat (player hand vs banker hand) --------------------------------

interface BaccaratState {
  deck: PlayingCard[];
  player: PlayingCard[];
  banker: PlayingCard[];
  order: string[];
  bets: Record<string, "player" | "banker" | "tie">;
  turn: number;
  phase: "bet" | "done";
  winner: string | null;
  draw: boolean;
  last: string | null;
}

const baccaratValue = (hand: PlayingCard[]): number => hand.reduce((n, c) => n + (c.rank >= 10 ? 0 : c.rank), 0) % 10;

export const baccarat: GameEngine<BaccaratState> = {
  id: "baccarat",
  create(ctx): BaccaratState {
    return { deck: shuffle(freshDeck(), ctx.seed), player: [], banker: [], order: ctx.players, bets: {}, turn: 0, phase: "bet", winner: null, draw: false, last: null };
  },
  apply(state, userId, move): EngineResult<BaccaratState> {
    if (state.phase === "done") throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const { bet } = move as { bet?: "player" | "banker" | "tie" };
    if (bet !== "player" && bet !== "banker" && bet !== "tie") throw new Error("Bet on player, banker or tie");
    state.bets[userId] = bet;
    state.last = `${userId} backed ${bet}`;
    if (state.turn + 1 < state.order.length) {
      state.turn += 1;
      return { state, finished: false, winnerId: null };
    }
    // Deal and play out the hands (simplified third-card rule).
    state.player = [drawCard(state), drawCard(state)];
    state.banker = [drawCard(state), drawCard(state)];
    if (baccaratValue(state.player) < 8 && baccaratValue(state.banker) < 8) {
      if (baccaratValue(state.player) <= 5) state.player.push(drawCard(state));
      const p3 = state.player[2];
      const bankerTotal = baccaratValue(state.banker);
      if (p3 === undefined) {
        if (bankerTotal <= 5) state.banker.push(drawCard(state));
      } else {
        const v = p3.rank >= 10 ? 0 : p3.rank;
        const shouldDraw = bankerTotal <= 2 || (bankerTotal === 3 && v !== 8) || (bankerTotal === 4 && v >= 2 && v <= 7)
          || (bankerTotal === 5 && v >= 4 && v <= 7) || (bankerTotal === 6 && v >= 6 && v <= 7);
        if (shouldDraw) state.banker.push(drawCard(state));
      }
    }
    const pv = baccaratValue(state.player);
    const bv = baccaratValue(state.banker);
    const result = pv > bv ? "player" : bv > pv ? "banker" : "tie";
    const winners = state.order.filter((id) => state.bets[id] === result);
    state.phase = "done";
    state.last = `${result} wins (${pv}-${bv})`;
    if (winners.length === 0) { state.draw = true; return { state, finished: true, winnerId: null, draw: true }; }
    state.winner = winners[0]!;
    return { state, finished: true, winnerId: state.winner };
  },
  view(state, userId) {
    return {
      yourBet: state.bets[userId] ?? null,
      player: state.player,
      banker: state.banker,
      playerValue: state.player.length ? baccaratValue(state.player) : null,
      bankerValue: state.banker.length ? baccaratValue(state.banker) : null,
      turnUserId: state.phase === "bet" ? state.order[state.turn] ?? null : null,
      yourTurn: state.phase === "bet" && state.order[state.turn] === userId,
      winnerId: state.winner,
      draw: state.draw,
      finished: state.phase === "done",
    };
  },
  turnUserId: (s) => (s.phase === "bet" ? s.order[s.turn] ?? null : null),
  finished: (s) => s.phase === "done",
  winnerId: (s) => s.winner,
  autoMove() { return { bet: "player" }; },
  lastEvent: (s) => s.last,
};
