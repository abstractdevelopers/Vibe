import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, idempotencyKey, mediaSrc } from "../api";
import { uploadImageFile } from "../media";
import { ScreenHeader } from "../components/ScreenHeader";
import { PlaySegments } from "../components/PlaySegments";
import { formatMoney, toMinorUnits } from "../money";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { BattleCanvas } from "../components/BattleCanvas";
import { useNav } from "../nav";
import { useRealtime } from "../realtime";
import { STADIUMS, stadium, type MapPlot } from "../iso";
import { ArrowLeftIcon, CameraIcon, SplitIcon, TrophyIcon, UsersIcon, RadioIcon } from "../components/Icons";
// The arena's material lives with the arena, not the shell: this screen is a
// lazy chunk, so its CSS is split out too and the launch bundle keeps room for
// the screens most sessions never open.
import "../battle-world.css";

/**
 * Brand Battles — a stadium world, not a list of bars.
 *
 * Two surfaces, one concept:
 *
 *  - `BattlesScreen` is the map: every open battle sits on a plot in an
 *    isometric field of stadiums. You pick a stadium and walk in.
 *  - `BattleScreen` is inside one: a rendered bowl, two fighters, a crowd, a
 *    clock, and a floor where the argument happens.
 *
 * The rules are unchanged and still the point: a vote is free and one per
 * person, an attack comment is a point, a reaction is two, and a paid punch
 * costs Vibe Yens and is capped per person. Money moves the noise, never the
 * person. The pot still pays out in full with no platform cut.
 */

interface SideBacking {
  side: "a" | "b";
  votes: number;
  backers: number;
  stakedMinor: number;
  comments: number;
  commenters: number;
  gifts: number;
  boosts: number;
  boostPoints: number;
  points: number;
}

interface BoostKind {
  id: string;
  label: string;
  priceMinor: number;
  points: number;
  cap: number;
}

interface Battle {
  id: string;
  title: string;
  topic: string | null;
  sides: { a: string; b: string };
  imageUrl: string | null;
  characters: { a: string | null; b: string | null };
  status: "open" | "closed" | "cancelled";
  winner: "a" | "b" | "tie" | null;
  stakeMinor: number;
  currency: string;
  potMinor: number;
  endsAt: string | null;
  createdAt: string;
  stadium: string;
  intervalSeconds: number;
  boostCatalogue: BoostKind[];
  tally: { a: number; b: number };
  score: { a: number; b: number };
  backing: { a: SideBacking; b: SideBacking };
  host: { id: string; handle: string; displayName: string; avatarUrl: string | null } | null;
  mySide: "a" | "b" | null;
  myStakeMinor: number;
  myPayoutMinor: number;
  myProjectedMinor: number;
  myGifts: string[];
  myBoostCount: number;
  comments: Array<{
    id: string;
    side: "a" | "b";
    body: string;
    createdAt: string;
    author: { id: string; handle: string; displayName: string; avatarUrl: string | null };
  }>;
  backers: Array<{ side: "a" | "b"; staked: boolean; user: { id: string; handle: string; displayName: string; avatarUrl: string | null } }>;
}

/** The reactions a bystander can throw at a side. Mirrors BATTLE_GIFT_KINDS. */
const BATTLE_REACTIONS = [
  { id: "fire", label: "Fire", art: "🔥" },
  { id: "clap", label: "Clap", art: "👏" },
  { id: "shock", label: "Shock", art: "😱" },
  { id: "crown", label: "Crown", art: "👑" },
] as const;

/** Where a plot sits on the map. Fixed slots keep the field tidy. */
const MAP_SLOTS: Array<{ x: number; z: number }> = [
  { x: -5, z: -5 },
  { x: -1, z: -6 },
  { x: 3, z: -5 },
  { x: 6, z: -2 },
  { x: 5, z: 2 },
  { x: 2, z: 5 },
  { x: -2, z: 6 },
  { x: -6, z: 3 },
  { x: -6, z: -1 },
];

function timeLeft(endsAt: string | null): number {
  if (!endsAt) return 0;
  return Math.max(0, new Date(endsAt).getTime() - Date.now());
}

function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function shortLeft(ms: number): string {
  if (ms <= 0) return "ended";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

/** Ticks once a second so a countdown is a clock, not a stale string. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/* ------------------------------------------------------------------- cards */

function ScoreBar({ battle }: { battle: Battle }) {
  const total = battle.score.a + battle.score.b;
  const aPct = total === 0 ? 50 : Math.round((battle.score.a / total) * 100);
  return (
    <div
      className="battle-bar"
      role="img"
      aria-label={`${battle.sides.a} ${battle.score.a} points, ${battle.sides.b} ${battle.score.b} points`}
    >
      <span className="battle-bar-a" style={{ width: `${aPct}%` }} />
      <span className="battle-bar-b" style={{ width: `${100 - aPct}%` }} />
    </div>
  );
}

function BattleCard({ battle, onOpen }: { battle: Battle; onOpen: () => void }) {
  const left = timeLeft(battle.endsAt);
  const total = battle.score.a + battle.score.b;
  const spec = stadium(battle.stadium);
  return (
    <button className={`battle-card battle-card-3d${battle.status === "open" ? " is-open" : ""}`} onClick={onOpen}>
      <span className="battle-card-stage">
        <BattleCanvas
          kind="thumb"
          stadiumId={battle.stadium}
          fighterAUrl={battle.characters.a ? mediaSrc(battle.characters.a) : null}
          fighterBUrl={battle.characters.b ? mediaSrc(battle.characters.b) : null}
          arena={{
            scoreA: battle.score.a,
            scoreB: battle.score.b,
            crowd: Math.min(40, battle.backing.a.backers + battle.backing.b.backers + battle.comments.length),
            phase: 0,
            remaining: 1,
            status: battle.status,
            winner: battle.winner,
            impacts: [],
          }}
          className="battle-card-canvas"
        />
        <span className="battle-card-venue">{spec.name}</span>
        {battle.status === "open" ? (
          <span className="battle-card-status">
            <span className="live-dot playing" aria-hidden /> {shortLeft(left)}
          </span>
        ) : (
          <span className="battle-card-status">
            {battle.winner === "tie" ? "Tie" : battle.winner ? `${battle.winner === "a" ? battle.sides.a : battle.sides.b} won` : "Finished"}
          </span>
        )}
      </span>

      <div className="battle-card-body">
        <div className="battle-card-head">
          <span className="battle-card-vs">
            <span className="battle-card-side">{battle.sides.a}</span>
            <em>vs</em>
            <span className="battle-card-side">{battle.sides.b}</span>
          </span>
          <span className="battle-card-total">{total} pts</span>
        </div>
        <h3 className="battle-card-title">{battle.title}</h3>
        <ScoreBar battle={battle} />
        <div className="battle-card-foot">
          <span className="meta">{battle.comments.length} attacks</span>
          {battle.stakeMinor > 0 && <span className="chip chip-gold">Pot {formatMoney(battle.potMinor, battle.currency)}</span>}
        </div>
      </div>
    </button>
  );
}

/* ----------------------------------------------------------------- the map */

function BattleWorld({ battles, onOpen }: { battles: Battle[]; onOpen: (b: Battle) => void }) {
  const open = battles.filter((b) => b.status === "open");
  const plots: MapPlot[] = open.slice(0, MAP_SLOTS.length).map((b, i) => {
    const slot = MAP_SLOTS[i]!;
    return {
      id: b.id,
      x: slot.x,
      z: slot.z,
      spec: stadium(b.stadium),
      live: true,
      sides: b.sides,
      score: b.score,
    };
  });

  return (
    <section className="battle-world" aria-label="Battle map">
      <div className="battle-world-head">
        <h2 className="section-title"><RadioIcon width={16} height={16} /> Live stadiums</h2>
        <span className="meta">{open.length} on air</span>
      </div>
      <div className="battle-world-stage">
        <BattleCanvas kind="map" plots={plots} className="battle-world-canvas" label={`${open.length} live battles`} />
        {open.length === 0 && (
          <div className="battle-world-empty">
            <p>No stadium has a fight on right now.</p>
            <span className="meta">Start one and its plot lights up here.</span>
          </div>
        )}
      </div>
      {open.length > 0 && (
        <div className="battle-world-chips">
          {open.slice(0, MAP_SLOTS.length).map((b) => (
            <button key={b.id} className="battle-world-chip" onClick={() => onOpen(b)}>
              <span className="battle-world-dot" style={{ background: stadium(b.stadium).accent }} aria-hidden />
              <span className="truncate">{b.title}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- the list */

export function BattlesScreen({ onBack, onOpenGames }: { onBack?: () => void; onOpenGames?: () => void }) {
  const nav = useNav();
  const [battles, setBattles] = useState<Battle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ battles: Battle[] }>("/v1/battles?limit=30");
      setBattles(res.battles);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load battles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A battle opening, closing or taking a punch moves the map without a tap.
  useRealtime((event) => {
    if (event.type === "battles.changed") void load();
  });

  const open = battles.filter((b) => b.status === "open");
  const past = battles.filter((b) => b.status !== "open");

  return (
    <div className="battles-flow">
      <ScreenHeader
        eyebrow="Play"
        title="Battles"
        subtitle="Every stadium is a fight. Walk in, pick a side, and make some noise."
        action={
          onBack ? (
            <button className="icon-button" aria-label="Back" onClick={onBack}>
              <ArrowLeftIcon width={20} height={20} />
            </button>
          ) : undefined
        }
      />

      {onOpenGames && <PlaySegments active="battles" onChange={(s) => { if (s === "games") onOpenGames(); }} />}

      {error && <div className="notice danger" role="alert">{error}</div>}

      <BattleWorld battles={battles} onOpen={(b) => nav.push({ name: "battle", battleId: b.id })} />

      <button className="btn primary block" onClick={() => setCreating((v) => !v)}>
        <SplitIcon width={17} height={17} /> {creating ? "Close" : "Open a new stadium"}
      </button>

      {creating && <CreateBattle onCreated={() => { setCreating(false); void load(); }} />}

      {loading ? (
        <div className="skeleton" aria-busy="true" style={{ height: 180 }} />
      ) : (
        <>
          <section className="shelf">
            <div className="shelf-head">
              <h2 className="section-title"><TrophyIcon width={16} height={16} /> On air</h2>
              {open.length > 0 && <span className="meta">{open.length}</span>}
            </div>
            {open.length === 0 ? (
              <EmptyState icon={<SplitIcon />} title="No battles yet" text="Open a stadium above and let people pick a side." />
            ) : (
              <div className="battle-list">
                {open.map((b) => <BattleCard key={b.id} battle={b} onOpen={() => nav.push({ name: "battle", battleId: b.id })} />)}
              </div>
            )}
          </section>

          {past.length > 0 && (
            <section className="shelf">
              <div className="shelf-head">
                <h2 className="section-title">Finished</h2>
                <span className="meta">{past.length}</span>
              </div>
              <div className="battle-list">
                {past.map((b) => <BattleCard key={b.id} battle={b} onOpen={() => nav.push({ name: "battle", battleId: b.id })} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- create form */

const ROUNDS = [
  { seconds: 300, label: "5 min" },
  { seconds: 600, label: "10 min" },
  { seconds: 1800, label: "30 min" },
  { seconds: 3600, label: "1 hour" },
] as const;

function CreateBattle({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [sideA, setSideA] = useState("");
  const [sideB, setSideB] = useState("");
  const [topic, setTopic] = useState("");
  const [stake, setStake] = useState("");
  const [stadiumId, setStadiumId] = useState<string>(STADIUMS[0]!.id);
  const [round, setRound] = useState<number>(600);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [characterAUrl, setCharacterAUrl] = useState<string | null>(null);
  const [characterBUrl, setCharacterBUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(which: "image" | "a" | "b", file?: File) {
    if (!file) return;
    setUploading(which);
    setError(null);
    try {
      const url = await uploadImageFile(file, 1024);
      if (which === "image") setImageUrl(url);
      else if (which === "a") setCharacterAUrl(url);
      else setCharacterBUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload that image");
    } finally {
      setUploading(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const stakeMinor = stake ? toMinorUnits(stake, "NGN") ?? 0 : 0;
      await api("/v1/battles", {
        body: {
          title, sideA, sideB,
          topic: topic || undefined,
          stakeMinor,
          stadium: stadiumId,
          intervalSeconds: round,
          imageUrl: imageUrl ?? undefined,
          characterAUrl: characterAUrl ?? undefined,
          characterBUrl: characterBUrl ?? undefined,
        },
        idempotencyKey: idempotencyKey("battle"),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the battle");
    } finally {
      setBusy(false);
    }
  }

  const preview = stadium(stadiumId);

  return (
    <form className="battle-create" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="battle-create-preview-stage">
        <BattleCanvas
          kind="thumb"
          stadiumId={stadiumId}
          fighterAUrl={characterAUrl ? mediaSrc(characterAUrl) : null}
          fighterBUrl={characterBUrl ? mediaSrc(characterBUrl) : null}
          arena={{ scoreA: 0, scoreB: 0, crowd: 12, phase: 1.3, remaining: 1, status: "open", winner: null, impacts: [] }}
          className="battle-create-canvas"
          label={`${preview.name} preview`}
        />
        <span className="battle-create-venue">{preview.name}</span>
      </div>

      <fieldset className="battle-create-fieldset">
        <legend>Venue</legend>
        <div className="battle-venue-row" role="radiogroup" aria-label="Stadium">
          {STADIUMS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={stadiumId === s.id}
              className={`battle-venue${stadiumId === s.id ? " active" : ""}`}
              onClick={() => setStadiumId(s.id)}
            >
              <span className="battle-venue-swatch" style={{ background: s.floor, borderColor: s.accent }} aria-hidden />
              <span className="battle-venue-name">{s.name}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <label htmlFor="b-title">What is the battle?</label>
      <input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Jollof vs Fried Rice" required minLength={3} maxLength={120} />

      <div className="battle-create-sides">
        <div>
          <label htmlFor="b-a">Side A</label>
          <input id="b-a" value={sideA} onChange={(e) => setSideA(e.target.value)} placeholder="Jollof" required maxLength={40} />
          <label className="battle-create-art">
            <input type="file" accept="image/*" hidden onChange={(e) => void pick("a", e.target.files?.[0])} />
            <CameraIcon width={15} height={15} />
            <span>{characterAUrl ? "Fighter added" : uploading === "a" ? "Uploading…" : "Add a fighter"}</span>
          </label>
          {characterAUrl && <img className="battle-create-preview" src={mediaSrc(characterAUrl)} alt="" />}
        </div>
        <div>
          <label htmlFor="b-b">Side B</label>
          <input id="b-b" value={sideB} onChange={(e) => setSideB(e.target.value)} placeholder="Fried Rice" required maxLength={40} />
          <label className="battle-create-art">
            <input type="file" accept="image/*" hidden onChange={(e) => void pick("b", e.target.files?.[0])} />
            <CameraIcon width={15} height={15} />
            <span>{characterBUrl ? "Fighter added" : uploading === "b" ? "Uploading…" : "Add a fighter"}</span>
          </label>
          {characterBUrl && <img className="battle-create-preview" src={mediaSrc(characterBUrl)} alt="" />}
        </div>
      </div>

      <fieldset className="battle-create-fieldset">
        <legend>Round</legend>
        <div className="battle-round-row" role="radiogroup" aria-label="Round length">
          {ROUNDS.map((r) => (
            <button
              key={r.seconds}
              type="button"
              role="radio"
              aria-checked={round === r.seconds}
              className={`battle-round${round === r.seconds ? " active" : ""}`}
              onClick={() => setRound(r.seconds)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="meta">The bell rings on its own when the clock runs out.</p>
      </fieldset>

      <label className="battle-create-art">
        <input type="file" accept="image/*" hidden onChange={(e) => void pick("image", e.target.files?.[0])} />
        <CameraIcon width={15} height={15} />
        <span>{imageUrl ? "Cover added" : uploading === "image" ? "Uploading…" : "Add cover art (optional)"}</span>
      </label>
      {imageUrl && <img className="battle-create-preview wide" src={mediaSrc(imageUrl)} alt="" />}

      <label htmlFor="b-topic">Context (optional)</label>
      <textarea id="b-topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={400} rows={2} />

      <label htmlFor="b-stake">Stake per backer in Vibe Yens (optional)</label>
      <input id="b-stake" type="number" min="0" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="0" />
      <p className="meta">Leave at 0 for a free battle. Voting is always free; a stake only decides what a winner takes.</p>

      {error && <div className="notice danger" role="alert">{error}</div>}
      <button className="btn primary block" type="submit" disabled={busy}>
        {busy ? "Opening…" : "Open the stadium"}
      </button>
    </form>
  );
}

/* ----------------------------------------------------------------- the arena */

interface Impact {
  id: number;
  side: "a" | "b";
  power: number;
  born: number;
}

export function BattleScreen({ battleId, onBack }: { battleId: string; viewerId: string; onBack: () => void }) {
  const [battle, setBattle] = useState<Battle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [attackSide, setAttackSide] = useState<"a" | "b">("a");
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const prevScore = useRef<{ a: number; b: number } | null>(null);
  const scoreRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ battle: Battle }>(`/v1/battles/${battleId}`);
      setBattle(res.battle);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the battle");
    }
  }, [battleId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The arena is live: a punch or a close lands here without a refresh.
  useRealtime((event) => {
    if (event.type === "battles.changed" && event.entityId === battleId) void load();
  });

  // Turn a score change into a visible hit, whichever side moved.
  useEffect(() => {
    if (!battle) return;
    const prior = prevScore.current;
    prevScore.current = { a: battle.score.a, b: battle.score.b };
    if (!prior) return;
    const da = battle.score.a - prior.a;
    const db = battle.score.b - prior.b;
    const now = Date.now();
    const fresh: Impact[] = [];
    if (da > 0) fresh.push({ id: now + Math.random(), side: "a", power: Math.min(1, da / 20), born: now });
    if (db > 0) fresh.push({ id: now + Math.random(), side: "b", power: Math.min(1, db / 20), born: now });
    if (fresh.length) setImpacts((list) => [...list, ...fresh]);
  }, [battle]);

  // Retire effects after their animation. Kept in one timer so a burst of
  // scoring does not leak a timer per punch.
  useEffect(() => {
    if (impacts.length === 0) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setImpacts((list) => list.filter((i) => now - i.born < 1200));
    }, 250);
    return () => window.clearInterval(id);
  }, [impacts.length]);

  const now = useNow(battle?.status === "open");

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ battle: Battle }>(`/v1/battles/${battleId}${path}`, {
        body,
        idempotencyKey: idempotencyKey("battleact"),
      });
      setBattle(res.battle);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work");
    } finally {
      setBusy(false);
    }
  }

  /** Throw a reaction at a side. The burst is the point: it should feel like a hit. */
  async function throwGift(side: "a" | "b", kind: string) {
    const id = Date.now() + Math.random();
    setImpacts((b) => [...b, { id, side, power: 0.4, born: Date.now() }]);
    await act("/gifts", { side, kind });
  }

  async function boost(side: "a" | "b", kind: BoostKind) {
    const id = Date.now() + Math.random();
    setImpacts((b) => [...b, { id, side, power: 1, born: Date.now() }]);
    await act("/boosts", { side, kind: kind.id });
  }

  async function attack() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    await act("/comments", { side: attackSide, body });
  }

  const arenaState = useMemo(() => {
    if (!battle) return null;
    const ms = timeLeft(battle.endsAt);
    const span = Math.max(1, battle.intervalSeconds * 1000);
    return {
      scoreA: battle.score.a,
      scoreB: battle.score.b,
      crowd: Math.min(48, battle.backing.a.backers + battle.backing.b.backers + battle.comments.length * 2),
      phase: 0,
      remaining: Math.min(1, ms / span),
      status: battle.status,
      winner: battle.winner,
      impacts: impacts.map((i) => ({ side: i.side, age: Math.min(1, (now - i.born) / 1200), power: i.power })),
    };
  }, [battle, impacts, now]);

  if (!battle) {
    return (
      <>
        <ScreenHeader eyebrow="Battles" title="Battle" action={<button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeftIcon width={20} height={20} /></button>} />
        {error ? <div className="notice danger" role="alert">{error}</div> : <div className="skeleton" aria-busy="true" style={{ height: 260 }} />}
      </>
    );
  }

  const total = battle.score.a + battle.score.b;
  const aPct = total === 0 ? 50 : Math.round((battle.score.a / total) * 100);
  const isOpen = battle.status === "open";
  const msLeft = timeLeft(battle.endsAt);
  const spec = stadium(battle.stadium);

  return (
    <div className="battles-flow battle-arena-flow">
      <ScreenHeader
        eyebrow={spec.name}
        title={battle.title}
        subtitle={battle.topic ?? undefined}
        action={<button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeftIcon width={20} height={20} /></button>}
      />

      {error && <div className="notice danger" role="alert">{error}</div>}

      <section className="battle-arena-shell" style={{ ["--arena-accent" as string]: spec.accent }}>
        <div className="battle-arena-render">
          <BattleCanvas
            kind="arena"
            stadiumId={battle.stadium}
            fighterAUrl={battle.characters.a ? mediaSrc(battle.characters.a) : null}
            fighterBUrl={battle.characters.b ? mediaSrc(battle.characters.b) : null}
            arena={arenaState ?? undefined}
            className="battle-arena-canvas"
            label={`${battle.sides.a} ${battle.score.a} points, ${battle.sides.b} ${battle.score.b} points`}
          />

          {/* The scoreboard sits over the render, so the fight and the numbers
              are one object rather than a picture above a table. */}
          <div className="battle-scoreboard" ref={scoreRef}>
            <button
              className={`battle-score-side side-a${battle.mySide === "a" ? " mine" : ""}${battle.winner === "a" ? " won" : ""}`}
              disabled={!isOpen || busy}
              onClick={() => void act("/join", { side: "a" })}
              aria-label={`Vote for ${battle.sides.a}`}
            >
              <span className="battle-score-name">{battle.sides.a}</span>
              <span className="battle-score-value">{battle.score.a}</span>
              <span className="battle-score-pct">{aPct}%</span>
            </button>

            <div className="battle-clock">
              {isOpen ? (
                <>
                  <span className="battle-clock-value">{clock(msLeft)}</span>
                  <span className="battle-clock-label">left</span>
                </>
              ) : (
                <span className="battle-clock-label">
                  {battle.status === "cancelled" ? "Cancelled" : battle.winner === "tie" ? "Draw" : "Final"}
                </span>
              )}
            </div>

            <button
              className={`battle-score-side side-b${battle.mySide === "b" ? " mine" : ""}${battle.winner === "b" ? " won" : ""}`}
              disabled={!isOpen || busy}
              onClick={() => void act("/join", { side: "b" })}
              aria-label={`Vote for ${battle.sides.b}`}
            >
              <span className="battle-score-name">{battle.sides.b}</span>
              <span className="battle-score-value">{battle.score.b}</span>
              <span className="battle-score-pct">{100 - aPct}%</span>
            </button>
          </div>
        </div>

        <div className="battle-arena-legend">
          <span>Vote {battle.tally.a}–{battle.tally.b} (free)</span>
          <span>{battle.backing.a.commenters + battle.backing.b.commenters} on the floor</span>
          <span>{battle.backing.a.boosts + battle.backing.b.boosts} boosts</span>
        </div>

        {battle.stakeMinor > 0 && (
          <div className="battle-pot">
            <TrophyIcon width={16} height={16} />
            <span>Pot {formatMoney(battle.potMinor, battle.currency)}</span>
            <span className="muted">· {formatMoney(battle.stakeMinor, battle.currency)} per backer · no platform cut</span>
          </div>
        )}

        {battle.myStakeMinor > 0 && (
          <p className="meta">
            You backed {battle.mySide === "a" ? battle.sides.a : battle.sides.b} with {formatMoney(battle.myStakeMinor, battle.currency)}.
            {battle.status === "open" && battle.myProjectedMinor > 0 && (
              <> If your side wins as the pot stands, you take {formatMoney(battle.myProjectedMinor, battle.currency)}.</>
            )}
            {battle.myPayoutMinor > 0 && ` You won ${formatMoney(battle.myPayoutMinor, battle.currency)}.`}
          </p>
        )}

        <div className="battle-venue-note">
          <span className="battle-venue-dot" style={{ background: spec.accent }} aria-hidden />
          <span>{spec.name}</span>
          <span className="muted">· {spec.blurb}</span>
        </div>
      </section>

      {/* The two ways to add noise: a free reaction, and a paid punch with a
          price on the button. The cost is stated before the tap, never after. */}
      {isOpen && (
        <section className="battle-moves">
          <div className="battle-moves-head">
            <h2 className="section-title">Throw something</h2>
            <span className="meta">Free reactions</span>
          </div>
          <div className="battle-react" role="group" aria-label="Throw a free reaction">
            {(["a", "b"] as const).map((s) => (
              <div key={s} className="battle-react-side">
                <span className="meta truncate">{battle.sides[s]}</span>
                <span className="battle-react-row">
                  {BATTLE_REACTIONS.map((r) => (
                    <button
                      key={r.id}
                      className={`battle-react-btn${battle.myGifts.includes(r.id) ? " sent" : ""}`}
                      disabled={busy}
                      onClick={() => void throwGift(s, r.id)}
                      aria-label={`Throw ${r.label} at ${battle.sides[s]}`}
                      title={battle.myGifts.includes(r.id) ? `You already threw ${r.label}` : `${r.label} · +2 points`}
                    >
                      {r.art}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <div className="battle-moves-head">
            <h2 className="section-title">Buy a punch</h2>
            <span className="meta">Vibe Yens · capped per person</span>
          </div>
          <div className="battle-boosts">
            {(["a", "b"] as const).map((s) => (
              <div key={s} className="battle-boost-side">
                <span className="battle-boost-side-name">{battle.sides[s]}</span>
                <div className="battle-boost-row">
                  {battle.boostCatalogue.map((b) => (
                    <button
                      key={b.id}
                      className="battle-boost"
                      disabled={busy}
                      onClick={() => void boost(s, b)}
                      aria-label={`${b.label} for ${battle.sides[s]}: ${formatMoney(b.priceMinor, battle.currency)}, plus ${b.points} points`}
                    >
                      <span className="battle-boost-label">{b.label}</span>
                      <span className="battle-boost-points">+{b.points}</span>
                      <span className="battle-boost-price">{formatMoney(b.priceMinor, battle.currency)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="row battle-actions" style={{ gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
        {isOpen && (
          <button className="btn" disabled={busy} onClick={() => void act("/vote", { side: battle.mySide === "a" ? "b" : "a" })}>
            {battle.mySide ? "Switch my vote" : "Vote"}
          </button>
        )}
        {isOpen && <button className="btn" disabled={busy} onClick={() => void act("/close")}>Close and settle</button>}
        {isOpen && <button className="btn ghost" disabled={busy} onClick={() => void act("/cancel")}>Cancel</button>}
      </div>

      {/* The floor. Every comment is an attack; it names the side it backs. */}
      <section className="shelf">
        <div className="shelf-head">
          <h2 className="section-title"><SplitIcon width={16} height={16} /> The floor</h2>
          <span className="meta">{battle.comments.length} {battle.comments.length === 1 ? "attack" : "attacks"}</span>
        </div>

        {isOpen && (
          <div className="battle-attack">
            <div className="battle-attack-pick" role="group" aria-label="Attack which side">
              {(["a", "b"] as const).map((s) => (
                <button
                  key={s}
                  className={`battle-attack-side${attackSide === s ? " active" : ""}`}
                  onClick={() => setAttackSide(s)}
                  aria-pressed={attackSide === s}
                >
                  {battle.sides[s]}
                </button>
              ))}
            </div>
            <div className="composer">
              <input
                className="input"
                value={draft}
                placeholder={`Attack ${battle.sides[attackSide]}`}
                aria-label="Attack comment"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void attack(); }}
                maxLength={400}
              />
              <button className="btn small primary" disabled={busy || !draft.trim()} onClick={() => void attack()}>Send</button>
            </div>
          </div>
        )}

        <ul className="battle-feed">
          {battle.comments.map((c) => (
            <li key={c.id} className={`battle-comment side-${c.side}`}>
              <Avatar name={c.author.displayName} url={c.author.avatarUrl} seed={c.author.id} size="sm" />
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="meta row" style={{ gap: 6 }}>
                  <strong>{c.author.displayName}</strong>
                  <span className={`battle-comment-tag tag-${c.side}`}>{battle.sides[c.side]}</span>
                </span>
                <p>{c.body}</p>
              </span>
            </li>
          ))}
          {battle.comments.length === 0 && <li className="empty"><p>No attacks yet. Be the first to swing.</p></li>}
        </ul>
      </section>

      <section className="shelf">
        <div className="shelf-head">
          <h2 className="section-title"><UsersIcon width={16} height={16} /> Backing</h2>
        </div>
        <div className="battle-backing">
          <div className="battle-backing-col">
            <span className="battle-backing-label">{battle.sides.a}</span>
            <span className="meta">{battle.backing.a.backers} backers · {formatMoney(battle.backing.a.stakedMinor, battle.currency)}</span>
          </div>
          <div className="battle-backing-col">
            <span className="battle-backing-label">{battle.sides.b}</span>
            <span className="meta">{battle.backing.b.backers} backers · {formatMoney(battle.backing.b.stakedMinor, battle.currency)}</span>
          </div>
        </div>
        {battle.backers.length > 0 && (
          <div className="battle-faces" aria-label="People in this battle">
            {battle.backers.map((b) => (
              <span key={b.user.id} className={`battle-face${b.staked ? " staked" : ""}`} title={b.user.displayName}>
                <Avatar name={b.user.displayName} url={b.user.avatarUrl} seed={b.user.id} size="sm" />
              </span>
            ))}
            {battle.backing.a.backers + battle.backing.b.backers > battle.backers.length && (
              <span className="meta battle-faces-more">+{battle.backing.a.backers + battle.backing.b.backers - battle.backers.length} more</span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
