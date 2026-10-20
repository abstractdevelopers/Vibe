import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { ScreenHeader } from "../components/ScreenHeader";
import { formatMoney } from "../money";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { useNav } from "../nav";
import { ArrowLeftIcon, SplitIcon, TrophyIcon, UsersIcon } from "../components/Icons";

/**
 * Brand Battles.
 *
 * A battle is a contest between two sides where the crowd picks the winner.
 * Voting is free and is the score; staking is optional and never buys a vote.
 * The screen says that plainly, because a battle that looked like a betting
 * market would be a different product.
 */

interface SideBacking {
  side: "a" | "b";
  votes: number;
  backers: number;
  stakedMinor: number;
}

interface Battle {
  id: string;
  title: string;
  topic: string | null;
  sides: { a: string; b: string };
  status: "open" | "closed" | "cancelled";
  winner: "a" | "b" | "tie" | null;
  stakeMinor: number;
  currency: string;
  potMinor: number;
  endsAt: string | null;
  createdAt: string;
  tally: { a: number; b: number };
  backing: { a: SideBacking; b: SideBacking };
  host: { id: string; handle: string; displayName: string; avatarUrl: string | null } | null;
  mySide: "a" | "b" | null;
  myStakeMinor: number;
  myPayoutMinor: number;
  myProjectedMinor: number;
  backers: Array<{ side: "a" | "b"; staked: boolean; user: { id: string; handle: string; displayName: string; avatarUrl: string | null } }>;
}


function timeLeft(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "ended";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

function SideBar({ battle }: { battle: Battle }) {
  const total = battle.tally.a + battle.tally.b;
  const aPct = total === 0 ? 50 : Math.round((battle.tally.a / total) * 100);
  return (
    <div className="battle-bar" role="img" aria-label={`${battle.sides.a} ${battle.tally.a}, ${battle.sides.b} ${battle.tally.b}`}>
      <span className="battle-bar-a" style={{ width: `${aPct}%` }} />
      <span className="battle-bar-b" style={{ width: `${100 - aPct}%` }} />
    </div>
  );
}

function BattleCard({ battle, onOpen }: { battle: Battle; onOpen: () => void }) {
  const left = timeLeft(battle.endsAt);
  return (
    <button className="battle-card" onClick={onOpen}>
      <div className="battle-card-head">
        <span className="battle-vs">{battle.sides.a} <em>vs</em> {battle.sides.b}</span>
        {battle.status === "open" && left && <span className="chip">{left}</span>}
        {battle.status === "closed" && battle.winner && (
          <span className="chip chip-gold">
            {battle.winner === "tie" ? "Tie" : `${battle.winner === "a" ? battle.sides.a : battle.sides.b} won`}
          </span>
        )}
        {battle.status === "cancelled" && <span className="chip">Cancelled</span>}
      </div>
      <h3 className="battle-card-title">{battle.title}</h3>
      {battle.topic && <p className="muted battle-card-topic">{battle.topic}</p>}
      <SideBar battle={battle} />
      <div className="battle-card-foot">
        <span className="muted">{battle.tally.a + battle.tally.b} votes</span>
        {battle.stakeMinor > 0 && (
          <span className="chip chip-gold">Pot {formatMoney(battle.potMinor, battle.currency)}</span>
        )}
      </div>
    </button>
  );
}

export function BattlesScreen({ onBack }: { onBack?: () => void }) {
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

  const open = battles.filter((b) => b.status === "open");
  const past = battles.filter((b) => b.status !== "open");

  return (
    <>
      <ScreenHeader
        eyebrow="Play"
        title="Battles"
        subtitle="Two sides, one crowd. Vote for the side you back — free, always."
        action={
          onBack ? (
            <button className="icon-button" aria-label="Back" onClick={onBack}>
              <ArrowLeftIcon width={20} height={20} />
            </button>
          ) : undefined
        }
      />

      {error && <div className="notice danger" role="alert">{error}</div>}

      <button className="btn primary block" onClick={() => setCreating((v) => !v)}>
        <SplitIcon width={17} height={17} /> {creating ? "Close" : "Start a battle"}
      </button>

      {creating && <CreateBattle onCreated={() => { setCreating(false); void load(); }} />}

      {loading ? (
        <div className="skeleton" aria-busy="true" style={{ height: 120, marginTop: "var(--space-5)" }} />
      ) : (
        <>
          <section className="stack" style={{ marginTop: "var(--space-6)" }}>
            <h2 className="section-title"><TrophyIcon width={16} height={16} /> Open now</h2>
            {open.length === 0 ? (
              <EmptyState icon={<SplitIcon />} title="No battles yet" text="Start one above and let people pick a side." />
            ) : (
              open.map((b) => <BattleCard key={b.id} battle={b} onOpen={() => nav.push({ name: "battle", battleId: b.id })} />)
            )}
          </section>

          {past.length > 0 && (
            <section className="stack" style={{ marginTop: "var(--space-6)" }}>
              <h2 className="section-title">Finished</h2>
              {past.map((b) => <BattleCard key={b.id} battle={b} onOpen={() => nav.push({ name: "battle", battleId: b.id })} />)}
            </section>
          )}
        </>
      )}
    </>
  );
}

function CreateBattle({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [sideA, setSideA] = useState("");
  const [sideB, setSideB] = useState("");
  const [topic, setTopic] = useState("");
  const [stake, setStake] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const stakeMinor = stake ? Math.round(Number(stake) * 100) : 0;
      await api("/v1/battles", {
        body: { title, sideA, sideB, topic: topic || undefined, stakeMinor },
        idempotencyKey: idempotencyKey("battle"),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the battle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="battle-create" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor="b-title">What is the battle?</label>
      <input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Jollof vs Fried Rice" required minLength={3} maxLength={120} />

      <div className="battle-create-sides">
        <div>
          <label htmlFor="b-a">Side A</label>
          <input id="b-a" value={sideA} onChange={(e) => setSideA(e.target.value)} placeholder="Jollof" required maxLength={40} />
        </div>
        <div>
          <label htmlFor="b-b">Side B</label>
          <input id="b-b" value={sideB} onChange={(e) => setSideB(e.target.value)} placeholder="Fried Rice" required maxLength={40} />
        </div>
      </div>

      <label htmlFor="b-topic">Context (optional)</label>
      <textarea id="b-topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={400} rows={2} />

      <label htmlFor="b-stake">Stake per backer in Vibe Yens (optional)</label>
      <input id="b-stake" type="number" min="0" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="0" />
      <p className="meta">Leave at 0 for a free battle. Voting is always free; a stake only decides what a winner takes.</p>

      {error && <div className="notice danger" role="alert">{error}</div>}
      <button className="btn primary block" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create battle"}
      </button>
    </form>
  );
}

export function BattleScreen({ battleId, onBack }: { battleId: string; viewerId: string; onBack: () => void }) {
  const [battle, setBattle] = useState<Battle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ battle: Battle }>(`/v1/battles/${battleId}`);
      setBattle(res.battle);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the battle");
    }
  }, [battleId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (!battle) {
    return (
      <>
        <ScreenHeader eyebrow="Battles" title="Battle" action={<button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeftIcon width={20} height={20} /></button>} />
        {error ? <div className="notice danger" role="alert">{error}</div> : <div className="skeleton" aria-busy="true" style={{ height: 200 }} />}
      </>
    );
  }

  const total = battle.tally.a + battle.tally.b;
  const aPct = total === 0 ? 50 : Math.round((battle.tally.a / total) * 100);
  const isOpen = battle.status === "open";

  return (
    <>
      <ScreenHeader
        eyebrow="Battle"
        title={battle.title}
        subtitle={battle.topic ?? undefined}
        action={<button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeftIcon width={20} height={20} /></button>}
      />

      {error && <div className="notice danger" role="alert">{error}</div>}

      <section className="battle-stage">
        <div className="battle-stage-sides">
          <button
            className={`battle-side${battle.mySide === "a" ? " mine" : ""}${battle.winner === "a" ? " won" : ""}`}
            disabled={!isOpen || busy}
            onClick={() => void act("/join", { side: "a" })}
          >
            <span className="battle-side-name">{battle.sides.a}</span>
            <span className="battle-side-votes">{battle.tally.a}</span>
            <span className="battle-side-pct">{aPct}%</span>
          </button>
          <span className="battle-stage-vs">vs</span>
          <button
            className={`battle-side${battle.mySide === "b" ? " mine" : ""}${battle.winner === "b" ? " won" : ""}`}
            disabled={!isOpen || busy}
            onClick={() => void act("/join", { side: "b" })}
          >
            <span className="battle-side-name">{battle.sides.b}</span>
            <span className="battle-side-votes">{battle.tally.b}</span>
            <span className="battle-side-pct">{100 - aPct}%</span>
          </button>
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

        <div className="row" style={{ gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
          {isOpen && (
            <button className="btn" disabled={busy} onClick={() => void act("/vote", { side: battle.mySide === "a" ? "b" : "a" })}>
              {battle.mySide ? `Switch my vote` : "Vote"}
            </button>
          )}
          {isOpen && <button className="btn" disabled={busy} onClick={() => void act("/close")}>Close and settle</button>}
          {isOpen && <button className="btn ghost" disabled={busy} onClick={() => void act("/cancel")}>Cancel</button>}
        </div>
      </section>

      <section className="stack" style={{ marginTop: "var(--space-6)" }}>
        <h2 className="section-title"><UsersIcon width={16} height={16} /> Backing</h2>
        <div className="battle-backing">
          <div className="battle-backing-col">
            <span className="battle-backing-label">{battle.sides.a}</span>
            <span className="muted">{battle.backing.a.backers} backers · {formatMoney(battle.backing.a.stakedMinor, battle.currency)}</span>
          </div>
          <div className="battle-backing-col">
            <span className="battle-backing-label">{battle.sides.b}</span>
            <span className="muted">{battle.backing.b.backers} backers · {formatMoney(battle.backing.b.stakedMinor, battle.currency)}</span>
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
              <span className="muted battle-faces-more">+{battle.backing.a.backers + battle.backing.b.backers - battle.backers.length} more</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
