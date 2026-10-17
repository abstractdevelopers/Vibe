/**
 * The game-engine contract.
 *
 * Every game in Vibe implements this one interface, and the games routes only
 * ever talk to it. That is what lets the platform hold dozens of games without
 * the route layer knowing any rules: it asks the engine who moves next, hands it
 * a move, and stores whatever state comes back. The engine is the only thing
 * that decides legality and the winner, so staking stays safe — a client cannot
 * invent a result.
 *
 * Engines are pure with respect to the outside world: they take a state and a
 * move and return the next state, or throw a plain Error with a client-safe
 * message. They never touch the database. Randomness (dice, shuffles) is drawn
 * from a seed carried in the state, so a game is deterministic and replayable.
 */

export interface EngineContext {
  gameId: string;
  /** Player user ids in seat order. */
  players: string[];
  seed: number;
  stakeMinor: number;
}

export interface EngineResult<S> {
  state: S;
  finished: boolean;
  winnerId: string | null;
  /** Some games can end level (e.g. a memory tie); the route records it. */
  draw?: boolean;
}

export interface GameEngine<S = unknown> {
  id: string;
  /** Deal / set up a fresh game. */
  create(ctx: EngineContext): S;
  /** Validate and apply a move. Throws a client-safe Error when illegal. */
  apply(state: S, userId: string, move: unknown, ctx: EngineContext): EngineResult<S>;
  /** The viewer's slice of the state — never another player's secrets. */
  view(state: S, userId: string, ctx: EngineContext): unknown;
  /** Whose turn it is, or null when nobody is expected to move. */
  turnUserId(state: S, ctx: EngineContext): string | null;
  finished(state: S): boolean;
  winnerId(state: S): string | null;
  /**
   * A legal move for `userId`, or null if none. Used to drive the server-side
   * auto-play that proves every engine can reach a finish, and to let a lone
   * player face the house.
   */
  autoMove(state: S, userId: string, ctx: EngineContext): unknown;
  /** A one-line summary of the last event, for the room feed. */
  lastEvent?(state: S): string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const registry = new Map<string, GameEngine<any>>();

export function registerEngine(engine: GameEngine<any>): void {
  if (registry.has(engine.id)) throw new Error(`Duplicate engine id: ${engine.id}`);
  registry.set(engine.id, engine);
}

export function getEngine(id: string | null | undefined): GameEngine<any> | null {
  if (!id) return null;
  return registry.get(id) ?? null;
}

export function engineIds(): string[] {
  return [...registry.keys()];
}

// ---- Shared randomness ---------------------------------------------------

/** mulberry32: small, fast, seedable. Deterministic across runs. */
export function nextRandom(seed: number): { value: number; seed: number } {
  let a = (seed + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, seed: a };
}

export function shuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    const r = nextRandom(s);
    s = r.seed;
    const j = Math.floor(r.value * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---- Shared helpers for turn-based engines --------------------------------

/** Index of `userId` in an order, or -1. */
export function seatOf(order: string[], userId: string): number {
  return order.indexOf(userId);
}

export function nextSeat(order: string[], from: number, steps = 1): number {
  const n = order.length;
  return ((from + steps) % n + n) % n;
}
