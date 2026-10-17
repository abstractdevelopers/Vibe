import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { useNav } from "../nav";
import { ScreenHeader } from "../components/ScreenHeader";
import { EmptyState } from "../components/EmptyState";
import { GameArt, GameCover } from "../components/GameArt";
import { SpinnerIcon, UsersIcon, PlayIcon, RadioIcon, TrophyIcon, ClockIcon } from "../components/Icons";
import { themeForGame } from "../themes";
import { applyTheme, followActivity, pickedTheme } from "../theme-runtime";

/**
 * Play — the game world.
 *
 * This is a destination, not a list. It leads with a featured table, shows what
 * is live right now, then the full catalogue grouped by the mood of the game.
 * Every game has drawn artwork (no emoji), and the room takes on the environment
 * of the game you are looking at when "follow activity" is on — so browsing the
 * catalogue feels like walking through an arcade rather than reading a menu.
 *
 * Starting a game stays server-authoritative: the API refuses to start a game
 * with no engine, so a "planned" title cannot be launched even if the client is
 * tricked into asking.
 */

interface Game {
  id: string;
  name: string;
  category: string;
  blurb: string;
  minPlayers: number;
  maxPlayers: number;
  stakeEnabled: boolean;
  availability: "playable" | "planned";
  icon: string | null;
}

interface SessionPlayer {
  id: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  seat: number;
  status: string;
  stakedMinor: number;
}

interface Session {
  id: string;
  gameId: string;
  gameName: string;
  category: string;
  status: string;
  stakeMinor: number;
  potMinor: number;
  currency: string;
  hostId: string;
  minPlayers: number;
  maxPlayers: number;
  players: SessionPlayer[];
}

const CATEGORY_LABEL: Record<string, string> = {
  cards: "Cards",
  board: "Board",
  casino: "Casino",
  mind: "Mind games",
  action: "Action",
  party: "Party",
};

const CATEGORY_BLURB: Record<string, string> = {
  cards: "Classics you already know how to play.",
  board: "Slow games for long evenings.",
  casino: "Fast, high-energy rounds.",
  mind: "Word, memory and trivia.",
  action: "Reflex and nerve.",
  party: "Loud games for a group.",
};

function money(minor: number, currency: string): string {
  return `${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`;
}

const STAKES = [0, 5_000, 10_000, 20_000, 50_000];

export function GamesScreen({ onBack }: { onBack?: () => void }) {
  const nav = useNav();
  const [games, setGames] = useState<Game[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [catalogue, open] = await Promise.all([
        api<{ games: Game[] }>("/v1/games"),
        api<{ sessions: Session[] }>("/v1/games/sessions"),
      ]);
      setGames(catalogue.games);
      setSessions(open.sessions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load games");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => { void load(); }, 6000);
    return () => window.clearInterval(t);
  }, [load]);

  const playable = useMemo(() => (games ?? []).filter((g) => g.availability === "playable"), [games]);
  const featured = playable[0] ?? games?.[0] ?? null;

  const byCategory = useMemo(() => {
    const acc: Record<string, Game[]> = {};
    for (const g of games ?? []) (acc[g.category] ??= []).push(g);
    return acc;
  }, [games]);

  const categories = useMemo(() => Object.keys(byCategory), [byCategory]);
  const shown = category ? (byCategory[category] ?? []) : (games ?? []);

  // The room takes on the environment of whatever game is in focus.
  const focus = picked ?? (category ? (byCategory[category]?.[0] ?? featured) : featured);
  useEffect(() => {
    if (!followActivity() || pickedTheme()) return;
    applyTheme(focus ? themeForGame(focus.id, focus.category) : null);
    return () => applyTheme(pickedTheme());
  }, [focus?.id]);

  return (
    <>
      <ScreenHeader
        eyebrow="Play"
        title="Games"
        subtitle="Play with friends or strangers. Stake Vibe Yens and the winner takes the pot."
        action={
          onBack ? (
            <button className="icon-button" aria-label="Back" onClick={onBack}>
              <TrophyIcon width={20} height={20} />
            </button>
          ) : undefined
        }
      />

      {error && <div className="notice danger" role="alert">{error}</div>}

      {/* Featured table — the front door of the arcade. */}
      {featured && (
        <button
          className="play-feature"
          onClick={() => setPicked(featured)}
          aria-label={`${featured.name} — ${featured.blurb}`}
        >
          <span className="play-feature-art">
            <GameCover gameId={featured.id} category={featured.category} name="" size={132} />
          </span>
          <span className="play-feature-body">
            <span className="eyebrow">Featured</span>
            <strong className="play-feature-name">{featured.name}</strong>
            <span className="meta">{featured.blurb}</span>
            <span className="play-feature-cta">
              <PlayIcon width={16} height={16} /> Start a table
            </span>
          </span>
        </button>
      )}

      {/* Live now — real sessions, with an honest empty state. */}
      <section className="stack">
        <div className="row spread">
          <h2 className="section-title"><RadioIcon width={16} height={16} /> Live now</h2>
          {sessions.length > 0 && <span className="chip">{sessions.length} open</span>}
        </div>
        {sessions.length === 0 ? (
          <EmptyState
            icon={<UsersIcon />}
            title="No tables open yet"
            text="Start one below and it appears here for anyone to join."
          />
        ) : (
          <div className="play-live-list">
            {sessions.map((s) => (
              <button key={s.id} className="play-live-row" onClick={() => nav.push({ name: "game", sessionId: s.id })}>
                <GameCover gameId={s.gameId} category={s.category} name="" size={46} />
                <span className="grow" style={{ textAlign: "left", minWidth: 0 }}>
                  <strong className="truncate">{s.gameName}</strong>
                  <span className="meta truncate">
                    {s.status === "active" ? "In play" : "Lobby"} · {s.players.length}/{s.maxPlayers} ·{" "}
                    {s.players.find((p) => p.id === s.hostId)?.displayName ?? "someone"}'s table
                  </span>
                </span>
                {s.stakeMinor > 0 ? (
                  <span className="chip chip-gold">{money(s.potMinor, s.currency)}</span>
                ) : (
                  <span className="chip">Free</span>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Category shelf. */}
      <section className="stack">
        <h2 className="section-title">Browse</h2>
        <div className="play-shelf">
          <button className="play-cat" aria-pressed={category === null} onClick={() => setCategory(null)}>
            <span className="play-cat-name">Everything</span>
            <span className="meta">{games?.length ?? 0} games</span>
          </button>
          {categories.map((c) => (
            <button key={c} className="play-cat" aria-pressed={category === c} onClick={() => setCategory(c)}>
              <span className="play-cat-name">{CATEGORY_LABEL[c] ?? c}</span>
              <span className="meta">{byCategory[c]!.length} games</span>
            </button>
          ))}
        </div>
        {category && CATEGORY_BLURB[category] && <p className="meta">{CATEGORY_BLURB[category]}</p>}
      </section>

      {/* The catalogue. */}
      {games === null && <div className="skeleton" aria-busy="true" />}
      {games && (
        <section className="stack">
          <div className="game-grid">
            {shown.map((g) => (
              <button
                key={g.id}
                className="game-tile"
                onClick={() => setPicked(g)}
                aria-label={`${g.name}${g.availability === "planned" ? " (coming soon)" : ""}`}
              >
                <GameCover gameId={g.id} category={g.category} name={g.name} size={64} className="game-tile-cover" />
                <span className="game-tile-name">{g.name}</span>
                <span className="meta">{g.minPlayers}–{g.maxPlayers} players</span>
                <span className="game-tile-tags">
                  {g.availability === "planned" && <span className="chip"><ClockIcon width={11} height={11} /> Soon</span>}
                  {g.stakeEnabled && g.availability === "playable" && <span className="chip chip-gold">Stakes</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {picked && (
        <CreateGameSheet
          game={picked}
          onClose={() => setPicked(null)}
          onCreated={(sessionId) => { setPicked(null); nav.push({ name: "game", sessionId }); }}
        />
      )}
    </>
  );
}

function CreateGameSheet({
  game,
  onClose,
  onCreated,
}: {
  game: Game;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}) {
  const [stake, setStake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playable = game.availability === "playable";

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ session: Session }>("/v1/games/sessions", {
        body: { gameId: game.id, stakeMinor: stake },
        idempotencyKey: idempotencyKey("game"),
      });
      onCreated(res.session.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the game");
      setBusy(false);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={`Start ${game.name}`} onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="row spread">
          <h2 className="studio-title row" style={{ gap: "var(--space-3)" }}>
            <GameArt gameId={game.id} category={game.category} size={40} accent="var(--accent)" />
            {game.name}
          </h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <p className="meta">{game.blurb}</p>

        {!playable ? (
          <>
            <div className="notice">{game.name} is coming soon. It is listed so you know it is on the way, but it cannot be started yet.</div>
            <button className="btn" onClick={onClose}>Close</button>
          </>
        ) : (
          <>
            {game.stakeEnabled && (
              <div className="stack">
                <span className="meta">Stake per player (Vibe Yens)</span>
                <div className="pill-row">
                  {STAKES.map((s) => (
                    <button key={s} className="pill" aria-pressed={stake === s} onClick={() => setStake(s)}>
                      {s === 0 ? "Free" : (s / 100).toLocaleString()}
                    </button>
                  ))}
                </div>
                {stake > 0 && (
                  <p className="meta">
                    Each player stakes {money(stake, "NGN")}. Vibe takes 5% of the pot; the winner takes the rest.
                  </p>
                )}
              </div>
            )}
            {error && <div className="notice danger" role="alert">{error}</div>}
            <button className="btn primary block" disabled={busy} onClick={() => void create()}>
              {busy ? <SpinnerIcon width={18} height={18} /> : "Create table"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
