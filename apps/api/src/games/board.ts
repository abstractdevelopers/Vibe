/**
 * Board-family engines: grid line games, checkers, reversi, battleship, dots.
 *
 * All of them are turn-based and server-authoritative. The line games share one
 * implementation parameterised by size and run length; the rest are small and
 * specific. Every engine exposes `autoMove`, which is what lets the test suite
 * (and a lone player) drive any game to a finish.
 */

import { nextRandom, nextSeat, shuffle, type EngineContext, type EngineResult, type GameEngine } from "./engine.js";

// ---- Line games: tic-tac-toe, Connect Four, Gomoku ------------------------

interface GridState {
  rows: number;
  cols: number;
  run: number;
  /** true = a piece falls to the lowest empty row in a column (Connect Four). */
  gravity: boolean;
  board: (number | null)[][];
  order: string[];
  turn: number;
  winner: number | null;
  draw: boolean;
  last: { row: number; col: number } | null;
}

function emptyBoard(rows: number, cols: number): (number | null)[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

function lineWin(board: (number | null)[][], row: number, col: number, run: number): boolean {
  const who = board[row]![col];
  if (who === null || who === undefined) return false;
  const dirs = [
    [0, 1], [1, 0], [1, 1], [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (const sign of [1, -1]) {
      let r = row + dr! * sign;
      let c = col + dc! * sign;
      while (r >= 0 && r < board.length && c >= 0 && c < board[0]!.length && board[r]![c] === who) {
        count += 1;
        r += dr! * sign;
        c += dc! * sign;
      }
    }
    if (count >= run) return true;
  }
  return false;
}

function makeLineGame(id: string, rows: number, cols: number, run: number, gravity: boolean): GameEngine<GridState> {
  return {
    id,
    create(ctx: EngineContext): GridState {
      return {
        rows, cols, run, gravity,
        board: emptyBoard(rows, cols),
        order: ctx.players,
        turn: 0,
        winner: null,
        draw: false,
        last: null,
      };
    },
    apply(state, userId, move, ctx): EngineResult<GridState> {
      if (state.winner !== null || state.draw) throw new Error("This game has finished");
      if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
      const m = move as { row?: number; col?: number };
      if (!Number.isInteger(m.col) || m.col! < 0 || m.col! >= cols) throw new Error("That column is off the board");
      let row: number;
      if (gravity) {
        row = -1;
        for (let r = rows - 1; r >= 0; r -= 1) if (state.board[r]![m.col!] === null) { row = r; break; }
        if (row === -1) throw new Error("That column is full");
      } else {
        if (!Number.isInteger(m.row) || m.row! < 0 || m.row! >= rows) throw new Error("That row is off the board");
        if (state.board[m.row!]![m.col!] !== null) throw new Error("That square is taken");
        row = m.row!;
      }
      const me = state.order.indexOf(userId);
      state.board[row]![m.col!] = me;
      state.last = { row, col: m.col! };
      if (lineWin(state.board, row, m.col!, run)) {
        state.winner = me;
        return { state, finished: true, winnerId: userId };
      }
      const full = state.board.every((r) => r.every((c) => c !== null));
      if (full) {
        state.draw = true;
        return { state, finished: true, winnerId: null, draw: true };
      }
      state.turn = nextSeat(state.order, state.turn);
      return { state, finished: false, winnerId: null };
    },
    view(state, userId, ctx) {
      return {
        board: state.board,
        yourSeat: state.order.indexOf(userId),
        turnUserId: state.order[state.turn] ?? null,
        yourTurn: state.order[state.turn] === userId,
        last: state.last,
        winnerId: state.winner === null ? null : state.order[state.winner],
        draw: state.draw,
        finished: state.winner !== null || state.draw,
        rows: state.rows,
        cols: state.cols,
      };
    },
    turnUserId: (state) => state.order[state.turn] ?? null,
    finished: (state) => state.winner !== null || state.draw,
    winnerId: (state) => (state.winner === null ? null : state.order[state.winner]!),
    autoMove(state, userId, ctx) {
      const me = state.order.indexOf(userId);
      const empties: { row: number; col: number }[] = [];
      for (let c = 0; c < state.cols; c += 1) {
        if (gravity) {
          if (state.board[0]![c] === null) empties.push({ row: -1, col: c });
        } else {
          for (let r = 0; r < state.rows; r += 1) if (state.board[r]![c] === null) empties.push({ row: r, col: c });
        }
      }
      if (empties.length === 0) return null;
      // Prefer a move that wins; otherwise block; otherwise the first legal.
      for (const e of empties) {
        const trial = cloneGrid(state);
        place(trial, e);
        const r = e.row === -1 ? firstEmptyRow(trial, e.col) : e.row;
        if (lineWin(trial.board, r, e.col, state.run)) return e;
      }
      for (const e of empties) {
        const trial = cloneGrid(state);
        const opp = me === 0 ? 1 : 0;
        const r = e.row === -1 ? firstEmptyRow(trial, e.col) : e.row;
        trial.board[r]![e.col] = opp;
        if (lineWin(trial.board, r, e.col, state.run)) return e;
      }
      return empties[0]!;
    },
    lastEvent: (state) => (state.draw ? "draw" : state.winner !== null ? "win" : "played"),
  };
}

function firstEmptyRow(state: GridState, col: number): number {
  for (let r = state.rows - 1; r >= 0; r -= 1) if (state.board[r]![col] === null) return r;
  return 0;
}
function place(state: GridState, e: { row: number; col: number }): void {
  const r = e.row === -1 ? firstEmptyRow(state, e.col) : e.row;
  state.board[r]![e.col] = 0;
}
function cloneGrid(state: GridState): GridState {
  return { ...state, board: state.board.map((r) => r.slice()) };
}

export const tictactoe = makeLineGame("tictactoe", 3, 3, 3, false);
export const connect4 = makeLineGame("connect4", 6, 7, 4, true);
export const gomoku = makeLineGame("gomoku", 15, 15, 5, false);

// ---- Checkers (8x8 draughts, flying kings, single-jump) -------------------

interface CheckersState {
  /** 8x8; 0 empty, 1 = player 0 man, 2 = player 0 king, 3 = player 1 man, 4 = player 1 king. */
  board: number[][];
  order: string[];
  turn: number;
  winner: number | null;
  last: { from: [number, number]; to: [number, number] } | null;
}

function owner(cell: number): number {
  if (cell === 1 || cell === 2) return 0;
  if (cell === 3 || cell === 4) return 1;
  return -1;
}
function isKing(cell: number): boolean {
  return cell === 2 || cell === 4;
}

export const checkers: GameEngine<CheckersState> = {
  id: "checkers",
  create(ctx): CheckersState {
    const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 0));
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        if ((r + c) % 2 === 1) {
          if (r < 3) board[r]![c] = 3; // player 1 men on top
          else if (r > 4) board[r]![c] = 1; // player 0 men at bottom
        }
      }
    }
    return { board, order: ctx.players, turn: 0, winner: null, last: null };
  },
  apply(state, userId, move): EngineResult<CheckersState> {
    if (state.winner !== null) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const m = move as { from: [number, number]; to: [number, number] };
    const [fr, fc] = m.from ?? [];
    const [tr, tc] = m.to ?? [];
    const me = state.order.indexOf(userId);
    if (!inBounds(fr, fc) || !inBounds(tr, tc)) throw new Error("That move is off the board");
    const cell = state.board[fr!]![fc!]!;
    if (owner(cell) !== me) throw new Error("That piece is not yours");
    const dr = tr! - fr!;
    const dc = tc! - fc!;
    if (Math.abs(dr) !== Math.abs(dc)) throw new Error("A move must be diagonal");
    const forward = me === 0 ? -1 : 1;
    const king = isKing(cell);
    if (Math.abs(dr) === 1) {
      if (!king && dr !== forward) throw new Error("That man cannot move backwards");
      if (state.board[tr!]![tc!] !== 0) throw new Error("That square is taken");
      state.board[tr!]![tc!] = cell;
      state.board[fr!]![fc!] = 0;
    } else if (Math.abs(dr) === 2) {
      const mr = (fr! + tr!) / 2;
      const mc = (fc! + tc!) / 2;
      const mid = state.board[mr]![mc]!;
      if (owner(mid) === me || owner(mid) === -1) throw new Error("A jump must clear an opponent piece");
      if (state.board[tr!]![tc!] !== 0) throw new Error("That square is taken");
      state.board[mr]![mc] = 0;
      state.board[tr!]![tc!] = cell;
      state.board[fr!]![fc!] = 0;
    } else {
      throw new Error("That move is not a legal step or jump");
    }
    // Promotion.
    const moved = state.board[tr!]![tc!]!;
    if (moved === 1 && tr === 0) state.board[tr!]![tc!] = 2;
    if (moved === 3 && tr === 7) state.board[tr!]![tc!] = 4;
    state.last = { from: [fr!, fc!], to: [tr!, tc!] };

    const opponent = me === 0 ? 1 : 0;
    if (!hasAnyMove(state.board, opponent)) {
      state.winner = me;
      return { state, finished: true, winnerId: userId };
    }
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      board: state.board,
      yourSeat: state.order.indexOf(userId),
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.order[state.turn] === userId,
      last: state.last,
      winnerId: state.winner === null ? null : state.order[state.winner],
      finished: state.winner !== null,
    };
  },
  turnUserId: (s) => s.order[s.turn] ?? null,
  finished: (s) => s.winner !== null,
  winnerId: (s) => (s.winner === null ? null : s.order[s.winner]!),
  autoMove(state, userId) {
    const me = state.order.indexOf(userId);
    const moves = allMoves(state.board, me);
    return moves[0] ?? null;
  },
  lastEvent: (s) => (s.winner !== null ? "win" : "moved"),
};

function inBounds(r: number | undefined, c: number | undefined): boolean {
  return Number.isInteger(r) && Number.isInteger(c) && r! >= 0 && r! < 8 && c! >= 0 && c! < 8;
}
function allMoves(board: number[][], me: number): { from: [number, number]; to: [number, number] }[] {
  const forward = me === 0 ? -1 : 1;
  const steps: { from: [number, number]; to: [number, number] }[] = [];
  const jumps: { from: [number, number]; to: [number, number] }[] = [];
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const cell = board[r]![c]!;
      if (owner(cell) !== me) continue;
      const king = isKing(cell);
      for (const dc of [-1, 1]) {
        for (const dr of king ? [-1, 1] : [forward]) {
          const tr = r + dr;
          const tc = c + dc;
          if (!inBounds(tr, tc)) continue;
          if (board[tr]![tc] === 0) steps.push({ from: [r, c], to: [tr, tc] });
          const jr = r + dr * 2;
          const jc = c + dc * 2;
          if (inBounds(jr, jc) && board[jr]![jc] === 0 && owner(board[r + dr]![c + dc]!) === (me === 0 ? 1 : 0)) {
            jumps.push({ from: [r, c], to: [jr, jc] });
          }
        }
      }
    }
  }
  // Jumps are mandatory in draughts.
  return jumps.length > 0 ? jumps : steps;
}
function hasAnyMove(board: number[][], me: number): boolean {
  return allMoves(board, me).length > 0;
}

// ---- Reversi / Othello ----------------------------------------------------

interface ReversiState {
  board: (number | null)[][];
  order: string[];
  turn: number;
  passes: number;
  winner: number | null;
  draw: boolean;
  last: { row: number; col: number } | null;
}

const R_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function flipsFor(board: (number | null)[][], row: number, col: number, me: number): [number, number][] {
  if (board[row]![col] !== null) return [];
  const out: [number, number][] = [];
  for (const [dr, dc] of R_DIRS) {
    const line: [number, number][] = [];
    let r = row + dr!;
    let c = col + dc!;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r]![c] !== null && board[r]![c] !== me) {
      line.push([r, c]);
      r += dr!;
      c += dc!;
    }
    if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r]![c] === me) out.push(...line);
  }
  return out;
}

export const reversi: GameEngine<ReversiState> = {
  id: "reversi",
  create(ctx): ReversiState {
    const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null as number | null));
    board[3]![3] = 1; board[4]![4] = 1;
    board[3]![4] = 0; board[4]![3] = 0;
    return { board, order: ctx.players, turn: 0, passes: 0, winner: null, draw: false, last: null };
  },
  apply(state, userId, move): EngineResult<ReversiState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const me = state.order.indexOf(userId);
    const m = move as { row: number; col: number };
    if (!Number.isInteger(m.row) || !Number.isInteger(m.col) || m.row < 0 || m.row > 7 || m.col < 0 || m.col > 7) {
      throw new Error("That square is off the board");
    }
    const flips = flipsFor(state.board, m.row, m.col, me);
    if (flips.length === 0) throw new Error("That move flips nothing");
    state.board[m.row]![m.col] = me;
    for (const [r, c] of flips) state.board[r]![c] = me;
    state.last = { row: m.row, col: m.col };
    state.passes = 0;
    return advanceReversi(state, me);
  },
  view(state, userId) {
    return {
      board: state.board,
      yourSeat: state.order.indexOf(userId),
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.order[state.turn] === userId,
      last: state.last,
      scores: countReversi(state.board),
      winnerId: state.winner === null ? null : state.order[state.winner],
      draw: state.draw,
      finished: state.winner !== null || state.draw,
    };
  },
  turnUserId: (s) => s.order[s.turn] ?? null,
  finished: (s) => s.winner !== null || s.draw,
  winnerId: (s) => (s.winner === null ? null : s.order[s.winner]!),
  autoMove(state, userId) {
    const me = state.order.indexOf(userId);
    for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) {
      if (flipsFor(state.board, r, c, me).length > 0) return { row: r, col: c };
    }
    return null;
  },
  lastEvent: (s) => (s.draw ? "draw" : s.winner !== null ? "win" : "played"),
};

function advanceReversi(state: ReversiState, me: number): EngineResult<ReversiState> {
  const other = me === 0 ? 1 : 0;
  if (hasReversiMove(state.board, other)) {
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  }
  if (hasReversiMove(state.board, me)) {
    // Opponent passes; the turn stays with `me` (no index change).
    state.passes += 1;
    return { state, finished: false, winnerId: null };
  }
  const [a, b] = countReversi(state.board);
  if (a === b) {
    state.draw = true;
    return { state, finished: true, winnerId: null, draw: true };
  }
  state.winner = a > b! ? 0 : 1;
  return { state, finished: true, winnerId: state.order[state.winner]! };
}
function countReversi(board: (number | null)[][]): [number, number] {
  let a = 0; let b = 0;
  for (const row of board) for (const c of row) { if (c === 0) a += 1; else if (c === 1) b += 1; }
  return [a, b];
}
function hasReversiMove(board: (number | null)[][], me: number): boolean {
  for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) if (flipsFor(board, r, c, me).length > 0) return true;
  return false;
}

// ---- Battleship -----------------------------------------------------------

interface BattleState {
  /** Each player's own fleet: list of ship cells with a hit flag. */
  fleets: Record<string, { r: number; c: number; hit: boolean }[]>;
  /** Shots each player has fired: "r,c". */
  shots: Record<string, string[]>;
  order: string[];
  turn: number;
  placed: string[];
  winner: number | null;
  last: { by: string; r: number; c: number; hit: boolean } | null;
}

const SHIP_LENGTHS = [5, 4, 3, 3, 2];

function placeFleet(seed: number): { r: number; c: number; hit: boolean }[] {
  let s = seed >>> 0;
  const cells: { r: number; c: number; hit: boolean }[] = [];
  const occupied = new Set<string>();
  for (const len of SHIP_LENGTHS) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rnd = shuffle(Array.from({ length: 100 }, (_, i) => i), s);
      s = (s + 0x9e3779b9) >>> 0;
      const start = rnd[0]!;
      const horiz = (rnd[1] ?? 0) % 2 === 0;
      const r0 = Math.floor(start / 10);
      const c0 = start % 10;
      const cellsFor: { r: number; c: number }[] = [];
      let ok = true;
      for (let i = 0; i < len; i += 1) {
        const r = horiz ? r0 : r0 + i;
        const c = horiz ? c0 + i : c0;
        if (r > 9 || c > 9 || occupied.has(`${r},${c}`)) { ok = false; break; }
        cellsFor.push({ r, c });
      }
      if (!ok) continue;
      for (const cell of cellsFor) { occupied.add(`${cell.r},${cell.c}`); cells.push({ ...cell, hit: false }); }
      break;
    }
  }
  return cells;
}

export const battleship: GameEngine<BattleState> = {
  id: "battleship",
  create(ctx): BattleState {
    const fleets: Record<string, { r: number; c: number; hit: boolean }[]> = {};
    const shots: Record<string, string[]> = {};
    ctx.players.forEach((p, i) => {
      fleets[p] = placeFleet(ctx.seed + i * 7919);
      shots[p] = [];
    });
    return { fleets, shots, order: ctx.players, turn: 0, placed: [], winner: null, last: null };
  },
  apply(state, userId, move): EngineResult<BattleState> {
    if (state.winner !== null) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const m = move as { r: number; c: number };
    if (!Number.isInteger(m.r) || !Number.isInteger(m.c) || m.r < 0 || m.r > 9 || m.c < 0 || m.c > 9) {
      throw new Error("That shot is off the board");
    }
    const key = `${m.r},${m.c}`;
    if (state.shots[userId]!.includes(key)) throw new Error("You already fired at that square");
    const opponent = state.order[nextSeat(state.order, state.turn)]!;
    state.shots[userId]!.push(key);
    const target = state.fleets[opponent]!.find((s) => s.r === m.r && s.c === m.c);
    const hit = Boolean(target);
    if (target) target!.hit = true;
    state.last = { by: userId, r: m.r, c: m.c, hit };
    const sunk = state.fleets[opponent]!.every((s) => s.hit);
    if (sunk) {
      state.winner = state.order.indexOf(userId);
      return { state, finished: true, winnerId: userId };
    }
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    const opponent = state.order.find((p) => p !== userId)!;
    return {
      yourFleet: state.fleets[userId] ?? [],
      yourShots: state.shots[userId] ?? [],
      // The opponent's ships are hidden; only hits/misses on them are shown.
      opponentShots: state.shots[opponent] ?? [],
      opponentHitCells: (state.shots[userId] ?? []).map((k) => {
        const [r, c] = k.split(",").map(Number);
        const ship = state.fleets[opponent]!.some((s) => s.r === r && s.c === c);
        return { r, c, hit: ship };
      }),
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.order[state.turn] === userId,
      last: state.last,
      winnerId: state.winner === null ? null : state.order[state.winner],
      finished: state.winner !== null,
    };
  },
  turnUserId: (s) => s.order[s.turn] ?? null,
  finished: (s) => s.winner !== null,
  winnerId: (s) => (s.winner === null ? null : s.order[s.winner]!),
  autoMove(state, userId) {
    for (let r = 0; r < 10; r += 1) for (let c = 0; c < 10; c += 1) {
      if (!state.shots[userId]!.includes(`${r},${c}`)) return { r, c };
    }
    return null;
  },
  lastEvent: (s) => (s.last ? (s.last.hit ? "hit" : "miss") : null),
};

// ---- Dots and Boxes -------------------------------------------------------

interface DotsState {
  /** Horizontal edges [rows][cols-1], vertical edges [rows-1][cols]; 0 none, 1/2 owner+1. */
  h: number[][];
  v: number[][];
  boxOwner: number[][];
  scores: [number, number];
  order: string[];
  turn: number;
  winner: number | null;
  draw: boolean;
  last: { kind: "h" | "v"; r: number; c: number } | null;
}

export const dots: GameEngine<DotsState> = {
  id: "dots",
  create(ctx): DotsState {
    const n = 5; // 5x5 dots -> 4x4 boxes
    return {
      h: Array.from({ length: n }, () => Array.from({ length: n - 1 }, () => 0)),
      v: Array.from({ length: n - 1 }, () => Array.from({ length: n }, () => 0)),
      boxOwner: Array.from({ length: n - 1 }, () => Array.from({ length: n - 1 }, () => -1)),
      scores: [0, 0],
      order: ctx.players,
      turn: 0,
      winner: null,
      draw: false,
      last: null,
    };
  },
  apply(state, userId, move): EngineResult<DotsState> {
    if (state.winner !== null || state.draw) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    const me = state.order.indexOf(userId);
    const m = move as { kind: "h" | "v"; r: number; c: number };
    if (m.kind === "h") {
      if (!state.h[m.r] || state.h[m.r]![m.c] === undefined) throw new Error("That edge is off the board");
      if (state.h[m.r]![m.c] !== 0) throw new Error("That edge is already drawn");
      state.h[m.r]![m.c] = me + 1;
    } else if (m.kind === "v") {
      if (!state.v[m.r] || state.v[m.r]![m.c] === undefined) throw new Error("That edge is off the board");
      if (state.v[m.r]![m.c] !== 0) throw new Error("That edge is already drawn");
      state.v[m.r]![m.c] = me + 1;
    } else {
      throw new Error("Unknown edge");
    }
    state.last = { kind: m.kind, r: m.r, c: m.c };
    // Claim any boxes completed by this edge.
    let claimed = 0;
    const n = state.boxOwner.length + 1;
    for (let r = 0; r < n - 1; r += 1) {
      for (let c = 0; c < n - 1; c += 1) {
        if (state.boxOwner[r]![c] !== -1) continue;
        if (state.h[r]![c]! !== 0 && state.h[r + 1]![c]! !== 0 && state.v[r]![c]! !== 0 && state.v[r]![c + 1]! !== 0) {
          state.boxOwner[r]![c] = me;
          state.scores[me] = (state.scores[me] ?? 0) + 1;
          claimed += 1;
        }
      }
    }
    const total = (n - 1) * (n - 1);
    if (state.scores[0]! + state.scores[1]! === total) {
      if (state.scores[0]! === state.scores[1]!) {
        state.draw = true;
        return { state, finished: true, winnerId: null, draw: true };
      }
      state.winner = state.scores[0]! > state.scores[1]! ? 0 : 1;
      return { state, finished: true, winnerId: state.order[state.winner]! };
    }
    if (claimed === 0) state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      h: state.h, v: state.v, boxOwner: state.boxOwner, scores: state.scores,
      yourSeat: state.order.indexOf(userId),
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.order[state.turn] === userId,
      last: state.last,
      winnerId: state.winner === null ? null : state.order[state.winner],
      draw: state.draw,
      finished: state.winner !== null || state.draw,
    };
  },
  turnUserId: (s) => s.order[s.turn] ?? null,
  finished: (s) => s.winner !== null || s.draw,
  winnerId: (s) => (s.winner === null ? null : s.order[s.winner]!),
  autoMove(state) {
    const n = state.boxOwner.length + 1;
    for (let r = 0; r < n; r += 1) for (let c = 0; c < n - 1; c += 1) if (state.h[r]![c] === 0) return { kind: "h", r, c };
    for (let r = 0; r < n - 1; r += 1) for (let c = 0; c < n; c += 1) if (state.v[r]![c] === 0) return { kind: "v", r, c };
    return null;
  },
  lastEvent: (s) => (s.draw ? "draw" : s.winner !== null ? "win" : "drew an edge"),
};

// ---- Snakes & Ladders (seeded dice) --------------------------------------

interface SnakesState {
  positions: Record<string, number>;
  order: string[];
  turn: number;
  lastRoll: number | null;
  winner: number | null;
  seed: number;
}

const SNAKES: Record<number, number> = { 16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78 };
const LADDERS: Record<number, number> = { 1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100 };

export const snakes: GameEngine<SnakesState> = {
  id: "snakes",
  create(ctx): SnakesState {
    const positions: Record<string, number> = {};
    for (const p of ctx.players) positions[p] = 0;
    return { positions, order: ctx.players, turn: 0, lastRoll: null, winner: null, seed: ctx.seed };
  },
  apply(state, userId, move): EngineResult<SnakesState> {
    if (state.winner !== null) throw new Error("This game has finished");
    if (state.order[state.turn] !== userId) throw new Error("It is not your turn");
    if ((move as { action?: string }).action !== "roll") throw new Error("Roll the dice");
    // The server rolls from its own seed — a client cannot choose its number.
    const r = nextRandom(state.seed);
    state.seed = r.seed;
    const roll = 1 + Math.floor(r.value * 6);
    let pos = state.positions[userId]! + roll;
    if (pos > 100) pos = state.positions[userId]!;
    if (SNAKES[pos]) pos = SNAKES[pos]!;
    if (LADDERS[pos]) pos = LADDERS[pos]!;
    state.positions[userId] = pos;
    state.lastRoll = roll;
    if (pos === 100) {
      state.winner = state.order.indexOf(userId);
      return { state, finished: true, winnerId: userId };
    }
    state.turn = nextSeat(state.order, state.turn);
    return { state, finished: false, winnerId: null };
  },
  view(state, userId) {
    return {
      positions: state.positions,
      lastRoll: state.lastRoll,
      turnUserId: state.order[state.turn] ?? null,
      yourTurn: state.order[state.turn] === userId,
      winnerId: state.winner === null ? null : state.order[state.winner],
      finished: state.winner !== null,
      snakes: SNAKES,
      ladders: LADDERS,
    };
  },
  turnUserId: (s) => s.order[s.turn] ?? null,
  finished: (s) => s.winner !== null,
  winnerId: (s) => (s.winner === null ? null : s.order[s.winner]!),
  autoMove() { return { action: "roll" }; },
  lastEvent: (s) => (s.lastRoll ? `rolled ${s.lastRoll}` : null),
};
