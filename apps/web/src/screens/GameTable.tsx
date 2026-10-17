import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ScreenHeader } from "../components/ScreenHeader";
import { SpinnerIcon } from "../components/Icons";

/**
 * A game table.
 *
 * The board is whatever the server last told us: the top of the market, the
 * viewer's own hand, and a card count for everyone else. A move is a request —
 * the server validates it and returns the new state, so two players can never
 * disagree about whose turn it is.
 */

interface Card { shape: string; number: number }
interface Player {
  id: string; displayName: string; handle: string; avatarUrl: string | null;
  seat: number; status: string; stakedMinor: number;
}
interface GameState {
  top: Card | null;
  marketCount: number;
  calledShape: string | null;
  turnUserId: string | null;
  yourTurn: boolean;
  hand: Card[];
  counts: { userId: string; count: number }[];
  winnerId: string | null;
  finished: boolean;
  lastEvent: string | null;
}
interface Session {
  id: string; gameId: string; gameName: string; status: string;
  stakeMinor: number; potMinor: number; currency: string; hostId: string;
  minPlayers: number; maxPlayers: number; players: Player[]; state: GameState | null;
}

const SHAPE_GLYPH: Record<string, string> = {
  circle: "⬤", triangle: "▲", cross: "✚", square: "◼", star: "★", whot: "★",
};
const SHAPE_NAME: Record<string, string> = {
  circle: "Circle", triangle: "Triangle", cross: "Cross", square: "Square", star: "Star",
};

function money(minor: number, currency: string): string {
  return `${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`;
}

function CardFace({ card }: { card: Card }) {
  const whot = card.shape === "whot";
  return (
    <span className={`playing-card ${whot ? "whot" : card.shape}`} aria-label={whot ? "Whot 20" : `${SHAPE_NAME[card.shape]} ${card.number}`}>
      <span className="playing-card-shape" aria-hidden>{SHAPE_GLYPH[card.shape] ?? "?"}</span>
      <span className="playing-card-number">{card.number}</span>
    </span>
  );
}

export function GameTableScreen({ sessionId, viewerId, onBack }: { sessionId: string; viewerId: string; onBack: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [callShape, setCallShape] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ session: Session }>(`/v1/games/sessions/${sessionId}`);
      setSession(res.session);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the game");
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => { void load(); }, 2500);
    return () => window.clearInterval(t);
  }, [load]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ session: Session }>(`/v1/games/sessions/${sessionId}${path}`, { body: body ?? {} });
      setSession(res.session);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That move was refused");
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <>
        <ScreenHeader eyebrow="Play" title="Game" subtitle="Loading the table…" />
        {error && <div className="notice danger" role="alert">{error}</div>}
        <div className="skeleton" aria-busy="true" />
      </>
    );
  }

  const me = session.players.find((p) => p.id === viewerId);
  const isHost = session.hostId === viewerId;
  const state = session.state;
  const canStart = isHost && session.status === "lobby" && session.players.length >= session.minPlayers;
  const top = state?.top ?? null;

  function playable(card: Card): boolean {
    if (!state) return false;
    if (card.shape === "whot") return true;
    if (state.calledShape) return card.shape === state.calledShape;
    if (!top) return true;
    return card.shape === top.shape || card.number === top.number;
  }

  return (
    <>
      <ScreenHeader
        eyebrow="Play"
        title={session.gameName}
        subtitle={
          session.status === "lobby"
            ? `Waiting for players · ${session.players.length}/${session.maxPlayers}`
            : session.status === "finished"
              ? `Game over${state?.winnerId ? ` · ${session.players.find((p) => p.id === state.winnerId)?.displayName ?? "winner"} won` : ""}`
              : `Pot ${money(session.potMinor, session.currency)}`
        }
      />
      {error && <div className="notice danger" role="alert">{error}</div>}

      <section className="stack">
        <h2 className="section-title">Players</h2>
        {session.players.map((p) => {
          const count = state?.counts.find((c) => c.userId === p.id)?.count;
          const turn = state?.turnUserId === p.id && session.status === "active";
          return (
            <div key={p.id} className="card row spread">
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <span className={`chip ${turn ? "chip-live" : ""}`}>{turn ? "Turn" : `#${p.seat + 1}`}</span>
                <strong>{p.displayName}{p.id === viewerId ? " (you)" : ""}</strong>
              </div>
              <div className="row" style={{ gap: "var(--space-2)" }}>
                {p.stakedMinor > 0 && <span className="chip">{money(p.stakedMinor, session.currency)}</span>}
                {count !== undefined && <span className="meta">{count} cards</span>}
              </div>
            </div>
          );
        })}
      </section>

      {session.status === "lobby" && (
        <section className="stack">
          {!me && (
            <button className="btn primary block" disabled={busy} onClick={() => void act("/join")}>
              {session.stakeMinor > 0 ? `Join · stake ${money(session.stakeMinor, session.currency)}` : "Join game"}
            </button>
          )}
          {isHost && (
            <button className="btn primary block" disabled={busy || !canStart} onClick={() => void act("/start")}>
              {canStart ? "Start game" : `Need ${session.minPlayers} players`}
            </button>
          )}
          {me && <button className="btn" disabled={busy} onClick={() => void act("/leave")}>Leave</button>}
        </section>
      )}

      {session.status === "active" && state && (
        <section className="stack">
          <div className="game-market card">
            <span className="meta">Market {state.marketCount} · {state.calledShape ? `Call: ${SHAPE_NAME[state.calledShape]}` : "Top of the pile"}</span>
            {top && <CardFace card={top} />}
          </div>

          {state.yourTurn && !state.finished ? (
            <>
              <h2 className="section-title">Your hand</h2>
              <div className="hand-grid">
                {state.hand.map((card, i) => {
                  const ok = playable(card);
                  return (
                    <button
                      key={i}
                      className={`card-button ${ok ? "" : "disabled"}`}
                      disabled={busy || !ok || (card.shape === "whot" && !callShape)}
                      onClick={() => void act("/move", { move: card.shape === "whot" ? { type: "play", card, callShape } : { type: "play", card } })}
                    >
                      <CardFace card={card} />
                    </button>
                  );
                })}
              </div>
              <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
                <span className="meta">Call shape for Whot:</span>
                {(["circle", "triangle", "cross", "square", "star"] as const).map((s) => (
                  <button key={s} className="pill" aria-pressed={callShape === s} onClick={() => setCallShape(s)}>
                    {SHAPE_GLYPH[s]} {SHAPE_NAME[s]}
                  </button>
                ))}
              </div>
              <button className="btn block" disabled={busy} onClick={() => void act("/move", { move: { type: "draw" } })}>
                Draw a card
              </button>
            </>
          ) : (
            <div className="notice">
              {state.finished
                ? "This game has finished."
                : `Waiting for ${session.players.find((p) => p.id === state.turnUserId)?.displayName ?? "the other player"}…`}
            </div>
          )}
        </section>
      )}

      {session.status === "finished" && state?.hand && (
        <section className="stack">
          <h2 className="section-title">Your hand</h2>
          <div className="hand-grid">
            {state.hand.map((card, i) => <CardFace key={i} card={card} />)}
          </div>
        </section>
      )}

      <button className="btn" onClick={onBack}>Back</button>
      {busy && <div className="row" style={{ justifyContent: "center" }}><SpinnerIcon width={18} height={18} /></div>}
    </>
  );
}
