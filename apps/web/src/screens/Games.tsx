import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { useNav } from "../nav";
import { ScreenHeader } from "../components/ScreenHeader";
import { PlaySegments } from "../components/PlaySegments";
import { formatMoney } from "../money";
import { EmptyState } from "../components/EmptyState";
import { GameArt, GameCover, WORLD_ORDER, worldFor } from "../components/GameArt";
import { SpinnerIcon, UsersIcon, PlayIcon, RadioIcon, TrophyIcon, SplitIcon, ChevronRightIcon, SearchIcon, CloseIcon, GlobeIcon } from "../components/Icons";
import { themeForGame } from "../themes";
import { applyTheme, pickedTheme, themeMode } from "../theme-runtime";
import { GAME_RAKE_BPS } from "@vibe/shared";
import { noteFor } from "../gameInfo";
// The arcade shelf renders `.external-tile`, which lives in this stylesheet. It
// was imported only by GameTable, so a session that never opened a table drew
// the shelf as bare unstyled links — 700px wide and 24px tall.
import "../game-table.css";

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


/** A title from the public catalogue. It is browsable here, played elsewhere. */
interface ExternalGame {
  id: string;
  name: string;
  blurb: string;
  genre: string;
  platform: string;
  thumbnail: string | null;
  url: string;
  publisher: string | null;
  releaseDate: string | null;
}

const STAKES = [0, 5_000, 10_000, 20_000, 50_000];

export function GamesScreen({ onBack, viewerId, onOpenBattles }: { onBack?: () => void; viewerId?: string; onOpenBattles?: () => void }) {
  const nav = useNav();
  const [games, setGames] = useState<Game[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The arcade's outer shelf, sourced from a public games catalogue. It is
  // fetched separately: a slow or unavailable upstream must not stop the
  // playable tables from loading.
  const [external, setExternal] = useState<ExternalGame[] | null>(null);
  const [externalDegraded, setExternalDegraded] = useState(false);

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

  // The public shelf loads once; the server caches it for ten minutes.
  useEffect(() => {
    let live = true;
    api<{ external: ExternalGame[]; degraded: boolean }>("/v1/games/catalogue")
      .then((r) => { if (live) { setExternal(r.external); setExternalDegraded(r.degraded); } })
      .catch(() => { if (live) setExternal([]); });
    return () => { live = false; };
  }, []);

  const playable = useMemo(() => (games ?? []).filter((g) => g.availability === "playable"), [games]);
  const featured = playable[0] ?? games?.[0] ?? null;

  // A table you are already sitting at is not something to browse past - it is
  // where you were going. Split it out so returning is the first thing offered.
  const mine = useMemo(
    () => sessions.filter((s) => viewerId && s.players.some((p) => p.id === viewerId)),
    [sessions, viewerId],
  );
  const others = useMemo(
    () => sessions.filter((s) => !viewerId || !s.players.some((p) => p.id === viewerId)),
    [sessions, viewerId],
  );

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

  const externalShown = useMemo(() => {
    const list = external ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((g) => g.name.toLowerCase().includes(q) || g.blurb.toLowerCase().includes(q) || g.genre.toLowerCase().includes(q));
  }, [external, query]);

  // The room takes on the environment of whatever game is in focus.
  const focus = picked ?? (category ? (byCategory[category]?.[0] ?? featured) : featured);
  useEffect(() => {
    if (themeMode() !== "follow") return;
    applyTheme(focus ? themeForGame(focus.id, focus.category) : null);
    return () => applyTheme(pickedTheme());
  }, [focus?.id]);

  return (
    <div className="games-flow">
      <ScreenHeader
        eyebrow="Play"
        title="Games"
        subtitle="Join a table, stake Vibe Yens, and let the winner take the pot."
        action={
          onBack ? (
            <button className="icon-button" aria-label="Back" onClick={onBack}>
              <TrophyIcon width={20} height={20} />
            </button>
          ) : undefined
        }
      />

      {onOpenBattles && <PlaySegments active="games" onChange={(s) => { if (s === "battles") onOpenBattles(); }} />}

      {error && <div className="notice danger" role="alert">{error}</div>}

      {/* The featured band. One game at a time, given the whole width, with the
          room lit behind it — the arcade's window. */}
      {featured && (
        <section className="games-hero" aria-label="Featured game">
          <div className="games-hero-glow" aria-hidden="true" />
          <div className="games-hero-copy">
            <span className="games-hero-eyebrow">Now featuring</span>
            <h2 className="games-hero-title">{featured.name}</h2>
            <p className="games-hero-blurb">{featured.blurb}</p>
            <div className="games-hero-meta">
              <span className="chip"><UsersIcon width={12} height={12} /> {featured.minPlayers}–{featured.maxPlayers} players</span>
              {featured.stakeEnabled && <span className="chip chip-gold">Stakes</span>}
              <span className="chip">{worldFor(featured.category).label}</span>
            </div>
            <button className="btn primary games-hero-cta" onClick={() => setPicked(featured)}>
              <PlayIcon width={17} height={17} /> {featured.availability === "playable" ? "Start a table" : "Coming soon"}
            </button>
          </div>
          <div className="games-hero-art" aria-hidden="true">
            <GameCover gameId={featured.id} category={featured.category} name="" size={196} />
          </div>
        </section>
      )}

      <div className="games-search">
        <SearchIcon width={17} height={17} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the arcade"
          aria-label="Search games"
        />
        {query && (
          <button className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}>
            <CloseIcon width={16} height={16} />
          </button>
        )}
      </div>

      {/* Your tables — where you already are, so returning is the first offer. */}
      {mine.length > 0 && (
        <section className="shelf">
          <div className="shelf-head">
            <h2 className="section-title"><PlayIcon width={16} height={16} /> Your tables</h2>
            <span className="chip chip-gold">{mine.length} waiting</span>
          </div>
          <div className="shelf-row">
            {mine.map((s) => (
              <button key={s.id} className="table-card" onClick={() => nav.push({ name: "game", sessionId: s.id })}>
                <span className="table-card-top">
                  <GameCover gameId={s.gameId} category={s.category} name="" size={48} />
                  <span className={`live-dot${s.status === "active" ? " playing" : ""}`} aria-hidden="true" />
                </span>
                <strong className="table-card-name truncate">{s.gameName}</strong>
                <span className="meta truncate">
                  {s.status === "active" ? "In play" : "Waiting"} · {s.players.length}/{s.maxPlayers}
                </span>
                <span className="table-card-cta">Rejoin</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Live now — real sessions, with an honest empty state. */}
      <section className="shelf">
        <div className="shelf-head">
          <h2 className="section-title"><RadioIcon width={16} height={16} /> Live now</h2>
          {others.length > 0 && <span className="chip">{others.length} open</span>}
        </div>
        {others.length === 0 ? (
          <EmptyState
            icon={<UsersIcon />}
            title="No tables open yet"
            text="Start one below and it appears here for anyone to join."
          />
        ) : (
          <div className="shelf-row">
            {others.map((s) => (
              <button key={s.id} className="table-card" onClick={() => nav.push({ name: "game", sessionId: s.id })}>
                <span className="table-card-top">
                  <GameCover gameId={s.gameId} category={s.category} name="" size={48} />
                  <span className={`live-dot${s.status === "active" ? " playing" : ""}`} aria-hidden="true" />
                </span>
                <strong className="table-card-name truncate">{s.gameName}</strong>
                <span className="meta truncate">
                  {s.players.find((p) => p.id === s.hostId)?.displayName ?? "someone"}'s table · {s.players.length}/{s.maxPlayers}
                </span>
                <span className={s.stakeMinor > 0 ? "table-card-cta gold" : "table-card-cta"}>
                  {s.stakeMinor > 0 ? formatMoney(s.potMinor, s.currency) : "Free to join"}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* The worlds. Choosing one re-lights the whole screen, then the
          catalogue below narrows to it — a filter that feels like a doorway. */}
      <section className="shelf">
        <div className="shelf-head">
          <h2 className="section-title">Worlds</h2>
          {category && <button className="link-button" onClick={() => setCategory(null)}>Show all</button>}
        </div>
        <div className="shelf-row">
          <button className="world-chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
            <span className="world-chip-swatch all" aria-hidden="true" />
            <span className="world-chip-body">
              <span className="world-chip-label">All worlds</span>
              <span className="meta">{games?.length ?? 0} games</span>
            </span>
          </button>
          {WORLD_ORDER.filter((c) => byCategory[c]?.length).map((c) => {
            const w = worldFor(c);
            return (
              <button
                key={c}
                className="world-chip"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                style={{ ["--world" as string]: w.accent, ["--world-from" as string]: w.from, ["--world-to" as string]: w.to }}
              >
                <span className="world-chip-swatch" aria-hidden="true" />
                <span className="world-chip-body">
                  <span className="world-chip-label truncate">{w.label}</span>
                  <span className="meta truncate">{w.tagline}</span>
                </span>
                <span className="world-chip-count">{byCategory[c]!.length}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* The wider arcade. These are real titles from the public games
          catalogue; we do not build or host them, so every card says where it
          plays. Our own tables stay above, where a stake and a winner are real. */}
      {external && external.length > 0 && !category && (
        <section className="shelf">
          <div className="shelf-head">
            <h2 className="section-title"><GlobeIcon width={16} height={16} /> From the wider arcade</h2>
            <span className="meta">plays elsewhere</span>
          </div>
          {externalDegraded && (
            <p className="meta">The catalogue is a little slow right now — showing a short shelf.</p>
          )}
          {externalShown.length === 0 ? (
            <p className="meta">Nothing in the wider arcade matches “{query.trim()}”.</p>
          ) : (
            <div className="shelf-row external-row">
              {externalShown.slice(0, 24).map((g) => (
                <a
                  key={g.id}
                  className="external-tile"
                  href={g.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`${g.name} — opens on the publisher's site`}
                >
                  <span className="external-tile-shot">
                    {g.thumbnail
                      ? <img src={g.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      : <span className="external-tile-fallback">{g.name.slice(0, 1)}</span>}
                    <span className="external-tile-out" aria-hidden>↗</span>
                  </span>
                  <span className="external-tile-name truncate">{g.name}</span>
                  <span className="external-tile-genre truncate">{g.genre} · {g.platform}</span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {/* The catalogue. */}
      {games === null && <div className="skeleton" aria-busy="true" />}
      {games && (
        <section className="shelf">
          <div className="shelf-head">
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
                    <GameCover gameId={g.id} category={g.category} name={g.name} size={72} className="game-tile-cover" />
                    {g.availability === "planned" && <span className="game-tile-soon">Soon</span>}
                  </span>
                  <span className="game-tile-name">{g.name}</span>
                  <span className="game-tile-sub">
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
    </div>
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
                    Each player stakes {formatMoney(stake, "NGN")}. Vibe takes {GAME_RAKE_BPS / 100}% of the pot; the winner takes the rest.
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
