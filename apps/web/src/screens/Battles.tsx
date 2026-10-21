import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey, mediaSrc } from "../api";
import { uploadImageFile } from "../media";
import { ScreenHeader } from "../components/ScreenHeader";
import { PlaySegments } from "../components/PlaySegments";
import { formatMoney, toMinorUnits } from "../money";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { useNav } from "../nav";
import { ArrowLeftIcon, CameraIcon, SplitIcon, TrophyIcon, UsersIcon } from "../components/Icons";

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
  imageUrl: string | null;
  characters: { a: string | null; b: string | null };
  status: "open" | "closed" | "cancelled";
  winner: "a" | "b" | "tie" | null;
  stakeMinor: number;
  currency: string;
  potMinor: number;
  endsAt: string | null;
  createdAt: string;
  tally: { a: number; b: number };
  score: { a: number; b: number };
  backing: { a: SideBacking; b: SideBacking };
  host: { id: string; handle: string; displayName: string; avatarUrl: string | null } | null;
  mySide: "a" | "b" | null;
  myStakeMinor: number;
  myPayoutMinor: number;
  myProjectedMinor: number;
  myGifts: string[];
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
  const total = battle.score.a + battle.score.b;
  const aPct = total === 0 ? 50 : Math.round((battle.score.a / total) * 100);
  return (
    <div className="battle-bar" role="img" aria-label={`${battle.sides.a} ${battle.score.a} points, ${battle.sides.b} ${battle.score.b} points`}>
      <span className="battle-bar-a" style={{ width: `${aPct}%` }} />
      <span className="battle-bar-b" style={{ width: `${100 - aPct}%` }} />
    </div>
  );
}

function BattleCard({ battle, onOpen }: { battle: Battle; onOpen: () => void }) {
  const left = timeLeft(battle.endsAt);
  const total = battle.score.a + battle.score.b;
  return (
    <button className={`battle-card${battle.status === "open" ? " is-open" : ""}`} onClick={onOpen}>
      {battle.imageUrl && (
        <span className="battle-card-art">
          <img src={mediaSrc(battle.imageUrl)} alt="" loading="lazy" />
          {battle.characters.a && <img className="battle-card-char char-a" src={mediaSrc(battle.characters.a)} alt="" loading="lazy" />}
          {battle.characters.b && <img className="battle-card-char char-b" src={mediaSrc(battle.characters.b)} alt="" loading="lazy" />}
        </span>
      )}
      <div className="battle-card-head">
        <span className="battle-card-vs">
          <span className="battle-card-side">{battle.sides.a}</span>
          <em>vs</em>
          <span className="battle-card-side">{battle.sides.b}</span>
        </span>
        {battle.status === "open" && (
          <span className="battle-card-status">
            <span className="live-dot playing" aria-hidden /> {left ?? "open"}
          </span>
        )}
        {battle.status === "closed" && battle.winner && (
          <span className="chip chip-gold">
            {battle.winner === "tie" ? "Tie" : `${battle.winner === "a" ? battle.sides.a : battle.sides.b} won`}
          </span>
        )}
        {battle.status === "cancelled" && <span className="chip">Cancelled</span>}
      </div>
      <h3 className="battle-card-title">{battle.title}</h3>
      {battle.topic && <p className="battle-card-topic">{battle.topic}</p>}
      <SideBar battle={battle} />
      <div className="battle-card-foot">
        <span className="meta">{total} points</span>
        {battle.comments.length > 0 && (
          <span className="meta">{battle.comments.length} {battle.comments.length === 1 ? "attack" : "attacks"}</span>
        )}
        {battle.stakeMinor > 0 && (
          <span className="chip chip-gold">Pot {formatMoney(battle.potMinor, battle.currency)}</span>
        )}
      </div>
    </button>
  );
}

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

  const open = battles.filter((b) => b.status === "open");
  const past = battles.filter((b) => b.status !== "open");

  return (
    <div className="battles-flow">
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

      {onOpenGames && <PlaySegments active="battles" onChange={(s) => { if (s === "games") onOpenGames(); }} />}

      {error && <div className="notice danger" role="alert">{error}</div>}

      <button className="btn primary block" onClick={() => setCreating((v) => !v)}>
        <SplitIcon width={17} height={17} /> {creating ? "Close" : "Start a battle"}
      </button>

      {creating && <CreateBattle onCreated={() => { setCreating(false); void load(); }} />}

      {loading ? (
        <div className="skeleton" aria-busy="true" style={{ height: 120 }} />
      ) : (
        <>
          <section className="shelf">
            <div className="shelf-head">
              <h2 className="section-title"><TrophyIcon width={16} height={16} /> Open now</h2>
              {open.length > 0 && <span className="meta">{open.length}</span>}
            </div>
            {open.length === 0 ? (
              <EmptyState icon={<SplitIcon />} title="No battles yet" text="Start one above and let people pick a side." />
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

function CreateBattle({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [sideA, setSideA] = useState("");
  const [sideB, setSideB] = useState("");
  const [topic, setTopic] = useState("");
  const [stake, setStake] = useState("");
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
          title, sideA, sideB, topic: topic || undefined, stakeMinor,
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

  return (
    <form className="battle-create" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor="b-title">What is the battle?</label>
      <input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Jollof vs Fried Rice" required minLength={3} maxLength={120} />

      <div className="battle-create-sides">
        <div>
          <label htmlFor="b-a">Side A</label>
          <input id="b-a" value={sideA} onChange={(e) => setSideA(e.target.value)} placeholder="Jollof" required maxLength={40} />
          <label className="battle-create-art">
            <input type="file" accept="image/*" hidden onChange={(e) => void pick("a", e.target.files?.[0])} />
            <CameraIcon width={15} height={15} />
            <span>{characterAUrl ? "Character added" : uploading === "a" ? "Uploading…" : "Add a character"}</span>
          </label>
          {characterAUrl && <img className="battle-create-preview" src={mediaSrc(characterAUrl)} alt="" />}
        </div>
        <div>
          <label htmlFor="b-b">Side B</label>
          <input id="b-b" value={sideB} onChange={(e) => setSideB(e.target.value)} placeholder="Fried Rice" required maxLength={40} />
          <label className="battle-create-art">
            <input type="file" accept="image/*" hidden onChange={(e) => void pick("b", e.target.files?.[0])} />
            <CameraIcon width={15} height={15} />
            <span>{characterBUrl ? "Character added" : uploading === "b" ? "Uploading…" : "Add a character"}</span>
          </label>
          {characterBUrl && <img className="battle-create-preview" src={mediaSrc(characterBUrl)} alt="" />}
        </div>
      </div>

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
        {busy ? "Creating…" : "Create battle"}
      </button>
    </form>
  );
}

export function BattleScreen({ battleId, onBack }: { battleId: string; viewerId: string; onBack: () => void }) {
  const [battle, setBattle] = useState<Battle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [attackSide, setAttackSide] = useState<"a" | "b">("a");
  const [bursts, setBursts] = useState<Array<{ id: number; art: string; side: "a" | "b" }>>([]);

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

  /** Throw a reaction at a side. The burst is the point: it should feel like a hit. */
  async function throwGift(side: "a" | "b", kind: string, art: string) {
    const id = Date.now() + Math.random();
    setBursts((b) => [...b, { id, art, side }]);
    setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 900);
    await act("/gifts", { side, kind });
  }

  async function attack() {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    await act("/comments", { side: attackSide, body });
  }

  if (!battle) {
    return (
      <>
        <ScreenHeader eyebrow="Battles" title="Battle" action={<button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeftIcon width={20} height={20} /></button>} />
        {error ? <div className="notice danger" role="alert">{error}</div> : <div className="skeleton" aria-busy="true" style={{ height: 200 }} />}
      </>
    );
  }

  const total = battle.score.a + battle.score.b;
  const aPct = total === 0 ? 50 : Math.round((battle.score.a / total) * 100);
  const isOpen = battle.status === "open";

  return (
    <div className="battles-flow">
      <ScreenHeader
        eyebrow="Battle"
        title={battle.title}
        subtitle={battle.topic ?? undefined}
        action={<button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeftIcon width={20} height={20} /></button>}
      />

      {error && <div className="notice danger" role="alert">{error}</div>}

      <section className="battle-stage">
        {battle.imageUrl && (
          <div className="battle-arena">
            <img className="battle-arena-art" src={mediaSrc(battle.imageUrl)} alt="" loading="lazy" />
            {(["a", "b"] as const).map((s) => (
              <span key={s} className={`battle-fighter fighter-${s}`}>
                {battle.characters[s] && <img className="battle-fighter-art" src={mediaSrc(battle.characters[s]!)} alt="" loading="lazy" />}
                <span className="battle-fighter-name">{battle.sides[s]}</span>
              </span>
            ))}
          </div>
        )}

        <div className="battle-stage-sides">
          <button
            className={`battle-side${battle.mySide === "a" ? " mine" : ""}${battle.winner === "a" ? " won" : ""}`}
            disabled={!isOpen || busy}
            onClick={() => void act("/join", { side: "a" })}
          >
            <span className="battle-side-name">{battle.sides.a}</span>
            <span className="battle-side-votes">{battle.score.a}</span>
            <span className="battle-side-pct">{aPct}%</span>
          </button>
          <span className="battle-stage-vs">vs</span>
          <button
            className={`battle-side${battle.mySide === "b" ? " mine" : ""}${battle.winner === "b" ? " won" : ""}`}
            disabled={!isOpen || busy}
            onClick={() => void act("/join", { side: "b" })}
          >
            <span className="battle-side-name">{battle.sides.b}</span>
            <span className="battle-side-votes">{battle.score.b}</span>
            <span className="battle-side-pct">{100 - aPct}%</span>
          </button>
        </div>

        <p className="meta battle-score-legend">
          Score = votes ({battle.tally.a}–{battle.tally.b}) + attacks + reactions. Every comment and reaction adds to the side it backs.
        </p>

        {/* Reactions, thrown at a side. Free, like a post gift. */}
        {isOpen && (
          <div className="battle-react" role="group" aria-label="Throw a reaction">
            {(["a", "b"] as const).map((s) => (
              <div key={s} className="battle-react-side">
                <span className="meta truncate">{battle.sides[s]}</span>
                <span className="battle-react-row">
                  {BATTLE_REACTIONS.map((r) => (
                    <button
                      key={r.id}
                      className={`battle-react-btn${battle.myGifts.includes(r.id) ? " sent" : ""}`}
                      disabled={busy}
                      onClick={() => void throwGift(s, r.id, r.art)}
                      aria-label={`Throw ${r.label} at ${battle.sides[s]}`}
                      title={battle.myGifts.includes(r.id) ? `You already threw ${r.label}` : r.label}
                    >
                      {r.art}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Bursts fly toward the side they hit. */}
        <div className="battle-burst-layer" aria-hidden="true">
          {bursts.map((b) => (
            <span key={b.id} className={`battle-burst burst-${b.side}`}>{b.art}</span>
          ))}
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

      {/* The comment feed. This is the audience: every comment is an attack, and
          it lands on the side the commenter picked. */}
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
