/**
 * Whot — the Nigerian card game, as a server-authoritative engine.
 *
 * The engine is pure: it takes a state and a move and returns a new state, or
 * throws. It never touches the database and never trusts the client — a move
 * names a card the player holds and the engine decides whether it is legal.
 * That is what makes staking safe: the server, not the browser, decides who won.
 *
 * Deck: the standard 59-card pack — Circle/Triangle/Star carry 1,2,3,4,5,7,8,
 * 10,11,12,13,14; Cross/Square carry the shorter 1,2,3,5,7,10,11,13,14; and five
 * Whot cards (the 20s) are wild.
 *
 * Specials: 1 hold on (play again), 2 pick two, 5 pick three, 8 suspension,
 * 14 general market (everyone else picks one), 20 Whot (name a shape). Pick
 * cards do not stack — a documented house rule — so a turn is always decisive.
 */

export type Shape = "circle" | "triangle" | "cross" | "square" | "star" | "whot";

export interface Card {
  shape: Shape;
  number: number;
}

export interface WhotState {
  /** Ordered player ids; seat index is the position here. */
  order: string[];
  hands: Record<string, Card[]>;
  market: Card[];
  discard: Card[];
  /** Index into `order` whose turn it is. */
  turn: number;
  /** The shape named after a Whot, or null. Overrides number matching. */
  calledShape: Exclude<Shape, "whot"> | null;
  winnerId: string | null;
  finished: boolean;
  /** Set when the last move left the player owing picks; for the client's sake. */
  lastEvent: string | null;
}

export type WhotMove =
  | { type: "play"; card: Card; callShape?: Exclude<Shape, "whot"> }
  | { type: "draw" };

const LONG_SHAPES: Shape[] = ["circle", "triangle", "star"];
const SHORT_SHAPES: Shape[] = ["cross", "square"];
const LONG_NUMBERS = [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14];
const SHORT_NUMBERS = [1, 2, 3, 5, 7, 10, 11, 13, 14];

/** Deterministic shuffle so a game can be replayed and tested. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const shape of LONG_SHAPES) for (const number of LONG_NUMBERS) deck.push({ shape, number });
  for (const shape of SHORT_SHAPES) for (const number of SHORT_NUMBERS) deck.push({ shape, number });
  for (let i = 0; i < 5; i += 1) deck.push({ shape: "whot", number: 20 });
  return deck;
}

function sameCard(a: Card, b: Card): boolean {
  return a.shape === b.shape && a.number === b.number;
}

/** Is `card` a legal play on the current top, given any Whot call? */
export function isPlayable(state: WhotState, card: Card): boolean {
  if (card.shape === "whot") return true;
  if (state.calledShape) return card.shape === state.calledShape;
  const top = state.discard[state.discard.length - 1];
  if (!top) return true;
  return card.shape === top.shape || card.number === top.number;
}

/** Deal a fresh game to `order`. Six cards each, one turned up. */
export function createWhotState(order: string[], seed: number): WhotState {
  if (order.length < 2) throw new Error("Whot needs at least two players");
  const deck = shuffle(buildDeck(), seed);
  const hands: Record<string, Card[]> = {};
  for (const id of order) hands[id] = deck.splice(0, 6);
  // The first turned card must not be a Whot, or the opener has nothing to match.
  let first = deck.shift()!;
  while (first.shape === "whot") {
    deck.push(first);
    first = deck.shift()!;
  }
  return {
    order,
    hands,
    market: deck,
    discard: [first],
    turn: 0,
    calledShape: null,
    winnerId: null,
    finished: false,
    lastEvent: null,
  };
}

function nextIndex(state: WhotState, from: number, steps = 1): number {
  return (from + steps) % state.order.length;
}

/** Draw `count` from the market, reshuffling the discard if the market is dry. */
function draw(state: WhotState, userId: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    if (state.market.length === 0) {
      // Keep the top discard; everything beneath is reshuffled back in.
      const top = state.discard.pop();
      state.market = shuffle(state.discard, (i + 1) * 7919);
      state.discard = top ? [top] : [];
    }
    const card = state.market.shift();
    if (!card) return;
    state.hands[userId]!.push(card);
  }
}

function removeCard(hand: Card[], card: Card): void {
  const idx = hand.findIndex((c) => sameCard(c, card));
  if (idx === -1) throw new Error("You do not hold that card");
  hand.splice(idx, 1);
}

/**
 * Apply a move. Throws a plain Error with a client-safe message when the move is
 * illegal; the route turns that into a 400.
 */
export function applyWhotMove(state: WhotState, userId: string, move: WhotMove): WhotState {
  if (state.finished) throw new Error("This game has finished");
  if (state.order[state.turn] !== userId) throw new Error("It is not your turn");

  if (move.type === "draw") {
    const before = state.hands[userId]!.length;
    draw(state, userId, 1);
    const drawn = state.hands[userId]![before];
    // A drawn card that is playable keeps the turn, so the player may use it.
    if (drawn && isPlayable(state, drawn)) {
      state.lastEvent = "draw.kept_turn";
      return state;
    }
    state.turn = nextIndex(state, state.turn);
    state.lastEvent = "draw.passed";
    return state;
  }

  const hand = state.hands[userId]!;
  if (!isPlayable(state, move.card)) throw new Error("That card does not match the top of the market");
  removeCard(hand, move.card);
  state.discard.push(move.card);
  state.calledShape = null;

  const n = move.card.number;
  if (move.card.shape === "whot") {
    if (!move.callShape) throw new Error("A Whot must name a shape");
    state.calledShape = move.callShape;
    state.lastEvent = `whot.${move.callShape}`;
  }

  // Empty hand wins, before any pick effects land on the next player.
  if (hand.length === 0) {
    state.finished = true;
    state.winnerId = userId;
    state.lastEvent = "win";
    return state;
  }

  switch (n) {
    case 1: // Hold on: the same player plays again.
      state.lastEvent = "hold_on";
      break;
    case 2: {
      const victim = state.order[nextIndex(state, state.turn)]!;
      draw(state, victim, 2);
      state.turn = nextIndex(state, state.turn, 2);
      state.lastEvent = "pick_two";
      break;
    }
    case 5: {
      const victim = state.order[nextIndex(state, state.turn)]!;
      draw(state, victim, 3);
      state.turn = nextIndex(state, state.turn, 2);
      state.lastEvent = "pick_three";
      break;
    }
    case 8: // Suspension: skip the next player.
      state.turn = nextIndex(state, state.turn, 2);
      state.lastEvent = "suspension";
      break;
    case 14: // General market: everyone else picks one.
      for (const id of state.order) if (id !== userId) draw(state, id, 1);
      state.turn = nextIndex(state, state.turn);
      state.lastEvent = "general_market";
      break;
    default:
      state.turn = nextIndex(state, state.turn);
      state.lastEvent = "played";
  }
  return state;
}

/** A viewer's slice of the state: their own hand, everyone's card counts. */
export function whotView(state: WhotState, userId: string): unknown {
  return {
    top: state.discard[state.discard.length - 1] ?? null,
    marketCount: state.market.length,
    calledShape: state.calledShape,
    turnUserId: state.order[state.turn] ?? null,
    yourTurn: state.order[state.turn] === userId,
    hand: state.hands[userId] ?? [],
    counts: state.order.map((id) => ({ userId: id, count: state.hands[id]?.length ?? 0 })),
    winnerId: state.winnerId,
    finished: state.finished,
    lastEvent: state.lastEvent,
  };
}
