import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { useNav } from "../nav";
import { ScreenHeader } from "../components/ScreenHeader";
import { EmptyState } from "../components/EmptyState";
import { GameArt, GameCover, WORLD_ORDER, worldFor } from "../components/GameArt";
import { SpinnerIcon, UsersIcon, PlayIcon, RadioIcon, TrophyIcon, SplitIcon, ChevronRightIcon, SearchIcon, CloseIcon } from "../components/Icons";
import { themeForGame } from "../themes";
import { applyTheme, pickedTheme, themeMode } from "../theme-runtime";
import { GAME_RAKE_BPS } from "@vibe/shared";
import { noteFor } from "../gameInfo";

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
  const [query, setQuery] = useState("");

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

  // How many open tables each game has right now, so the catalogue reflects the
  // room rather than being a static list.
  const liveByGame = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const s of sessions) acc[s.gameId] = (acc[s.gameId] ?? 0) + 1;
    return acc;
  }, [sessions]);

  const shown = useMemo(() => {
    const base = category ? (byCategory[category] ?? []) : (games ?? []);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((g) => g.name.toLowerCase().includes(q) || g.blurb.toLowerCase().includes(q));
  }, [category, byCategory, games, query]);

  // The room takes on the environment of whatever game is in focus.
  const focus = picked ?? (category ? (byCategory[category]?.[0] ?? featured) : featured);
  useEffect(() => {
    if (themeMode() !== "follow") return;
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

      <div className="game-search">
        <SearchIcon width={16} height={16} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search games"
          aria-label="Search games"
        />
        {query && (
          <button className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}>
            <CloseIcon width={16} height={16} />
          </button>
        )}
      </div>

      {/* The marquee. A lit band carrying the arcade's identity, the game in
          focus, and the one action that matters: enter. */}
      {featured && (
        <section className="marquee" aria-label="Featured game">
          <div className="marquee-glow" aria-hidden="true" />
          <div className="marquee-body">
            <span className="marquee-eyebrow">Now featured</span>
            <h2 className="marquee-name">{featured.name}</h2>
            <p className="marquee-blurb">{featured.blurb}</p>
            <div className="marquee-meta">
              <span className="chip"><UsersIcon width={12} height={12} /> {featured.minPlayers}–{featured.maxPlayers} players</span>
              {featured.stakeEnabled && <span className="chip chip-gold">Stakes</span>}
              <span className="chip">{worldFor(featured.category).label}</span>
            </div>
            <button className="btn primary marquee-cta" onClick={() => setPicked(featured)}>
              <PlayIcon width={17} height={17} /> {featured.availability === "playable" ? "Start a table" : "Coming soon"}
            </button>
          </div>
          <div className="marquee-art" aria-hidden="true">
            <GameCover gameId={featured.id} category={featured.category} name="" size={188} />
          </div>
        </section>
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
          <div className="live-rail">
            {sessions.map((s) => (
              <button key={s.id} className="live-card" onClick={() => nav.push({ name: "game", sessionId: s.id })}>
                <span className="live-card-top">
                  <GameCover gameId={s.gameId} category={s.category} name="" size={44} />
                  <span className={`live-dot${s.status === "active" ? " playing" : ""}`} aria-hidden="true" />
                </span>
                <strong className="truncate">{s.gameName}</strong>
                <span className="meta truncate">
                  {s.status === "active" ? "In play" : "Lobby"} · {s.players.length}/{s.maxPlayers}
                </span>
                <span className="meta truncate">
                  {s.players.find((p) => p.id === s.hostId)?.displayName ?? "someone"}'s table
                </span>
                <span className={s.stakeMinor > 0 ? "chip chip-gold" : "chip"}>
                  {s.stakeMinor > 0 ? money(s.potMinor, s.currency) : "Free"}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* The worlds. Each category is a lit room; choosing one changes the
          whole environment, not just a filter. */}
      <section className="stack">
        <div className="row spread">
          <h2 className="section-title">Worlds</h2>
          {category && (
            <button className="link-button" onClick={() => setCategory(null)}>Clear</button>
          )}
        </div>
        <div className="world-shelf">
          <button className="world-tile" aria-pressed={category === null} onClick={() => setCategory(null)}>
            <span className="world-tile-swatch" aria-hidden="true" />
            <span className="world-tile-body">
              <span className="world-tile-name">All worlds</span>
              <span className="meta">{games?.length ?? 0} games</span>
            </span>
          </button>
          {WORLD_ORDER.filter((c) => byCategory[c]?.length).map((c) => {
            const w = worldFor(c);
            return (
              <button
                key={c}
                className="world-tile"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                style={{ ["--world" as string]: w.accent, ["--world-from" as string]: w.from, ["--world-to" as string]: w.to }}
              >
                <span className="world-tile-swatch" aria-hidden="true" />
                <span className="world-tile-body">
                  <span className="world-tile-name">{w.label}</span>
                  <span className="meta truncate">{w.tagline}</span>
                </span>
                <span className="world-tile-count">{byCategory[c]!.length}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* The catalogue. */}
      {games === null && <div className="skeleton" aria-busy="true" />}
      {games && (
        <section className="stack">
          <div className="row spread">
            <h2 className="section-title">{category ? worldFor(category).label : "All games"}</h2>
            <span className="meta">{shown.length} {shown.length === 1 ? "game" : "games"}</span>
          </div>
          <div className="game-grid">
            {shown.map((g) => {
              const w = worldFor(g.category);
              return (
                <button
                  key={g.id}
                  className="game-tile"
                  onClick={() => setPicked(g)}
                  style={{ ["--world" as string]: w.accent }}
                  aria-label={`${g.name}${g.availability === "planned" ? " (coming soon)" : ""}`}
                >
                  <span className="game-tile-art">
                    <GameCover gameId={g.id} category={g.category} name={g.name} size={64} className="game-tile-cover" />
                    {g.availability === "planned" && <span className="game-tile-soon">Soon</span>}
                  </span>
                  <span className="game-tile-name">{g.name}</span>
                  <span className="game-tile-players">
                    <UsersIcon width={11} height={11} /> {g.minPlayers}–{g.maxPlayers}
                  </span>
                  <span className="game-tile-tags">
                    {liveByGame[g.id] ? (
                      <span className="chip chip-livecount"><span className="live-dot" aria-hidden="true" /> {liveByGame[g.id]} live</span>
                    ) : null}
                    {g.stakeEnabled && g.availability === "playable" && <span className="chip chip-gold">Stakes</span>}
                    {g.availability === "playable" && <span className="chip chip-quiet">Playable</span>}
                  </span>
                </button>
              );
            })}
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

        {(() => {
          const note = noteFor(game.id, game.blurb);
          return (
            <div className="game-rules">
              <div className="game-rule">
                <span className="game-rule-label">How you win</span>
                <span>{note.goal}</span>
              </div>
              <div className="game-rule">
                <span className="game-rule-label">On your turn</span>
                <span>{note.turn}</span>
              </div>
            </div>
          );
        })()}

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
                    Each player stakes {money(stake, "NGN")}. Vibe takes {GAME_RAKE_BPS / 100}% of the pot; the winner takes the rest.
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
