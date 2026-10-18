import { useEffect, useState } from "react";
import { api, mediaSrc } from "../api";
import { Avatar } from "./Avatar";

/**
 * The rail above the feed that shows what is happening right now: rooms that are
 * live, battles that are open, and people you do not follow yet.
 *
 * It is discovery, not a second feed. Every card is one tap to the thing itself,
 * and the rail disappears entirely when there is nothing real to show — an empty
 * "Live now" strip is worse than no strip.
 */

type LiveRoom = {
  id: string;
  kind: string;
  title: string;
  state: "live" | "starting_soon" | "scheduled";
  host: { handle: string; displayName: string };
  bannerUrl: string | null;
  memberCount: number;
};

type Battle = {
  id: string;
  title: string;
  sides: { a: string; b: string };
  status: string;
  tally: { a: number; b: number };
  potMinor: number;
  host: { handle: string; displayName: string; avatarUrl: string | null } | null;
};

type Creator = {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  followerCount?: number;
};

type Rail = {
  live: LiveRoom[];
  battles: Battle[];
  creators: Creator[];
};

const KIND_LABEL: Record<string, string> = {
  sports: "Match",
  movie: "Watch",
  music: "Music",
  voice: "Voice",
  listen: "Listening",
  other: "Room",
};

export function DiscoveryRail({
  onOpenLive,
  onOpenBattle,
  onOpenCreator,
}: {
  onOpenLive: (id: string) => void;
  onOpenBattle: (id: string) => void;
  onOpenCreator: (id: string) => void;
}) {
  const [rail, setRail] = useState<Rail | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [rooms, battles, creators] = await Promise.all([
        api<{ rooms: LiveRoom[] }>("/v1/activities/live?limit=10").catch(() => ({ rooms: [] })),
        api<{ battles: Battle[] }>("/v1/battles?status=open&limit=8").catch(() => ({ battles: [] })),
        api<{ users: Creator[] }>("/v1/discover/creators?limit=12").catch(() => ({ users: [] })),
      ]);
      if (!live) return;
      // Live first, then starting soon. A scheduled room is not "happening".
      const order = { live: 0, starting_soon: 1, scheduled: 2 } as const;
      setRail({
        live: [...rooms.rooms].sort((a, b) => order[a.state] - order[b.state]).slice(0, 8),
        battles: battles.battles.slice(0, 6),
        creators: creators.users.slice(0, 12),
      });
    })();
    return () => { live = false; };
  }, []);

  if (!rail) return null;
  const hasLive = rail.live.length > 0;
  const hasBattles = rail.battles.length > 0;
  const hasCreators = rail.creators.length > 0;
  if (!hasLive && !hasBattles && !hasCreators) return null;

  return (
    <div className="rail">
      {hasLive && (
        <section className="rail-section" aria-label="Live now">
          <div className="rail-head">
            <h2 className="rail-title"><span className="rail-dot" aria-hidden="true" /> Live now</h2>
          </div>
          <div className="rail-track">
            {rail.live.map((r) => (
              <button key={r.id} className="live-card" onClick={() => onOpenLive(r.id)}>
                <span
                  className="live-card-art"
                  style={r.bannerUrl ? { backgroundImage: `url(${mediaSrc(r.bannerUrl)})` } : undefined}
                  aria-hidden="true"
                />
                <span className="live-card-body">
                  <span className={`live-badge${r.state === "live" ? " on" : ""}`}>
                    {r.state === "live" ? "LIVE" : "SOON"}
                  </span>
                  <span className="live-card-title">{r.title}</span>
                  <span className="live-card-meta">
                    {KIND_LABEL[r.kind] ?? "Room"} · @{r.host.handle}
                    {r.memberCount > 0 ? ` · ${r.memberCount}` : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {hasBattles && (
        <section className="rail-section" aria-label="Trending battles">
          <div className="rail-head">
            <h2 className="rail-title">Trending battles</h2>
          </div>
          <div className="rail-track">
            {rail.battles.map((b) => {
              const total = b.tally.a + b.tally.b;
              const pctA = total > 0 ? Math.round((b.tally.a / total) * 100) : 50;
              return (
                <button key={b.id} className="battle-card" onClick={() => onOpenBattle(b.id)}>
                  <span className="battle-card-title">{b.title}</span>
                  <span className="battle-split">
                    <span className="battle-side">{b.sides.a}</span>
                    <span className="battle-vs">vs</span>
                    <span className="battle-side">{b.sides.b}</span>
                  </span>
                  <span className="battle-bar" aria-hidden="true">
                    <span className="battle-bar-a" style={{ width: `${pctA}%` }} />
                  </span>
                  <span className="battle-card-meta">
                    {total > 0 ? `${pctA}% ${b.sides.a} · ${total} votes` : "No votes yet"}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {hasCreators && (
        <section className="rail-section" aria-label="People to follow">
          <div className="rail-head">
            <h2 className="rail-title">People to follow</h2>
          </div>
          <div className="rail-track">
            {rail.creators.map((c) => (
              <button key={c.id} className="creator-card" onClick={() => onOpenCreator(c.id)}>
                <Avatar name={c.displayName} url={c.avatarUrl} size="lg" />
                <span className="creator-name">{c.displayName}</span>
                <span className="creator-handle">@{c.handle}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
