import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, ApiError } from "../api";
import { ScreenHeader } from "../components/ScreenHeader";
import { Avatar } from "../components/Avatar";
import { formatMoney } from "../money";
import { SpinnerIcon, ArrowLeftIcon } from "../components/Icons";
import { ShapeMark, SuitMark, Piece, WHOT_SHAPES, SHAPE_NAME } from "../components/CardFaces";
import { useActivityTheme } from "../components/useActivityTheme";
import { themeForGame } from "../themes";
import { feltFor, worldFor, worldVars } from "../components/GameArt";
// Split out with this lazy chunk rather than shipped in the launch bundle.
import "../game-table.css";

/**
 * A game table.
 *
 * One screen plays every game. The server decides the rules and sends back a
 * per-viewer state; this component only knows how to draw the families of state
 * the engines produce (a grid, a hand of cards, a board of discs, a set of
 * options). It never decides who won — it renders what the server said.
 */

interface Player {
  id: string; displayName: string; handle: string; avatarUrl: string | null;
  seat: number; status: string; stakedMinor: number;
}
interface Session {
  id: string; gameId: string; gameName: string; category: string; status: string;
  stakeMinor: number; potMinor: number; currency: string; hostId: string;
  minPlayers: number; maxPlayers: number; players: Player[]; state: any;
  winnerId: string | null;
}

const SUIT_NAME: Record<string, string> = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const RANK_LABEL: Record<number, string> = { 1: "A", 11: "J", 12: "Q", 13: "K" };

const rankText = (r: number) => RANK_LABEL[r] ?? String(r);

export function GameTableScreen({ sessionId, viewerId, onBack }: { sessionId: string; viewerId: string; onBack: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useActivityTheme(session ? themeForGame(session.gameId) : null);

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

  /**
   * Leaving is not a move. The server answers with { left }, not a session, so
   * the table must navigate away rather than try to render a reply that has no
   * state — which used to leave the screen stuck on "Loading the table".
   */
  async function leave() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/games/sessions/${sessionId}/leave`, { body: {} });
      onBack();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not leave the table");
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
  const canStart = isHost && session.status === "lobby" && session.players.length >= session.minPlayers;
  const inPlay = session.status === "active";
  const canLeave = Boolean(me) && session.status !== "finished";
  // Captured here because the confirm text is read inside a closure, where the
  // narrowing of `session` above no longer holds.
  const staked = session.stakeMinor > 0;
  const othersWaiting = session.players.length > 1;

  function confirmLeave() {
    if (inPlay && staked) {
      if (!window.confirm("Leave mid-game? Your stake is forfeited to the other players.")) return;
    } else if (inPlay) {
      if (!window.confirm("Leave this game? It continues without you.")) return;
    } else if (isHost && othersWaiting) {
      if (!window.confirm("Leave and close this table? Everyone waiting will be refunded.")) return;
    }
    void leave();
  }

  return (
    <>
      <ScreenHeader
        eyebrow="Play"
        title={session.gameName}
        action={
          <div className="row" style={{ gap: "var(--space-2)" }}>
            {canLeave && (
              <button className="btn" disabled={busy} onClick={confirmLeave}>Leave</button>
            )}
            <button className="icon-button" aria-label="Back to games" onClick={onBack}>
              <ArrowLeftIcon width={20} height={20} />
            </button>
          </div>
        }
        subtitle={
          session.status === "lobby"
            ? `Waiting for players · ${session.players.length}/${session.maxPlayers}`
            : session.status === "finished"
              ? `Game over${session.winnerId ? ` · ${session.players.find((p) => p.id === session.winnerId)?.displayName ?? "winner"} won` : " · draw"}`
              : session.potMinor > 0 ? `Pot ${formatMoney(session.potMinor, session.currency)}` : "In play"
        }
      />
      {error && <div className="notice danger" role="alert">{error}</div>}

      {/* The table wears its world. A casino round sits on gold lacquer, a board
          game on cold slate, a card game on plum baize — so Play stops looking
          like the same room with a different title. */}
      <div
        className={`table-shell felt-${feltFor(session.category)}`}
        data-world={worldFor(session.category).label}
        style={worldVars(session.category) as CSSProperties}
      >
        {/* The rail: world, pot and round state, in one line that never wraps
            into the play area. */}
        <div className="table-rail">
          <span className="table-rail-world">{worldFor(session.category).label}</span>
          <span className="table-rail-tagline truncate">{worldFor(session.category).tagline}</span>
          <span className="table-rail-spacer" />
          {session.potMinor > 0 ? (
            <span className="table-rail-pot">Pot {formatMoney(session.potMinor, session.currency)}</span>
          ) : (
            <span className="table-rail-pot muted">Free table</span>
          )}
        </div>

        {/* Seats: the people at the table, always visible, never scrolled away
            behind the board. The active seat is the only one that moves. */}
        <div className="table-seats" aria-label="Players at the table">
          {session.players.map((p) => {
            const turn = session.state?.turnUserId === p.id && session.status === "active";
            return (
              <div key={p.id} className={`seat${turn ? " is-turn" : ""}${p.id === viewerId ? " is-you" : ""}`}>
                <span className="seat-face" aria-hidden>
                  <Avatar name={p.displayName} url={p.avatarUrl} seed={p.id} size="sm" />
                </span>
                <span className="seat-name truncate">{p.id === viewerId ? "You" : p.displayName}</span>
                <span className="seat-meta">
                  {turn ? "Turn" : `#${p.seat + 1}`}
                  {p.stakedMinor > 0 && <em> · {formatMoney(p.stakedMinor, session.currency)}</em>}
                </span>
              </div>
            );
          })}
          {Array.from({ length: Math.max(0, session.maxPlayers - session.players.length) }).slice(0, 3).map((_, i) => (
            <div key={`empty-${i}`} className="seat empty" aria-hidden>
              <span className="seat-face" />
              <span className="seat-name">Open</span>
              <span className="seat-meta">seat</span>
            </div>
          ))}
        </div>

        {/* The felt: one surface, one focus. */}
        <div className="table-surface">
          {session.status === "lobby" && (
            <div className="table-lobby">
              <p className="table-lobby-count">{session.players.length}<span>/{session.maxPlayers}</span></p>
              <p className="meta">
                {session.players.length < session.minPlayers
                  ? `Waiting for ${session.minPlayers - session.players.length} more to start`
                  : "Everyone is here. The host can start."}
              </p>
              <div className="table-lobby-actions">
                {!me && (
                  <button className="btn primary" disabled={busy} onClick={() => void act("/join")}>
                    {session.stakeMinor > 0 ? `Join · ${formatMoney(session.stakeMinor, session.currency)}` : "Join game"}
                  </button>
                )}
                {isHost && (
                  <button className="btn primary" disabled={busy || !canStart} onClick={() => void act("/start")}>
                    {canStart ? "Start game" : `Need ${session.minPlayers} players`}
                  </button>
                )}
                {me && !isHost && <span className="meta">Waiting for the host to start…</span>}
              </div>
            </div>
          )}

          {session.status === "active" && session.state && (
            <GameBoard session={session} state={session.state} busy={busy} act={act} />
          )}

          {session.status === "finished" && session.state && (
            <>
              {session.winnerId && (
                <div className="table-winner">
                  <span className="table-winner-label">Winner</span>
                  <span className="table-winner-name">
                    {session.players.find((p) => p.id === session.winnerId)?.displayName ?? "—"}
                  </span>
                  {session.potMinor > 0 && <span className="table-winner-pot">{formatMoney(session.potMinor, session.currency)}</span>}
                </div>
              )}
              <GameBoard session={session} state={session.state} busy act={act} readOnly />
            </>
          )}
        </div>
      </div>

      {busy && <div className="row" style={{ justifyContent: "center" }}><SpinnerIcon width={18} height={18} /></div>}
    </>
  );
}

/** Dispatch to the right renderer for the shape the engine returned. */
function GameBoard({ session, state, busy, act, readOnly }: {
  session: Session; state: any; busy: boolean; readOnly?: boolean;
  act: (path: string, body?: unknown) => Promise<void>;
}) {
  const id = session.gameId;
  if (id === "whot") return <WhotBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.hand !== undefined || state.yourHand !== undefined) {
    return <CardBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
  }
  if (state.board !== undefined) return <GridBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.positions !== undefined) return <SnakesBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.h !== undefined) return <DotsBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.colors !== undefined) return <SimonBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.options !== undefined && state.options.length > 0) return <OptionBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  return <GenericBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
}

// ---- Whot -----------------------------------------------------------------

function WhotBoard({ state, busy, act, readOnly }: any) {
  const [callShape, setCallShape] = useState<string | null>(null);
  const playable = (card: any) => {
    if (card.shape === "whot") return true;
    if (state.calledShape) return card.shape === state.calledShape;
    const top = state.top;
    return !top || card.shape === top.shape || card.number === top.number;
  };
  return (
    <section className="stack">
      <div className="game-market card">
        <span className="meta">Market {state.marketCount} · {state.calledShape ? `Call: ${SHAPE_NAME[state.calledShape]}` : "Top of the pile"}</span>
        {state.top && <PlayingCard card={state.top} />}
      </div>
      {state.yourTurn && !readOnly ? (
        <>
          <h2 className="section-title">Your hand</h2>
          <div className="hand-grid">
            {state.hand.map((card: any, i: number) => {
              const ok = playable(card);
              return (
                <button key={i} className={`card-button ${ok ? "" : "disabled"}`}
                  disabled={busy || !ok || (card.shape === "whot" && !callShape)}
                  onClick={() => void act("/move", { move: card.shape === "whot" ? { type: "play", card, callShape } : { type: "play", card } })}>
                  <PlayingCard card={card} />
                </button>
              );
            })}
          </div>
          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
            <span className="meta">Call shape for Whot:</span>
            {WHOT_SHAPES.map((s) => (
              <button key={s} className="pill" aria-pressed={callShape === s} onClick={() => setCallShape(s)}>
                <ShapeMark shape={s} size={16} /> {SHAPE_NAME[s]}
              </button>
            ))}
          </div>
          <button className="btn block" disabled={busy} onClick={() => void act("/move", { move: { type: "draw" } })}>Draw a card</button>
        </>
      ) : (
        <div className="notice">{readOnly ? "This game has finished." : "Waiting for the other player…"}</div>
      )}
    </section>
  );
}

function PlayingCard({ card }: { card: any }) {
  const whot = card.shape === "whot";
  return (
    <span className={`playing-card ${whot ? "whot" : card.shape}`}
      aria-label={whot ? "Whot 20" : `${SHAPE_NAME[card.shape]} ${card.number}`}>
      <span className="playing-card-shape" aria-hidden><ShapeMark shape={card.shape} size={26} /></span>
      <span className="playing-card-number">{card.number}</span>
    </span>
  );
}

// ---- Card games (standard deck) -------------------------------------------

function StdCard({ card }: { card: { rank: number; suit: string } }) {
  const red = card.suit === "H" || card.suit === "D";
  return (
    <span className={`playing-card std ${red ? "red" : ""}`} aria-label={`${rankText(card.rank)} of ${SUIT_NAME[card.suit] ?? card.suit}`}>
      <span className="playing-card-shape" aria-hidden><SuitMark suit={card.suit} size={26} /></span>
      <span className="playing-card-number">{rankText(card.rank)}</span>
    </span>
  );
}

function CardBoard({ session, state, busy, act, readOnly }: any) {
  const id = session.gameId;
  const hand: any[] = state.hand ?? state.yourHand ?? [];

  if (id === "blackjack") {
    return (
      <section className="stack">
        <h2 className="section-title">Dealer {state.dealerTotal !== null ? `· ${state.dealerTotal}` : ""}</h2>
        <div className="hand-grid">{state.dealer.map((c: any, i: number) => <StdCard key={i} card={c} />)}</div>
        <h2 className="section-title">You {state.yourTotal !== undefined ? `· ${state.yourTotal}` : ""}</h2>
        <div className="hand-grid">{hand.map((c: any, i: number) => <StdCard key={i} card={c} />)}</div>
        {state.yourTurn && !readOnly ? (
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button className="btn primary grow" disabled={busy} onClick={() => void act("/move", { move: { action: "hit" } })}>Hit</button>
            <button className="btn grow" disabled={busy} onClick={() => void act("/move", { move: { action: "stand" } })}>Stand</button>
          </div>
        ) : !readOnly && <div className="notice">Waiting…</div>}
      </section>
    );
  }

  if (id === "war") {
    return (
      <section className="stack">
        {state.last && (
          <div className="game-market card row" style={{ justifyContent: "center", gap: "var(--space-3)" }}>
            <StdCard card={state.last.a} /><StdCard card={state.last.b} />
          </div>
        )}
        <div className="meta">Your cards: {state.yourCount}</div>
        {state.yourTurn && !readOnly && (
          <button className="btn primary block" disabled={busy} onClick={() => void act("/move", { move: { action: "flip" } })}>Flip a card</button>
        )}
      </section>
    );
  }

  if (id === "crazyeights") {
    return (
      <section className="stack">
        <div className="game-market card">
          <span className="meta">Top card · suit {SUIT_NAME[state.activeSuit] ?? state.activeSuit} · deck {state.deckCount}</span>
          {state.discardTop && <StdCard card={state.discardTop} />}
        </div>
        <h2 className="section-title">Your hand</h2>
        <div className="hand-grid">
          {hand.map((c: any, i: number) => (
            <button key={i} className="card-button" disabled={busy || !state.yourTurn || readOnly}
              onClick={() => void act("/move", { move: { card: c } })}>
              <StdCard card={c} />
            </button>
          ))}
        </div>
        {state.yourTurn && !readOnly && (
          <button className="btn block" disabled={busy} onClick={() => void act("/move", { move: {} })}>Draw</button>
        )}
      </section>
    );
  }

  if (id === "gofish") {
    const ranks = [...new Set(hand.map((c: any) => c.rank))];
    return (
      <section className="stack">
        <h2 className="section-title">Your hand</h2>
        <div className="hand-grid">{hand.map((c: any, i: number) => <StdCard key={i} card={c} />)}</div>
        {state.yourTurn && !readOnly
          ? <GoFishControls ranks={ranks} players={session.players} busy={busy} act={act} />
          : !readOnly && <div className="notice">Waiting…</div>}
      </section>
    );
  }

  if (id === "poker") {
    return (
      <section className="stack">
        <h2 className="section-title">Your hand · {state.yourHandName}</h2>
        <div className="hand-grid">{hand.map((c: any, i: number) => <StdCard key={i} card={c} />)}</div>
        {state.yourTurn && !readOnly && (
          <button className="btn primary block" disabled={busy} onClick={() => void act("/move", { move: { discard: [] } })}>Stand pat</button>
        )}
        {state.showdown && (
          <div className="stack">
            <h2 className="section-title">Showdown</h2>
            {state.showdown.map((s: any) => (
              <div key={s.userId} className="card row spread">
                <span>{session.players.find((p: Player) => p.id === s.userId)?.displayName ?? s.userId}</span>
                <span className="meta">{s.name}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  if (id === "baccarat") {
    return (
      <section className="stack">
        <div className="game-market card">
          <span className="meta">Player {state.playerValue ?? "–"} · Banker {state.bankerValue ?? "–"}</span>
          <div className="hand-grid">{[...state.player, ...state.banker].map((c: any, i: number) => <StdCard key={i} card={c} />)}</div>
        </div>
        {state.yourTurn && !readOnly ? (
          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
            {(["player", "banker", "tie"] as const).map((b) => (
              <button key={b} className="pill" disabled={busy} onClick={() => void act("/move", { move: { bet: b } })}>{b}</button>
            ))}
          </div>
        ) : !readOnly && <div className="notice">Waiting…</div>}
      </section>
    );
  }

  return <GenericBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
}

function GoFishControls({ ranks, players, busy, act }: any) {
  const [rank, setRank] = useState<number | null>(ranks[0] ?? null);
  const [target, setTarget] = useState<string | null>(null);
  return (
    <div className="stack">
      <span className="meta">Ask a player for a rank</span>
      <div className="pill-row">{ranks.map((r: number) => (
        <button key={r} className="pill" aria-pressed={rank === r} onClick={() => setRank(r)}>{rankText(r)}</button>
      ))}</div>
      <div className="pill-row">{(players as Player[]).map((p) => (
        <button key={p.id} className="pill" aria-pressed={target === p.id} onClick={() => setTarget(p.id)}>{p.displayName}</button>
      ))}</div>
      <button className="btn primary block" disabled={busy || rank === null || target === null}
        onClick={() => void act("/move", { move: { targetId: target, rank } })}>Ask</button>
    </div>
  );
}

// ---- Grid games -----------------------------------------------------------

function GridBoard({ session, state, busy, act, readOnly }: any) {
  const id = session.gameId;
  const you = state.yourSeat ?? 0;

  if (id === "checkers" || id === "reversi") {
    const [sel, setSel] = useState<[number, number] | null>(null);
    const cell = (r: number, c: number) => {
      const v = state.board[r][c];
      if (id === "reversi") return v === null ? null : <Piece tone={v === 0 ? "dark" : "light"} />;
      if (v === 0) return null;
      const tone: "light" | "dark" = v === 1 || v === 3 ? "dark" : "light";
      const king = v === 2 || v === 4;
      return <Piece tone={tone} king={king} />;
    };
    return (
      <section className="stack">
        <div className="checker-grid">
          {state.board.map((row: any[], r: number) => row.map((_: any, c: number) => {
            const dark = (r + c) % 2 === 1;
            const selected = sel && sel[0] === r && sel[1] === c;
            return (
              <button key={`${r}-${c}`} className={`checker-cell ${dark ? "dark" : "light"} ${selected ? "sel" : ""}`}
                disabled={busy || readOnly || !state.yourTurn}
                onClick={() => {
                  if (id === "reversi") { void act("/move", { move: { row: r, col: c } }); return; }
                  if (sel) { void act("/move", { move: { from: sel, to: [r, c] } }); setSel(null); }
                  else if (cell(r, c)) setSel([r, c]);
                }}>
                {cell(r, c)}
              </button>
            );
          }))}
        </div>
        {id === "reversi" && <div className="meta">You {state.scores?.[you] ?? 0} · Them {state.scores?.[you === 0 ? 1 : 0] ?? 0}</div>}
        {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
      </section>
    );
  }

  if (id === "battleship") {
    return (
      <section className="stack">
        <h2 className="section-title">Your fleet</h2>
        <div className="battle-grid">
          {Array.from({ length: 100 }).map((_, i) => {
            const r = Math.floor(i / 10); const c = i % 10;
            const ship = state.yourFleet.find((s: any) => s.r === r && s.c === c);
            const shot = state.opponentShots.includes(`${r},${c}`);
            return <span key={i} className={`battle-cell ${ship ? (ship.hit ? "hit" : "ship") : ""} ${shot ? "incoming" : ""}`} />;
          })}
        </div>
        <h2 className="section-title">Your shots</h2>
        <div className="battle-grid">
          {Array.from({ length: 100 }).map((_, i) => {
            const r = Math.floor(i / 10); const c = i % 10;
            const hit = state.opponentHitCells.find((s: any) => s.r === r && s.c === c);
            return (
              <button key={i} className={`battle-cell ${hit ? (hit.hit ? "hit" : "miss") : ""}`}
                disabled={busy || readOnly || !state.yourTurn}
                onClick={() => void act("/move", { move: { r, c } })} />
            );
          })}
        </div>
      </section>
    );
  }

  // tictactoe / connect4 / gomoku — all "row/col", gravity handled server-side.
  const gravity = id === "connect4";
  return (
    <section className="stack">
      <div className={`line-grid cols-${state.cols ?? 3} rows-${state.rows ?? 3} ${gravity ? "gravity" : ""}`}>
        {state.board.map((row: any[], r: number) => row.map((v: any, c: number) => (
          <button key={`${r}-${c}`} className="line-cell"
            disabled={busy || readOnly || !state.yourTurn || (gravity ? state.board[0][c] !== null : v !== null)}
            onClick={() => void act("/move", { move: gravity ? { col: c } : { row: r, col: c } })}>
            {v === null ? null : <Piece tone={v === you ? "dark" : "light"} />}
          </button>
        )))}
      </div>
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </section>
  );
}

// ---- Snakes ---------------------------------------------------------------

function SnakesBoard({ session, state, busy, act, readOnly }: any) {
  return (
    <section className="stack">
      {state.lastRoll && <div className="meta">Last roll: {state.lastRoll}</div>}
      <div className="stack">
        {Object.entries(state.positions as Record<string, number>).map(([pid, pos]) => (
          <div key={pid} className="card row spread">
            <span>{session.players.find((p: Player) => p.id === pid)?.displayName ?? pid.slice(0, 8)}</span>
            <span className="meta">square {pos}</span>
          </div>
        ))}
      </div>
      {state.yourTurn && !readOnly && (
        <button className="btn primary block" disabled={busy} onClick={() => void act("/move", { move: { action: "roll" } })}>Roll the dice</button>
      )}
    </section>
  );
}

// ---- Dots and Boxes -------------------------------------------------------

function DotsBoard({ state, busy, act, readOnly }: any) {
  const n = state.h.length;
  return (
    <section className="stack">
      <div className="dots-grid" style={{ gridTemplateColumns: `repeat(${2 * n - 1}, 18px)` }}>
        {Array.from({ length: 2 * n - 1 }).map((_, r) => Array.from({ length: 2 * n - 1 }).map((__, c) => {
          const evenR = r % 2 === 0; const evenC = c % 2 === 0;
          if (evenR && evenC) return <span key={`${r}-${c}`} className="dot" />;
          if (evenR && !evenC) {
            const ci = (c - 1) / 2; const owner = state.h[r / 2]?.[ci];
            return <button key={`${r}-${c}`} className={`edge ${owner ? "taken" : ""}`} disabled={busy || readOnly || !state.yourTurn || owner !== 0}
              onClick={() => void act("/move", { move: { kind: "h", r: r / 2, c: ci } })} />;
          }
          if (!evenR && evenC) {
            const ri = (r - 1) / 2; const owner = state.v[ri]?.[c / 2];
            return <button key={`${r}-${c}`} className={`edge ${owner ? "taken" : ""}`} disabled={busy || readOnly || !state.yourTurn || owner !== 0}
              onClick={() => void act("/move", { move: { kind: "v", r: ri, c: c / 2 } })} />;
          }
          const boxOwner = state.boxOwner[(r - 1) / 2]?.[(c - 1) / 2];
          return <span key={`${r}-${c}`} className={`box ${boxOwner >= 0 ? "owned" : ""}`}>{boxOwner >= 0 ? <Piece tone={boxOwner === 0 ? "dark" : "light"} /> : null}</span>;
        }))}
      </div>
      <div className="meta">You {state.scores?.[0]} · Them {state.scores?.[1]}</div>
    </section>
  );
}

// ---- Option / quiz games --------------------------------------------------

function OptionBoard({ state, busy, act, readOnly }: any) {
  return (
    <section className="stack">
      {(state.prompt || state.question) && <h2 className="section-title">{state.prompt ?? state.question}</h2>}
      <div className="stack">
        {state.options.map((opt: string, i: number) => (
          <button key={i} className="btn block" disabled={busy || readOnly || !state.yourTurn}
            onClick={() => void act("/move", { move: { choice: i, side: i } })}>{opt}</button>
        ))}
      </div>
      {state.masked && <div className="game-market card"><span className="playing-card-number" style={{ fontSize: 24 }}>{state.masked}</span></div>}
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </section>
  );
}

// ---- Simon ----------------------------------------------------------------

function SimonBoard({ state, busy, act, readOnly }: any) {
  const [seq, setSeq] = useState<string[]>([]);
  const colors = state.colors as string[];
  const palette: Record<string, string> = { red: "#ef4444", green: "#22c55e", blue: "#3b82f6", yellow: "#eab308" };
  return (
    <section className="stack">
      <div className="meta">Watch: {state.sequence.join(" → ")}</div>
      <div className="row" style={{ gap: "var(--space-2)" }}>
        {colors.map((c) => (
          <button key={c} className="btn grow" style={{ background: palette[c], color: "#fff" }}
            disabled={busy || readOnly || !state.yourTurn}
            onClick={() => setSeq((s) => [...s, c])}>{c}</button>
        ))}
      </div>
      <div className="meta">Your guess: {seq.join(" → ") || "—"}</div>
      <button className="btn primary block" disabled={busy || readOnly || !state.yourTurn || seq.length === 0}
        onClick={() => { void act("/move", { move: { sequence: seq } }); setSeq([]); }}>Submit</button>
    </section>
  );
}

// ---- Fallback for score-style games --------------------------------------

function GenericBoard({ session, state, busy, act, readOnly }: any) {
  const id = session.gameId;
  const actFor: Record<string, unknown> = {
    dice: { action: "roll" },
    slots: { action: "spin" },
    plinko: { action: "drop" },
    penalty: { corner: 0 },
    crash: { cashout: 1.5 },
    reaction: { value: state.target ?? 50 },
    rps: { choice: "rock" },
    truthdare: { pick: "truth" },
    roulette: { bet: { kind: "red" } },
    charades: { choice: 0 },
    "20q": { choice: 0 },
    wyr: { side: 0 },
    neverhave: { side: 0 },
    hangman: { letter: "A" },
    wordchain: { word: "apple" },
    wordscramble: { guess: "" },
    memory: { index: 0 },
  };
  const move = actFor[id];
  return (
    <section className="stack">
      {state.scores && (
        <div className="stack">
          {session.players.map((p: Player) => (
            <div key={p.id} className="card row spread">
              <span>{p.displayName}</span><span className="meta">{state.scores[p.id] ?? 0}</span>
            </div>
          ))}
        </div>
      )}
      {state.last && <div className="meta">{state.last}</div>}
      {state.masked && <div className="meta">{state.masked}</div>}
      {state.scrambled && <div className="meta">{state.scrambled}</div>}
      {state.revealedCrash && <div className="meta">Crash point: {state.revealedCrash}x</div>}
      {state.yourTurn && !readOnly && move !== undefined && (
        <button className="btn primary block" disabled={busy} onClick={() => void act("/move", { move })}>
          {id === "dice" ? "Roll" : id === "slots" ? "Spin" : id === "plinko" ? "Drop" : "Play"}
        </button>
      )}
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </section>
  );
}
