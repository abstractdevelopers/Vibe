import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { useNav } from "../nav";
import { ScreenHeader } from "../components/ScreenHeader";
import { EmptyState } from "../components/EmptyState";
import { SpinnerIcon, TrophyIcon, UsersIcon } from "../components/Icons";

/**
 * Games lobby.
 *
 * Two things live here: the catalogue of everything Vibe offers (with the ones
 * that are not playable yet honestly marked), and the open games anyone can
 * join. Starting a game is server-authoritative — the API refuses to start a
 * game with no engine, so the "planned" badge is not just a label.
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
  mind: "Mind",
  action: "Action",
  party: "Party",
};

function money(minor: number, currency: string): string {
  return `${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`;
}

const STAKES = [0, 5_000, 10_000, 20_000, 50_000];

export function GamesScreen({ onBack }: { onBack: () => void }) {
  const nav = useNav();
  const [tab, setTab] = useState<"open" | "all">("open");
  const [games, setGames] = useState<Game[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const byCategory = (games ?? []).reduce<Record<string, Game[]>>((acc, g) => {
    (acc[g.category] ??= []).push(g);
    return acc;
  }, {});

  return (
    <>
      <ScreenHeader
        eyebrow="Play"
        title="Games"
        subtitle="Play with friends or strangers. Stake Vibe Yens and the winner takes the pot."
        action={
          <button className="icon-button" aria-label="Back" onClick={onBack}>
            <TrophyIcon width={20} height={20} />
          </button>
        }
      />

      <div className="pill-row" role="tablist">
        <button className="pill" role="tab" aria-selected={tab === "open"} onClick={() => setTab("open")}>Open games</button>
        <button className="pill" role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}>All games</button>
      </div>

      {error && <div className="notice danger" role="alert">{error}</div>}

      {tab === "open" && (
        <section className="stack">
          {sessions.length === 0 && (
            <EmptyState icon={<UsersIcon />} title="No open games" text="Start one from All games and others can join." />
          )}
          {sessions.map((s) => (
            <button key={s.id} className="card row spread" onClick={() => nav.push({ name: "game", sessionId: s.id })}>
              <div className="stack" style={{ gap: 2, textAlign: "left" }}>
                <strong>{s.gameName}</strong>
                <span className="meta">
                  {s.status === "active" ? "In play" : "Lobby"} · {s.players.length}/{s.maxPlayers} · hosted by{" "}
                  {s.players.find((p) => p.id === s.hostId)?.displayName ?? "someone"}
                </span>
              </div>
              <div className="stack" style={{ alignItems: "flex-end", gap: 2 }}>
                {s.stakeMinor > 0 ? (
                  <>
                    <span className="chip chip-gold">Pot {money(s.potMinor, s.currency)}</span>
                    <span className="meta">{money(s.stakeMinor, s.currency)} each</span>
                  </>
                ) : (
                  <span className="chip">Free</span>
                )}
              </div>
            </button>
          ))}
        </section>
      )}

      {tab === "all" && (
        <>
          {games === null && <div className="skeleton" aria-busy="true" />}
          {games && Object.entries(byCategory).map(([category, list]) => (
            <section key={category} className="stack">
              <h2 className="section-title">{CATEGORY_LABEL[category] ?? category}</h2>
              <div className="game-grid">
                {list.map((g) => (
                  <button
                    key={g.id}
                    className="game-tile"
                    onClick={() => setPicked(g)}
                    aria-label={`${g.name}${g.availability === "planned" ? " (coming soon)" : ""}`}
                  >
                    <span className="game-tile-icon" aria-hidden>{g.icon ?? "🎲"}</span>
                    <span className="game-tile-name">{g.name}</span>
                    <span className="meta">{g.minPlayers}–{g.maxPlayers} players</span>
                    {g.availability === "planned" && <span className="chip">Coming soon</span>}
                    {g.stakeEnabled && g.availability === "playable" && <span className="chip chip-gold">Stakes</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
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
          <h2 className="studio-title">{game.icon} {game.name}</h2>
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
                    <button
                      key={s}
                      className="pill"
                      aria-pressed={stake === s}
                      onClick={() => setStake(s)}
                    >
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
