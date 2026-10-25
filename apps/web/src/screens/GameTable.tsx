import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, ApiError } from "../api";
import { ScreenHeader } from "../components/ScreenHeader";
import { Avatar } from "../components/Avatar";
import { formatMoney } from "../money";
import { SpinnerIcon, ArrowLeftIcon } from "../components/Icons";
import { CourtFigure, ShapeMark, SuitMark, WHOT_SHAPES, SHAPE_NAME } from "../components/CardFaces";
import { useActivityTheme } from "../components/useActivityTheme";
import { themeForGame } from "../themes";
import { feltFor, worldFor, worldVars } from "../components/GameArt";
// Split out with this lazy chunk rather than shipped in the launch bundle.
import "../game-table.css";
import "../game-boards.css";

/**
 * A game table.
 *
 * One screen plays every game. The server decides the rules and sends back a
 * per-viewer state; this component only knows how to draw the families of state
 * the engines produce (a grid, a hand of cards, a board of discs, a set of
 * options). It never decides who won — it renders what the server said.
 *
 * The boards are drawn as the objects they are: a card with pips, a beveled
 * checker, a stone on a wooden grid, a disc in a plastic frame. Real UIs for
 * real games, not labelled boxes — see `game-boards.css` for the materials.
 */

interface Player {
  id: string; displayName: string; handle: string; avatarUrl: string | null;
  seat: number; status: string; stakedMinor: number;
  /** A house seat: labelled so a person knows who they are playing. */
  isBot?: boolean;
}
interface Session {
  id: string; gameId: string; gameName: string; category: string; status: string;
  stakeMinor: number; potMinor: number; currency: string; hostId: string;
  minPlayers: number; maxPlayers: number; players: Player[]; state: any;
  winnerId: string | null;
}

const SUIT_NAME: Record<string, string> = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const RANK_LABEL: Record<number, string> = { 1: "A", 11: "J", 12: "Q", 13: "K" };
const COLUMN_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

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

  // A table already filled to its minimum with the house is not waiting for
  // anyone, so it should not sit in a lobby showing a start button. Declared
  // before the loading return because hooks may not follow an early exit.
  const houseTable = Boolean(session?.players.some((p) => p.isBot))
    && (session?.players.length ?? 0) >= (session?.minPlayers ?? 2);
  const houseLobby = Boolean(session)
    && session!.hostId === viewerId
    && session!.status === "lobby"
    && houseTable;
  useEffect(() => {
    if (!houseLobby) return;
    void act("/start");
    // The status guard means this runs once: starting flips status to active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [houseLobby]);

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
  const turnUserId = session.state?.turnUserId as string | undefined;

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
          {inPlay && turnUserId && (
            <span className="table-rail-turn">
              {turnUserId === viewerId ? "Your move" : `${session.players.find((p) => p.id === turnUserId)?.displayName ?? "Their"} move`}
            </span>
          )}
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
            const turn = turnUserId === p.id && session.status === "active";
            return (
              <div key={p.id} className={`seat${turn ? " is-turn" : ""}${p.id === viewerId ? " is-you" : ""}${p.isBot ? " is-bot" : ""}`}>
                <span className="seat-face" aria-hidden>
                  <Avatar name={p.displayName} url={p.avatarUrl} seed={p.id} size="sm" />
                </span>
                <span className="seat-name truncate">{p.id === viewerId ? "You" : p.displayName}</span>
                <span className="seat-meta">
                  {turn ? "Turn" : `#${p.seat + 1}`}
                  {p.isBot && <em> · House</em>}
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
  // Battleship's view has no `board` — it sends fleets and shots — so it must be
  // dispatched before the fallback, or it renders as a score list.
  if (state.board !== undefined || state.yourFleet !== undefined) {
    return <GridBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
  }
  if (state.positions !== undefined) return <SnakesBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.h !== undefined) return <DotsBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.colors !== undefined) return <SimonBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (state.options !== undefined && state.options.length > 0) return <OptionBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  return <GenericBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
}

// ---- Cards ----------------------------------------------------------------

/** Where each pip sits on a real card, as a percentage of the face. */
const PIP_LAYOUT: Record<number, Array<[number, number]>> = {
  2: [[50, 20], [50, 80]],
  3: [[50, 20], [50, 50], [50, 80]],
  4: [[26, 20], [74, 20], [26, 80], [74, 80]],
  5: [[26, 20], [74, 20], [50, 50], [26, 80], [74, 80]],
  6: [[26, 20], [74, 20], [26, 50], [74, 50], [26, 80], [74, 80]],
  7: [[26, 20], [74, 20], [50, 33], [26, 50], [74, 50], [26, 80], [74, 80]],
  8: [[26, 20], [74, 20], [50, 33], [26, 50], [74, 50], [50, 67], [26, 80], [74, 80]],
  9: [[26, 17], [74, 17], [26, 40], [74, 40], [50, 50], [26, 60], [74, 60], [26, 83], [74, 83]],
  10: [[26, 17], [74, 17], [50, 28], [26, 40], [74, 40], [26, 60], [74, 60], [50, 72], [26, 83], [74, 83]],
};

function StdCard({ card, hidden = false }: { card: { rank: number; suit: string } | null; hidden?: boolean }) {
  if (hidden || !card) return <span className="pcard back" aria-label="Face-down card" />;
  const red = card.suit === "H" || card.suit === "D";
  const label = `${rankText(card.rank)} of ${SUIT_NAME[card.suit] ?? card.suit}`;
  const court = card.rank >= 11 && card.rank <= 13;

  return (
    <span className={`pcard${red ? " red" : ""}`} aria-label={label} role="img">
      <span className="pcard-corner">
        <span>{rankText(card.rank)}</span>
        <SuitMark suit={card.suit} size={9} />
      </span>
      <span className="pcard-corner bottom">
        <span>{rankText(card.rank)}</span>
        <SuitMark suit={card.suit} size={9} />
      </span>
      <span className="pcard-face">
        {card.rank === 1 ? (
          <span className="pcard-pip" style={{ left: "50%", top: "50%" }}>
            <SuitMark suit={card.suit} size={26} />
          </span>
        ) : court ? (
          <span className="pcard-court">
            <span className="pcard-court-ink">
              <CourtFigure rank={card.rank} suit={card.suit} />
            </span>
          </span>
        ) : (
          (PIP_LAYOUT[card.rank] ?? []).map(([x, y], i) => (
            <span
              key={i}
              className={`pcard-pip${y > 50 ? " flip" : ""}`}
              style={{ left: `${x}%`, top: `${y}%` }}
            >
              <SuitMark suit={card.suit} size={13} />
            </span>
          ))
        )}
      </span>
    </span>
  );
}

function Hand({ cards, onPick, busy, disabled }: {
  cards: Array<{ rank: number; suit: string }>;
  onPick?: (card: { rank: number; suit: string }) => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  if (cards.length === 0) return <p className="meta">No cards in hand.</p>;
  return (
    <div className="gb-hand">
      {cards.map((c, i) => onPick ? (
        <button type="button" key={i} className={`card-button${disabled ? " disabled" : ""}`} disabled={busy || disabled}
          onClick={() => onPick(c)} aria-label={`Play ${rankText(c.rank)} of ${SUIT_NAME[c.suit] ?? c.suit}`}>
          <StdCard card={c} />
        </button>
      ) : <StdCard key={i} card={c} />)}
    </div>
  );
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
        <div className="gb-pile">{state.top && <PlayingCard card={state.top} />}</div>
      </div>
      {state.yourTurn && !readOnly ? (
        <>
          <h2 className="section-title">Your hand</h2>
          <div className="gb-hand">
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
  const shapeClass = whot ? "shape-whot" : `shape-${card.shape}`;
  return (
    <span className={`pcard whot-card ${shapeClass}`}
      role="img" aria-label={whot ? "Whot 20" : `${SHAPE_NAME[card.shape]} ${card.number}`}>
      <span className="pcard-corner"><span>{card.number}</span></span>
      <span className="pcard-corner bottom"><span>{card.number}</span></span>
      <span className="pcard-face">
        <span className="pcard-pip" style={{ left: "50%", top: "50%" }}>
          <ShapeMark shape={card.shape} size={30} />
        </span>
      </span>
    </span>
  );
}

// ---- Card games (standard deck) -------------------------------------------

function CardBoard({ session, state, busy, act, readOnly }: any) {
  const id = session.gameId;
  const hand: any[] = state.hand ?? state.yourHand ?? [];
  const turn = state.yourTurn && !readOnly;

  if (id === "blackjack") {
    return (
      <section className="stack">
        <h2 className="section-title">Dealer {state.dealerTotal !== null ? `· ${state.dealerTotal}` : ""}</h2>
        <Hand cards={state.dealer} />
        <h2 className="section-title">You {state.yourTotal !== undefined ? `· ${state.yourTotal}` : ""}</h2>
        <Hand cards={hand} />
        {turn ? (
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
        <div className="gb-deck">
          <span>You hold <strong>{state.yourCount}</strong> cards</span>
        </div>
        {state.last && (
          <div className="game-market card row" style={{ justifyContent: "center", gap: "var(--space-4)" }}>
            <div className="gb-dice">
              <StdCard card={state.last.a} />
              <span className="meta">vs</span>
              <StdCard card={state.last.b} />
            </div>
          </div>
        )}
        {turn && (
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
          <div className="gb-pile">{state.discardTop && <StdCard card={state.discardTop} />}</div>
        </div>
        <h2 className="section-title">Your hand</h2>
        <Hand cards={hand} busy={busy} disabled={!turn}
          onPick={(card) => void act("/move", { move: { card } })} />
        {turn && (
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
        <Hand cards={hand} />
        {turn
          ? <GoFishControls ranks={ranks} players={session.players} busy={busy} act={act} />
          : !readOnly && <div className="notice">Waiting…</div>}
      </section>
    );
  }

  if (id === "poker") {
    return (
      <section className="stack">
        <h2 className="section-title">Your hand · {state.yourHandName}</h2>
        <Hand cards={hand} />
        {turn && (
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
          <div className="gb-dice">
            {state.player.map((c: any, i: number) => <StdCard key={`p${i}`} card={c} />)}
            <span className="meta">|</span>
            {state.banker.map((c: any, i: number) => <StdCard key={`b${i}`} card={c} />)}
          </div>
        </div>
        {turn ? (
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

  if (id === "checkers" || id === "reversi") return <DiscBoard id={id} session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (id === "battleship") return <BattleshipBoard state={state} busy={busy} act={act} readOnly={readOnly} />;
  if (id === "connect4") return <ConnectFourBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
  return <LineBoard session={session} state={state} busy={busy} act={act} readOnly={readOnly} />;
}

function DiscBoard({ id, session, state, busy, act, readOnly }: any) {
  const [sel, setSel] = useState<[number, number] | null>(null);
  const you = state.yourSeat ?? 0;
  const last = state.last;
  const isLast = (r: number, c: number) => last && (
    (last.from && last.from[0] === r && last.from[1] === c) ||
    (last.to && last.to[0] === r && last.to[1] === c) ||
    (last.row === r && last.col === c)
  );

  const cell = (r: number, c: number) => {
    const v = state.board[r][c];
    if (id === "reversi") {
      if (v === null) return null;
      return <span className={`gb-disc reversi ${v === 0 ? "dark" : "light"}`} />;
    }
    if (v === 0) return null;
    const tone: "light" | "dark" = v === 1 || v === 3 ? "dark" : "light";
    return <span className={`gb-disc ${tone}`}>{v === 2 || v === 4 ? <span className="gb-crown">{CrownMark}</span> : null}</span>;
  };

  const scores = id === "reversi" ? state.scores ?? [0, 0] : null;
  // Checkers has no score in the view, so count the men on the board. That is
  // the number a checkers player actually watches.
  const men = [0, 0];
  if (id === "checkers") {
    for (const row of state.board) for (const v of row) {
      if (v === 1 || v === 2) men[0] = (men[0] ?? 0) + 1;
      if (v === 3 || v === 4) men[1] = (men[1] ?? 0) + 1;
    }
  }

  return (
    <div className="gb-checkers">
      <div className="gb-checker-grid" role="grid" aria-label={id === "reversi" ? "Reversi board" : "Checkers board"}>
        {state.board.map((row: any[], r: number) => row.map((_: any, c: number) => {
          const dark = (r + c) % 2 === 1;
          const selected = sel && sel[0] === r && sel[1] === c;
          return (
            <button key={`${r}-${c}`}
              className={`gb-sq ${dark ? "dark" : "light"}${selected ? " sel" : ""}${isLast(r, c) ? " last" : ""}`}
              aria-label={`${dark ? "dark" : "light"} square row ${r + 1} column ${c + 1}`}
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
      <div className="gb-checker-score">
        {scores ? (
          <>
            <span>You <b>{scores[you] ?? 0}</b></span>
            <span>·</span>
            <span>Them <b>{scores[you === 0 ? 1 : 0] ?? 0}</b></span>
          </>
        ) : (
          <>
            <span>You <b>{men[you] ?? 0}</b> men</span>
            <span>·</span>
            <span>Them <b>{men[you === 0 ? 1 : 0] ?? 0}</b></span>
          </>
        )}
        {state.yourTurn && !readOnly && <span className="gb-turn"><span className="live-dot" />Your move</span>}
      </div>
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </div>
  );
}

const CrownMark = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 8l4 3 5-7 5 7 4-3-2 11H5z" />
  </svg>
);

function ConnectFourBoard({ session, state, busy, act, readOnly }: any) {
  const you = state.yourSeat ?? 0;
  const cols = state.cols ?? 7;
  const rows = state.rows ?? 6;

  return (
    <div className="gb-board">
      <div className="gb-c4">
        <div className="gb-c4-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array.from({ length: cols }).map((_, c) => {
            const full = state.board[0][c] !== null;
            return (
              <button key={c} className={`gb-c4-col ${you === 1 ? "you-2" : ""}`}
                aria-label={`Drop in column ${c + 1}`}
                disabled={busy || readOnly || !state.yourTurn || full}
                onClick={() => void act("/move", { move: { col: c } })}>
                {Array.from({ length: rows }).map((__, r) => {
                  const v = state.board[r][c];
                  const isLast = state.last && state.last.row === r && state.last.col === c;
                  return (
                    <span key={r} className={`gb-c4-hole${isLast ? " last" : ""}`}>
                      {v === null
                        ? r === rows - 1 && <span className="gb-c4-ghost" aria-hidden />
                        : <span className={`gb-c4-disc p${v + 1}`} />}
                    </span>
                  );
                })}
              </button>
            );
          })}
        </div>
      </div>
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </div>
  );
}

function LineBoard({ session, state, busy, act, readOnly }: any) {
  const id = session.gameId;
  const you = state.yourSeat ?? 0;
  const cols = state.cols ?? 3;
  const size = cols === 15 ? "gomoku" : "ttt";

  return (
    <div className="gb-board">
      <div className="gb-line-frame">
        <div className={`gb-line-grid ${size}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} role="grid" aria-label={`${session.gameName} board`}>
          {state.board.map((row: any[], r: number) => row.map((v: any, c: number) => {
            const last = state.last && state.last.row === r && state.last.col === c;
            return (
              <button key={`${r}-${c}`} className={`gb-line-cell${last ? " last" : ""}`}
                aria-label={`Row ${r + 1}, column ${c + 1}`}
                disabled={busy || readOnly || !state.yourTurn || v !== null}
                onClick={() => void act("/move", { move: { row: r, col: c } })}>
                {v === null
                  ? <span className="gb-stone ghost" />
                  : <span className={`gb-stone ${v === you ? "dark" : "light"}`} />}
              </button>
            );
          }))}
        </div>
      </div>
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </div>
  );
}

function BattleshipBoard({ state, busy, act, readOnly }: any) {
  const incoming = new Set<string>(state.opponentShots ?? []);
  const fired = new Map<string, boolean>();
  for (const s of state.opponentHitCells ?? []) fired.set(`${s.r},${s.c}`, Boolean(s.hit));
  const fleet = new Map<string, boolean>();
  for (const s of state.yourFleet ?? []) fleet.set(`${s.r},${s.c}`, Boolean(s.hit));

  const coords = COLUMN_LETTERS.slice(0, 10);

  return (
    <div className="gb-bb">
      <div className="gb-bb-board">
        <div className="gb-bb-title">Your fleet <span>{fleet.size} hits taken</span></div>
        <div className="gb-bb-coords" aria-hidden="true">{coords.map((c) => <span key={c}>{c}</span>)}</div>
        <div className="gb-bb-body">
          <div className="gb-bb-rows" aria-hidden="true">{Array.from({ length: 10 }).map((_, i) => <span key={i}>{i + 1}</span>)}</div>
          <div className="gb-bb-grid" role="grid" aria-label="Your fleet">
            {Array.from({ length: 100 }).map((_, i) => {
              const r = Math.floor(i / 10); const c = i % 10;
              const key = `${r},${c}`;
              const ship = fleet.has(key);
              const hit = fleet.get(key);
              const shot = incoming.has(key);
              return (
                <span key={i}
                  className={`gb-bb-cell own${ship ? " ship" : ""}${shot && ship ? " hit" : ""}${shot && !ship ? " miss" : ""}${hit ? " hit" : ""}`}
                  aria-label={`${coords[c]}${r + 1}${ship ? " ship" : ""}${shot ? " hit" : ""}`} />
              );
            })}
          </div>
        </div>
      </div>

      <div className="gb-bb-board">
        <div className="gb-bb-title">Your shots <span>tap a cell to fire</span></div>
        <div className="gb-bb-coords" aria-hidden="true">{coords.map((c) => <span key={c}>{c}</span>)}</div>
        <div className="gb-bb-body">
          <div className="gb-bb-rows" aria-hidden="true">{Array.from({ length: 10 }).map((_, i) => <span key={i}>{i + 1}</span>)}</div>
          <div className="gb-bb-grid" role="grid" aria-label="Your shots">
            {Array.from({ length: 100 }).map((_, i) => {
              const r = Math.floor(i / 10); const c = i % 10;
              const key = `${r},${c}`;
              const known = fired.has(key);
              const hit = fired.get(key);
              return (
                <button key={i}
                  className={`gb-bb-cell${known ? (hit ? " hit" : " miss") : ""}`}
                  aria-label={`${coords[c]}${r + 1}${known ? (hit ? " hit" : " miss") : " unexplored"}`}
                  disabled={busy || readOnly || !state.yourTurn || known}
                  onClick={() => void act("/move", { move: { r, c } })} />
              );
            })}
          </div>
        </div>
      </div>
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </div>
  );
}

// ---- Snakes ---------------------------------------------------------------

/**
 * Where a numbered square sits on the boustrophedon board, as percentages, so
 * the ladder and snake overlay can be drawn over the real cells.
 */
function squarePoint(num: number): { x: number; y: number } {
  const band = Math.floor((num - 1) / 10);
  const offset = num - band * 10;
  const col = band % 2 === 0 ? offset - 1 : 10 - offset;
  return { x: (col + 0.5) * 10, y: (9 - band + 0.5) * 10 };
}

function SnakesBoard({ state, busy, act, readOnly }: any) {
  const players = Object.keys(state.positions ?? {});
  const ladders: Record<string, number> = state.ladders ?? {};
  const snakes: Record<string, number> = state.snakes ?? {};

  return (
    <div className="gb-snake">
      {state.lastRoll && (
        <div className="gb-dice">
          <Die value={state.lastRoll} />
          <span className="meta">last roll</span>
        </div>
      )}
      <div className="gb-snake-grid" aria-label="Snakes and ladders board">
        {Array.from({ length: 10 }).map((_, r) => (
          <div key={r} style={{ display: "contents" }}>
            {Array.from({ length: 10 }).map((__, c) => {
              const bottom = 9 - r;
              const num = bottom % 2 === 0 ? bottom * 10 + c + 1 : bottom * 10 + (10 - c);
              const here = players.filter((p) => state.positions[p] === num);
              return (
                <div key={c}
                  className={`gb-snake-cell${(bottom + c) % 2 === 1 ? " alt" : ""}${ladders[num] ? " start" : ""}${snakes[num] ? " end" : ""}`}>
                  <span>{num}</span>
                  {here.length > 0 && (
                    <span className="gb-snake-tokens">
                      {here.map((p) => (
                        <span key={p} className={`gb-snake-token t${(players.indexOf(p) % 4) + 1}`}>
                          {players.indexOf(p) + 1}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {/* The ladders and snakes themselves, drawn over the numbered squares so
            the board reads as the game rather than as a colour legend. */}
        <svg className="gb-snake-ways" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {Object.entries(ladders).map(([from, to]) => {
            const a = squarePoint(Number(from));
            const b = squarePoint(to);
            return <Ladder key={`l${from}`} from={a} to={b} />;
          })}
          {Object.entries(snakes).map(([from, to]) => {
            const a = squarePoint(Number(from));
            const b = squarePoint(to);
            return <Snake key={`s${from}`} from={a} to={b} />;
          })}
        </svg>
      </div>
      <div className="gb-board-note">
        <span><i className="gb-key ladder" aria-hidden /> ladder climbs · <i className="gb-key snake" aria-hidden /> snake slides</span>
        {state.yourTurn && !readOnly && <span className="gb-turn"><span className="live-dot" />Your move</span>}
      </div>
      {state.yourTurn && !readOnly && (
        <button className="btn primary block" disabled={busy} onClick={() => void act("/move", { move: { action: "roll" } })}>Roll the dice</button>
      )}
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </div>
  );
}

/** Two rails and their rungs, between two square centres. */
function Ladder({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular, at a fixed half-width in board units.
  const px = (-dy / len) * 1.5;
  const py = (dx / len) * 1.5;
  const rungs = Math.max(2, Math.round(len / 5));
  return (
    <g className="gb-ladder">
      <line x1={from.x + px} y1={from.y + py} x2={to.x + px} y2={to.y + py} />
      <line x1={from.x - px} y1={from.y - py} x2={to.x - px} y2={to.y - py} />
      {Array.from({ length: rungs - 1 }).map((_, i) => {
        const t = (i + 1) / rungs;
        const cx = from.x + dx * t;
        const cy = from.y + dy * t;
        return <line key={i} x1={cx + px} y1={cy + py} x2={cx - px} y2={cy - py} className="rung" />;
      })}
    </g>
  );
}

/**
 * A snake: a tapered body between two square centres, with a head at the top.
 *
 * A single stroked line reads as a red mark, not as a snake. This traces the
 * body as a filled outline whose width falls from the head to the tail, bands
 * it in two tones, and puts a head on the end with eyes and a forked tongue
 * pointing down the board. All of it is plain SVG in board units, so it scales
 * with the square without a texture.
 */
function Snake({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  // `from` is the square you land on and `to` is where it drops you, so the head
  // belongs on `from` — a player lands on a head and slides down to a tail. The
  // curve is drawn tail-first so the body can taper along it.
  const tail = to;
  const head = from;
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bend = Math.min(6.5, len * 0.14);
  const c1 = { x: tail.x + dx * 0.3 + nx * bend, y: tail.y + dy * 0.3 + ny * bend };
  const c2 = { x: tail.x + dx * 0.7 - nx * bend, y: tail.y + dy * 0.7 - ny * bend };

  // Sample the curve so the body can have a real taper rather than a stroke.
  const STEPS = 18;
  const spine: Array<{ x: number; y: number; t: number }> = [];
  for (let i = 0; i <= STEPS; i += 1) {
    const t = i / STEPS;
    const u = 1 - t;
    spine.push({
      x: u * u * u * tail.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * head.x,
      y: u * u * u * tail.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * head.y,
      t,
    });
  }
  const radius = (t: number) => 0.35 + 1.3 * Math.pow(t, 0.7);
  const left: string[] = [];
  const right: string[] = [];
  spine.forEach((p, i) => {
    const prev = spine[Math.max(0, i - 1)]!;
    const next = spine[Math.min(STEPS, i + 1)]!;
    const sx = next.x - prev.x;
    const sy = next.y - prev.y;
    const sl = Math.hypot(sx, sy) || 1;
    const r = radius(p.t);
    const ox = (-sy / sl) * r;
    const oy = (sx / sl) * r;
    left.push(`${(p.x + ox).toFixed(2)} ${(p.y + oy).toFixed(2)}`);
    right.push(`${(p.x - ox).toFixed(2)} ${(p.y - oy).toFixed(2)}`);
  });
  const outline = `M${left.join("L")}L${right.reverse().join("L")}Z`;

  // Scale bands: a chevron across the body at intervals, in a second tone.
  const bands = spine.filter((_, i) => i % 3 === 0 && i > 2 && i < STEPS - 2);

  // The head is an ellipse turned to face where the body is going, with the
  // tongue leaving it in the same direction. Everything inside that group is in
  // head-local units (the head sits at the origin facing +x), so the tongue does
  // not have to be re-projected through the rotation.
  const tip = spine[STEPS]!;
  const before = spine[STEPS - 3] ?? spine[0]!;
  const angle = (Math.atan2(tip.y - before.y, tip.x - before.x) * 180) / Math.PI;
  const rad = (angle * Math.PI) / 180;
  const ex = Math.cos(rad + Math.PI / 2) * 0.72;
  const ey = Math.sin(rad + Math.PI / 2) * 0.72;

  return (
    <g className="gb-snake-way">
      <path d={outline} className="body" />
      {bands.map((p, i) => {
        const prev = spine[Math.max(0, spine.indexOf(p) - 1)]!;
        const next = spine[Math.min(STEPS, spine.indexOf(p) + 1)]!;
        const sx = next.x - prev.x;
        const sy = next.y - prev.y;
        const sl = Math.hypot(sx, sy) || 1;
        const r = radius(p.t) * 0.92;
        const ox = (-sy / sl) * r;
        const oy = (sx / sl) * r;
        return (
          <line key={i} className="band"
            x1={(p.x + ox).toFixed(2)} y1={(p.y + oy).toFixed(2)}
            x2={(p.x - ox).toFixed(2)} y2={(p.y - oy).toFixed(2)} />
        );
      })}
      <g transform={`translate(${tip.x.toFixed(2)} ${tip.y.toFixed(2)}) rotate(${angle.toFixed(1)})`}>
        <ellipse className="head" cx="0.2" cy="0" rx="2.2" ry="1.7" />
        <line className="tongue" x1="2.3" y1="0" x2="4.1" y2="0" />
        <line className="tongue" x1="4.1" y1="0" x2="5.2" y2="-0.85" />
        <line className="tongue" x1="4.1" y1="0" x2="5.2" y2="0.85" />
      </g>
      <circle className="eye" cx={(tip.x + ex).toFixed(2)} cy={(tip.y + ey).toFixed(2)} r="0.42" />
      <circle className="eye" cx={(tip.x - ex).toFixed(2)} cy={(tip.y - ey).toFixed(2)} r="0.42" />
    </g>
  );
}

// ---- Dots and Boxes -------------------------------------------------------

function DotsBoard({ state, busy, act, readOnly }: any) {
  const n = state.h.length;
  const rows = 2 * n - 1;
  return (
    <div className="gb-board">
      <div className="gb-dots">
        <div className="gb-dots-grid" style={{
          gridTemplateColumns: `repeat(${rows}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}>
          {Array.from({ length: rows }).map((_, r) => Array.from({ length: rows }).map((__, c) => {
            const evenR = r % 2 === 0; const evenC = c % 2 === 0;
            if (evenR && evenC) return <span key={`${r}-${c}`} className="gb-dot" />;
            if (evenR && !evenC) {
              const ci = (c - 1) / 2; const owner = state.h[r / 2]?.[ci];
              return (
                <button key={`${r}-${c}`} className={`gb-edge${owner ? ` taken${owner === 2 ? " t2" : ""}` : ""}`}
                  aria-label={`Horizontal line row ${r / 2 + 1} column ${ci + 1}`}
                  disabled={busy || readOnly || !state.yourTurn || owner !== 0}
                  onClick={() => void act("/move", { move: { kind: "h", r: r / 2, c: ci } })} />
              );
            }
            if (!evenR && evenC) {
              const ri = (r - 1) / 2; const owner = state.v[ri]?.[c / 2];
              return (
                <button key={`${r}-${c}`} className={`gb-edge v${owner ? ` taken${owner === 2 ? " t2" : ""}` : ""}`}
                  aria-label={`Vertical line row ${ri + 1} column ${c / 2 + 1}`}
                  disabled={busy || readOnly || !state.yourTurn || owner !== 0}
                  onClick={() => void act("/move", { move: { kind: "v", r: ri, c: c / 2 } })} />
              );
            }
            const owner = state.boxOwner[(r - 1) / 2]?.[(c - 1) / 2];
            return (
              <span key={`${r}-${c}`} className={`gb-box${owner >= 0 ? ` owned-${owner + 1}` : ""}`}>
                {owner >= 0 ? <span className="gb-initial">{owner === 0 ? "1" : "2"}</span> : null}
              </span>
            );
          }))}
        </div>
      </div>
      <div className="gb-checker-score">
        <span>You <b>{state.scores?.[0] ?? 0}</b></span>
        <span>·</span>
        <span>Them <b>{state.scores?.[1] ?? 0}</b></span>
        {state.yourTurn && !readOnly && <span className="gb-turn"><span className="live-dot" />Your move</span>}
      </div>
      {!state.yourTurn && !readOnly && <div className="notice">Waiting…</div>}
    </div>
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

// ---- Dice -----------------------------------------------------------------

const PIPS_FOR: Record<number, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[26, 26], [50, 50], [74, 74]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
};

function Die({ value }: { value: number }) {
  return (
    <span className="gb-die" role="img" aria-label={`Die showing ${value}`}>
      {(PIPS_FOR[value] ?? PIPS_FOR[1] ?? []).map(([x, y], i) => (
        <span key={i} className="gb-pip" style={{ left: `${x}%`, top: `${y}%` }} />
      ))}
    </span>
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
  // Dice sends a map of userId -> [die, die], not a single roll.
  const rolls: number[] | null = id === "dice" && state.lastRolls
    ? (Object.values(state.lastRolls).pop() as number[] | undefined) ?? null
    : null;
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
      {rolls && rolls.length > 0 && (
        <div className="gb-dice">{rolls.map((n, i) => <Die key={i} value={n} />)}</div>
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
