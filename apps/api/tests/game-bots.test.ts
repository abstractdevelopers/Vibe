import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness } from "./helpers.js";

/**
 * Playing the house.
 *
 * A table nobody joins should still be playable, so a session can be filled
 * with bots. These drive the public routes and play real moves, because the
 * property that matters is "the house answers and the game can finish", not
 * that a row exists.
 */

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

interface SessionView {
  id: string;
  status: string;
  players: Array<{ id: string; isBot: boolean; stakedMinor: number }>;
  state: {
    board?: Array<Array<number | null>>;
    turnUserId?: string | null;
    yourTurn?: boolean;
    finished?: boolean;
  } | null;
}

async function open(token: string, bots: number, stakeMinor = 0): Promise<SessionView> {
  const res = await h.app.inject({
    method: "POST", url: "/v1/games/sessions", headers: auth(token),
    payload: { gameId: "tictactoe", bots, botLevel: "steady", stakeMinor },
  });
  expect(res.statusCode).toBe(201);
  return res.json().session as SessionView;
}

async function load(token: string, id: string): Promise<SessionView> {
  const res = await h.app.inject({ method: "GET", url: `/v1/games/sessions/${id}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json().session as SessionView;
}

/**
 * The first empty cell.
 *
 * A cell is empty when it is `null`; the engines mark cells with a seat index,
 * and seat 0 is `0` — falsy. Testing `!cell` treats the first player's own marks
 * as empty and plays onto them.
 */
function firstEmpty(view: SessionView): { row: number; col: number } | null {
  const board = view.state?.board;
  if (!board) return null;
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row]!.length; col += 1) {
      if (board[row]![col] === null || board[row]![col] === undefined) return { row, col };
    }
  }
  return null;
}

describe("games against the house", () => {
  it("seats the bots, labels them, and takes no stake from them", async () => {
    const me = await registerUser(h.app, "solo1");
    const session = await open(me.token, 1);
    expect(session.players).toHaveLength(2);
    const bots = session.players.filter((p) => p.isBot);
    expect(bots).toHaveLength(1);
    expect(bots.every((p) => p.stakedMinor === 0)).toBe(true);
    expect(session.players.filter((p) => !p.isBot && p.id === me.id)).toHaveLength(1);
  });

  it("lets one person play a full game, with the house answering every move", async () => {
    const me = await registerUser(h.app, "solo2");
    const opened = await open(me.token, 1);
    const id = opened.id;

    const started = await h.app.inject({ method: "POST", url: `/v1/games/sessions/${id}/start`, headers: auth(me.token) });
    expect(started.statusCode).toBe(200);

    let view = await load(me.token, id);
    let moves = 0;
    while (view.status !== "finished" && moves < 12) {
      expect(view.state?.yourTurn).toBe(true);
      const move = firstEmpty(view);
      expect(move, "an empty cell should exist while the game is open").not.toBeNull();
      const res = await h.app.inject({
        method: "POST", url: `/v1/games/sessions/${id}/move`, headers: auth(me.token),
        payload: { move },
      });
      expect(res.statusCode, `move ${moves + 1} ${JSON.stringify(move)} -> ${res.body.slice(0, 160)}`).toBe(200);
      moves += 1;
      view = await load(me.token, id);
    }

    expect(view.status).toBe("finished");
    expect(moves).toBeLessThanOrEqual(9);
  });

  it("refuses a staked table against the house", async () => {
    // The house has no wallet, so a staked bot table could only take money from
    // the person and never pay it back. It is refused rather than played.
    const me = await registerUser(h.app, "solo3");
    const res = await h.app.inject({
      method: "POST", url: "/v1/games/sessions", headers: auth(me.token),
      payload: { gameId: "tictactoe", bots: 1, botLevel: "steady", stakeMinor: 50_000 },
    });
    expect(res.statusCode).toBe(400);
  });
});
