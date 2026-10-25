import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ScreenHeader } from "../components/ScreenHeader";
import { Avatar } from "../components/Avatar";
import { useNav } from "../nav";
import { ArrowLeftIcon, CheckIcon, FlameIcon, SparklesIcon, TrophyIcon } from "../components/Icons";
import { formatMoney } from "../money";

/**
 * Status: who you are in the crowd, and how you look.
 *
 * The standing is earned (a title derived from this week's activity) and the
 * look is bought (a frame or an outfit, paid for with Vibe Yens). The screen
 * says both plainly, because the whole point is that status is visible: the
 * title is a claim you did not make, and the frame is a receipt.
 */

interface Standing {
  title: string | null;
  reason: string;
  holders: number;
  activity: number;
  rank: string | null;
  privileges: {
    postsPerDay: number;
    groupCap: number;
    giftCapMinor: number;
    rakeBps: number;
    featuredProfile: boolean;
    goldNameplate: boolean;
    roomTheme: "default" | "accent" | "luxe";
  };
  next: { title: string; at: number; gains: string[] } | null;
}

interface Cosmetic {
  id: string;
  kind: "frame" | "outfit";
  label: string;
  hint: string;
  style: string;
  priceMinor: number;
  currency: string;
  owned: boolean;
  worn: boolean;
  /** The holder's number in a limited run, or null for an open cosmetic. */
  serial: number | null;
  editionSize: number | null;
  /** Copies left in a limited run, or null when the cosmetic is unlimited. */
  remaining: number | null;
}

interface WornCosmetic {
  id: string;
  kind: "frame" | "outfit";
  label: string;
  style: string;
  serial: number | null;
  editionSize: number | null;
}

interface BoardEntry {
  user: { id: string; handle: string; displayName: string; avatarUrl: string | null };
  activity: number;
  standing: { title: string; rank: string } | null;
  look: { frame: WornCosmetic | null; outfit: WornCosmetic | null };
}

/** "No. 7 of 100", or nothing for an unlimited cosmetic. */
const editionLine = (c: { serial: number | null; editionSize: number | null } | null | undefined) =>
  c?.serial && c.editionSize ? `No. ${c.serial} of ${c.editionSize}` : null;

/** The line under a cosmetic tile: what it costs, or what you hold. */
function cosmeticMeta(c: Cosmetic): string {
  if (c.owned) {
    const line = editionLine(c);
    return `${c.worn ? "Worn" : "Tap to wear"}${line ? ` · ${line}` : ""}`;
  }
  if (c.remaining === 0) return "Sold out";
  if (c.remaining !== null && c.editionSize) {
    return `${formatMoney(c.priceMinor, c.currency)} · ${c.remaining} left`;
  }
  return formatMoney(c.priceMinor, c.currency);
}

export function StatusScreen({ onBack }: { onBack: () => void }) {
  const nav = useNav();
  const [standing, setStanding] = useState<Standing | null>(null);
  const [cosmetics, setCosmetics] = useState<Cosmetic[]>([]);
  const [worn, setWorn] = useState<{ frame: string | null; outfit: string | null }>({ frame: null, outfit: null });
  const [board, setBoard] = useState<BoardEntry[]>([]);
  const [balanceMinor, setBalanceMinor] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c, b, w] = await Promise.all([
        api<{ standing: Standing }>("/v1/me/standing"),
        api<{ cosmetics: Cosmetic[]; worn: { frame: string | null; outfit: string | null } }>("/v1/cosmetics"),
        api<{ board: BoardEntry[] }>("/v1/status/board"),
        api<{ balanceMinor: number }>("/v1/wallet").catch(() => ({ balanceMinor: 0 })),
      ]);
      setStanding(s.standing);
      setCosmetics(c.cosmetics);
      setWorn(c.worn);
      setBoard(b.board);
      setBalanceMinor(w.balanceMinor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your status");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function buy(c: Cosmetic) {
    setBusy(c.id);
    setError(null);
    setMessage(null);
    try {
      await api(`/v1/cosmetics/${c.id}/buy`, { method: "POST", body: {} });
      setMessage(`${c.label} is yours.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not buy that");
    } finally {
      setBusy(null);
    }
  }

  async function wear(c: Cosmetic) {
    setBusy(c.id);
    setError(null);
    setMessage(null);
    try {
      await api("/v1/cosmetics/wear", {
        method: "POST",
        body: { kind: c.kind, cosmeticId: c.worn ? null : c.id },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change your look");
    } finally {
      setBusy(null);
    }
  }

  const frames = cosmetics.filter((c) => c.kind === "frame");
  const outfits = cosmetics.filter((c) => c.kind === "outfit");

  return (
    <div className="status-flow">
      <ScreenHeader
        eyebrow="Identity"
        title="Your standing"
        action={<button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeftIcon width={20} height={20} /></button>}
      />

      {error && <div className="notice danger" role="alert">{error}</div>}
      {message && <div className="notice row" style={{ gap: 6 }}><CheckIcon width={14} height={14} /> {message}</div>}

      <section className={`status-hero${standing?.rank ? ` rank-${standing.rank}` : ""}`}>
        <div className="status-hero-face">
          <Avatar name="You" seed="you" size="lg" />
          {worn.frame && <span className={`status-frame style-${cosmetics.find((c) => c.id === worn.frame)?.style ?? "ember"}`} aria-hidden />}
        </div>
        <div className="status-hero-text">
          <span className="status-title">{standing?.title ?? "No title yet"}</span>
          <span className="meta">{standing?.reason ?? ""}</span>
          {standing && standing.activity > 0 && (
            <span className="meta">{standing.activity} this week{standing.holders > 0 ? ` · ${standing.holders} hold this` : ""}</span>
          )}
          {(() => {
            const framed = cosmetics.find((c) => c.id === worn.frame) ?? null;
            const line = editionLine(framed);
            return line ? <span className="status-edition">{framed?.label} · {line}</span> : null;
          })()}
        </div>
      </section>

      {/* What the rank actually gets you. A title with no consequences is a
          word; this is the part that makes the ladder worth climbing. */}
      {standing && (
        <section className="shelf">
          <div className="shelf-head">
            <h2 className="section-title"><FlameIcon width={16} height={16} /> What your standing unlocks</h2>
          </div>
          <div className="privilege-grid">
            <div className="privilege">
              <span className="privilege-value">{standing.privileges.postsPerDay}</span>
              <span className="privilege-label">posts a day</span>
            </div>
            <div className="privilege">
              <span className="privilege-value">{standing.privileges.groupCap}</span>
              <span className="privilege-label">people per room</span>
            </div>
            <div className="privilege">
              <span className="privilege-value">{formatMoney(standing.privileges.giftCapMinor, "NGN")}</span>
              <span className="privilege-label">largest single gift</span>
            </div>
            <div className="privilege">
              <span className="privilege-value">{(standing.privileges.rakeBps / 100).toFixed(1)}%</span>
              <span className="privilege-label">take on hosted games</span>
            </div>
            {standing.privileges.featuredProfile && (
              <div className="privilege is-on">
                <span className="privilege-value"><SparklesIcon width={16} height={16} /></span>
                <span className="privilege-label">featured in discovery</span>
              </div>
            )}
            {standing.privileges.goldNameplate && (
              <div className="privilege is-on">
                <span className="privilege-value privilege-gold">Aa</span>
                <span className="privilege-label">gold nameplate</span>
              </div>
            )}
            {standing.privileges.roomTheme !== "default" && (
              <div className="privilege is-on">
                <span className="privilege-value" style={{ textTransform: "capitalize" }}>{standing.privileges.roomTheme}</span>
                <span className="privilege-label">room theme</span>
              </div>
            )}
          </div>
          {standing.next && (
            <div className="privilege-next">
              <span className="privilege-next-title">
                Next: <b>{standing.next.title}</b> at {standing.next.at} this week
              </span>
              <span className="meta">{standing.next.gains.join(" · ")}</span>
              <span className="privilege-progress" aria-hidden="true">
                <span
                  className="privilege-progress-fill"
                  style={{ width: `${Math.min(100, Math.round((standing.activity / Math.max(1, standing.next.at)) * 100))}%` }}
                />
              </span>
            </div>
          )}
        </section>
      )}

      <section className="shelf">
        <div className="shelf-head">
          <h2 className="section-title"><TrophyIcon width={16} height={16} /> Who is who this week</h2>
        </div>
        <ul className="status-board">
          {board.map((e, i) => (
            <li key={e.user.id} className={`status-row${i === 0 ? " king" : i === 1 ? " queen" : ""}`}>
              <span className="status-rank">{i + 1}</span>
              <span className="status-row-face">
                <Avatar name={e.user.displayName} url={e.user.avatarUrl} seed={e.user.id} size="sm" />
                {e.look.frame && <span className={`status-frame style-${e.look.frame.style}`} aria-hidden />}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="truncate" style={{ display: "block", fontWeight: 600 }}>{e.user.displayName}</span>
                <span className="meta truncate" style={{ display: "block" }}>
                  @{e.user.handle}
                  {e.standing ? ` · ${e.standing.title}` : ""}
                  {editionLine(e.look.frame) ? ` · ${editionLine(e.look.frame)}` : ""}
                </span>
              </span>
              <span className="meta">{e.activity}</span>
            </li>
          ))}
          {board.length === 0 && <li className="empty"><p>No one has moved yet this week.</p></li>}
        </ul>
      </section>

      <section className="shelf">
        <div className="shelf-head">
          <h2 className="section-title">Frames</h2>
          {balanceMinor !== null && <span className="meta">{formatMoney(balanceMinor, "NGN")}</span>}
        </div>
        <div className="cosmetic-grid">
          {frames.map((c) => (
            <button key={c.id} className={`cosmetic-card${c.owned ? " owned" : ""}${c.worn ? " worn" : ""}`} disabled={busy === c.id || (!c.owned && c.remaining === 0)} onClick={() => (c.owned ? void wear(c) : void buy(c))}>
              <span className={`cosmetic-swatch status-frame style-${c.style}`} aria-hidden />
              <span className="cosmetic-label">{c.label}</span>
              <span className="meta">{cosmeticMeta(c)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="shelf">
        <div className="shelf-head"><h2 className="section-title">Outfits</h2></div>
        <div className="cosmetic-grid">
          {outfits.map((c) => (
            <button key={c.id} className={`cosmetic-card${c.owned ? " owned" : ""}${c.worn ? " worn" : ""}`} disabled={busy === c.id || (!c.owned && c.remaining === 0)} onClick={() => (c.owned ? void wear(c) : void buy(c))}>
              <span className={`cosmetic-swatch outfit style-${c.style}`} aria-hidden />
              <span className="cosmetic-label">{c.label}</span>
              <span className="meta">{cosmeticMeta(c)}</span>
            </button>
          ))}
        </div>
      </section>

      <button className="btn block ghost" onClick={() => nav.push({ name: "vibe-yens" })}>
        Top up Vibe Yens
      </button>
    </div>
  );
}
