import { useState } from "react";
import { api, ApiError } from "../api";
import { LinkIcon, MicIcon, MusicIcon, FilmIcon, GoalIcon, RadioIcon, TicketIcon, ClockIcon } from "./Icons";
import type { Room } from "./RoomStudio";

/**
 * Per-kind room chrome.
 *
 * Every kind shares one transport, so what makes a match room feel different
 * from a listening party is not the plumbing — it is what is on the screen. These
 * panels give each kind the one thing its audience came for: a scoreboard for a
 * match, a queue for a listening room, a licensed-service link for a watch party.
 */

export interface KindMeta {
  label: string;
  tagline: string;
  Icon: typeof MicIcon;
  /** What the audience does here, shown as a one-line hint. */
  audienceHint: string;
}

export const ROOM_KINDS: Record<Room["kind"], KindMeta> = {
  voice: { label: "Voice room", tagline: "Open mic — join the stage and talk.", Icon: MicIcon, audienceHint: "Raise a hand to speak" },
  listen: { label: "Listening party", tagline: "The host plays; everyone listens together.", Icon: MusicIcon, audienceHint: "Listening to the host's set" },
  music: { label: "Music room", tagline: "Talk around a set or an album.", Icon: MusicIcon, audienceHint: "Chatting around the music" },
  movie: { label: "Watch party", tagline: "Watch on a licensed service; talk here.", Icon: FilmIcon, audienceHint: "Watch along, then discuss" },
  sports: { label: "Match room", tagline: "Follow the match together.", Icon: GoalIcon, audienceHint: "Following the score" },
  other: { label: "Room", tagline: "Anything worth gathering for.", Icon: RadioIcon, audienceHint: "Joining in" },
};

export interface Score {
  homeLabel: string; awayLabel: string;
  homeScore: number; awayScore: number;
  minute: string | null;
  sourceName: string; sourceUrl: string | null;
  updatedAt: string;
}

/**
 * Match scoreboard.
 *
 * The score is always shown with its source, and the host cannot post one
 * without naming where it came from — a score with no source is a rumour.
 */
export function Scoreboard({ roomId, score, isHost, onChanged }: { roomId: string; score: Score | null; isHost: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => ({
    homeLabel: score?.homeLabel ?? "Home",
    awayLabel: score?.awayLabel ?? "Away",
    homeScore: String(score?.homeScore ?? 0),
    awayScore: String(score?.awayScore ?? 0),
    minute: score?.minute ?? "",
    sourceName: score?.sourceName ?? "",
    sourceUrl: score?.sourceUrl ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api(`/v1/activities/rooms/${roomId}/score`, {
        method: "PUT",
        body: {
          homeLabel: form.homeLabel, awayLabel: form.awayLabel,
          homeScore: Number(form.homeScore), awayScore: Number(form.awayScore),
          minute: form.minute || undefined,
          sourceName: form.sourceName, sourceUrl: form.sourceUrl || undefined,
        },
      });
      setEditing(false);
      onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save the score"); }
    finally { setBusy(false); }
  }

  if (!score && !isHost) {
    return <div className="kind-panel"><p className="meta">No score posted yet. The host will add one with its source.</p></div>;
  }

  return (
    <div className="kind-panel scoreboard">
      <div className="row spread">
        <span className="eyebrow"><GoalIcon width={13} height={13} /> Score</span>
        {score?.minute && <span className="meta"><ClockIcon width={12} height={12} /> {score.minute}</span>}
      </div>
      {score ? (
        <>
          <div className="score-line">
            <span className="score-team truncate">{score.homeLabel}</span>
            <span className="score-num">{score.homeScore}</span>
            <span className="score-sep">–</span>
            <span className="score-num">{score.awayScore}</span>
            <span className="score-team truncate">{score.awayLabel}</span>
          </div>
          <p className="meta">
            Source: {score.sourceUrl ? <a href={score.sourceUrl} target="_blank" rel="noreferrer">{score.sourceName}</a> : score.sourceName}
          </p>
        </>
      ) : (
        <p className="meta">No score posted yet.</p>
      )}
      {isHost && !editing && <button className="btn small" onClick={() => setEditing(true)}>{score ? "Update score" : "Post a score"}</button>}
      {isHost && editing && (
        <div className="stack" style={{ marginTop: "var(--space-2)" }}>
          {error && <div className="notice danger">{error}</div>}
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input className="input" aria-label="Home team" value={form.homeLabel} onChange={(e) => setForm({ ...form, homeLabel: e.target.value })} maxLength={60} />
            <input className="input score-input" aria-label="Home score" inputMode="numeric" value={form.homeScore} onChange={(e) => setForm({ ...form, homeScore: e.target.value.replace(/\D/g, "") })} />
          </div>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input className="input" aria-label="Away team" value={form.awayLabel} onChange={(e) => setForm({ ...form, awayLabel: e.target.value })} maxLength={60} />
            <input className="input score-input" aria-label="Away score" inputMode="numeric" value={form.awayScore} onChange={(e) => setForm({ ...form, awayScore: e.target.value.replace(/\D/g, "") })} />
          </div>
          <input className="input" aria-label="Minute" placeholder="e.g. 67' or Q3" value={form.minute} onChange={(e) => setForm({ ...form, minute: e.target.value })} maxLength={20} />
          <input className="input" aria-label="Source name" placeholder="Source (required) e.g. BBC Sport" value={form.sourceName} onChange={(e) => setForm({ ...form, sourceName: e.target.value })} maxLength={120} />
          <input className="input" aria-label="Source URL" placeholder="Source link (optional)" value={form.sourceUrl} onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })} maxLength={500} />
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button className="btn primary small" onClick={() => void save()} disabled={busy || !form.sourceName.trim()}>Save score</button>
            <button className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

export interface QueueItem { id: string; title: string; artist?: string; artworkUrl?: string }

/**
 * Audio queue for a listening party or music room.
 *
 * The host adds tracks and advances them; everyone sees the same queue and the
 * now-playing line, so the room is genuinely listening to one thing.
 */
export function AudioQueue({ roomId, queue, isHost, onChanged }: { roomId: string; queue: QueueItem[]; isHost: boolean; onChanged: () => void }) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!title.trim()) return;
    setBusy(true); setError(null);
    try {
      await api(`/v1/activities/rooms/${roomId}/queue`, { body: { title: title.trim(), artist: artist.trim() || undefined } });
      setTitle(""); setArtist("");
      onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not add the track"); }
    finally { setBusy(false); }
  }

  async function next() {
    setBusy(true);
    try { await api(`/v1/activities/rooms/${roomId}/queue/next`, { body: {} }); onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not advance the queue"); }
    finally { setBusy(false); }
  }

  return (
    <div className="kind-panel queue-panel">
      <div className="row spread">
        <span className="eyebrow"><MusicIcon width={13} height={13} /> Up next · {queue.length}</span>
        {isHost && queue.length > 0 && <button className="btn small" onClick={() => void next()} disabled={busy}>Play next</button>}
      </div>
      <ol className="queue-list">
        {queue.map((t, i) => (
          <li key={t.id} className="queue-item">
            <span className="queue-index">{i + 1}</span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 600 }} className="truncate">{t.title}</span>
              {t.artist && <span className="meta">{t.artist}</span>}
            </span>
          </li>
        ))}
        {queue.length === 0 && <li className="meta">{isHost ? "Add the first track." : "The host has not queued anything yet."}</li>}
      </ol>
      {isHost && (
        <div className="stack" style={{ marginTop: "var(--space-2)" }}>
          {error && <div className="notice danger">{error}</div>}
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input className="input" aria-label="Track title" placeholder="Track title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            <input className="input" aria-label="Artist" placeholder="Artist" value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={200} />
          </div>
          <button className="btn small" onClick={() => void add()} disabled={busy || !title.trim()}>Add to queue</button>
        </div>
      )}
    </div>
  );
}

/** Watch-party link panel: Vibe coordinates playback, it does not retransmit. */
export function WatchPanel({ room }: { room: Room }) {
  return (
    <div className="kind-panel watch-panel">
      <span className="eyebrow"><FilmIcon width={13} height={13} /> Watch together</span>
      {room.externalUrl ? (
        <p className="meta row" style={{ gap: 4 }}>
          <LinkIcon width={13} height={13} />
          {room.playbackMode === "synchronized" ? "Synchronized through the licensed service" : "Coordinated — press play at the same time"}
          {" "}· <a href={room.externalUrl} target="_blank" rel="noreferrer">open the service</a>
        </p>
      ) : (
        <p className="meta">The host will add a licensed-service link. Vibe does not stream the film itself.</p>
      )}
      {room.spoilerPolicy === "spoiler_safe" && <p className="meta">Spoiler-safe: messages are hidden until you reveal them.</p>}
    </div>
  );
}

/** A one-line ticket prompt reused across kinds. */
export function TicketPanel({ room, onBuy }: { room: Room; onBuy: () => void }) {
  return (
    <div className="card ticket-card">
      <div className="row spread">
        <span className="row" style={{ gap: 6 }}><TicketIcon width={16} height={16} /> <strong>₦{(room.ticketPriceMinor / 100).toLocaleString()}</strong> entry</span>
        <span className="meta">Vibe keeps 15%</span>
      </div>
      <button className="btn primary block" style={{ marginTop: "var(--space-3)" }} onClick={onBuy}>
        Get a ticket · ₦{(room.ticketPriceMinor / 100).toLocaleString()}
      </button>
    </div>
  );
}
