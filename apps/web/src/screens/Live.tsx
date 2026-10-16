import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { useNav } from "../nav";
import {
  ArrowLeftIcon, RadioIcon, GoalIcon, FilmIcon, MusicIcon, ClockIcon, UsersIcon,
  ShareIcon, BellIcon, CheckIcon, ShieldIcon, InfoIcon, LinkIcon, GlobeIcon, LockIcon,
} from "../components/Icons";

/**
 * Live Now + activity rooms (addendum §1–§4, §8).
 *
 * The state badge is rendered from the server's derived state, never guessed
 * from the clock here, so the screen cannot claim a room is live when it is not.
 * Official/automated hosts are labelled on the card and inside the room.
 */

interface Room {
  id: string;
  kind: "sports" | "movie" | "music" | "other";
  title: string;
  topic: string | null;
  state: "live" | "starting_soon" | "scheduled" | "ended" | "cancelled";
  startsAt: string;
  endsAt: string;
  city: string | null;
  area: string | null;
  visibility: "public" | "private";
  host: { id: string; handle: string; displayName: string; kind: string; disclosure: string | null };
  memberCount: number;
  dataSource: string | null;
  dataSourceUrl: string | null;
  externalUrl: string | null;
  playbackMode: "coordinated" | "synchronized";
  spoilerPolicy: "open" | "spoiler_safe";
  rules: string | null;
  slowModeSeconds: number;
  isSponsored: boolean;
  sponsorLabel: string | null;
  recurrence: string | null;
}

interface RoomPost {
  id: string;
  kind: string;
  body: string | null;
  hidden: boolean;
  automated: boolean;
  createdAt: string;
  author: { id: string; handle: string; displayName: string; kind: string };
}

const STATE_LABEL: Record<Room["state"], string> = {
  live: "Live",
  starting_soon: "Starting soon",
  scheduled: "Scheduled",
  ended: "Ended",
  cancelled: "Cancelled",
};

function KindIcon({ kind, size = 16 }: { kind: Room["kind"]; size?: number }) {
  if (kind === "sports") return <GoalIcon width={size} height={size} />;
  if (kind === "movie") return <FilmIcon width={size} height={size} />;
  if (kind === "music") return <MusicIcon width={size} height={size} />;
  return <RadioIcon width={size} height={size} />;
}

/** The honest host label. Rendered everywhere a host name appears. */
export function HostLabel({ host }: { host: Room["host"] }) {
  if (host.kind === "person") return null;
  const text = host.kind === "official" ? "Official Vibe host" : "Automated host";
  return (
    <span className="host-tag" title={host.disclosure ?? text}>
      <ShieldIcon width={12} height={12} /> {text}
    </span>
  );
}

function StateBadge({ state }: { state: Room["state"] }) {
  return <span className={`state-badge state-${state}`}>{state === "live" && <span className="live-dot" aria-hidden />}{STATE_LABEL[state]}</span>;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function LiveScreen({ onBack }: { onBack: () => void }) {
  const nav = useNav();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ rooms: Room[] }>("/v1/activities/live")
      .then((r) => setRooms(r.rooms))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load activities"));
  }, []);

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title">Live Now</h1>
      <p className="meta">
        Sports rooms, film clubs and listening parties. States are exact — nothing is shown as live unless it is.
      </p>

      {error && <div className="notice danger">{error}</div>}
      {rooms === null && !error && <div className="skeleton" aria-busy="true" />}

      <div className="stack">
        {rooms?.map((room) => (
          <button key={room.id} className="card room-card" onClick={() => nav.push({ name: "room", roomId: room.id })}>
            <div className="row spread">
              <span className="row" style={{ gap: 6 }}>
                <KindIcon kind={room.kind} />
                <strong>{room.title}</strong>
              </span>
              <StateBadge state={room.state} />
            </div>
            <div className="meta row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
              <span className="row" style={{ gap: 4 }}><ClockIcon width={13} height={13} /> {when(room.startsAt)}</span>
              <span className="row" style={{ gap: 4 }}><UsersIcon width={13} height={13} /> {room.memberCount}</span>
              {room.city && <span className="row" style={{ gap: 4 }}><GlobeIcon width={13} height={13} /> {room.city}</span>}
              {room.visibility === "private" && <span className="row" style={{ gap: 4 }}><LockIcon width={13} height={13} /> Private</span>}
            </div>
            <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap", marginTop: 6 }}>
              <span className="meta">{room.host.displayName}</span>
              <HostLabel host={room.host} />
              {room.isSponsored && <span className="sponsored-tag">{room.sponsorLabel ?? "Sponsored"}</span>}
              {room.recurrence && <span className="pill muted">{room.recurrence}</span>}
            </div>
          </button>
        ))}
        {rooms?.length === 0 && (
          <div className="empty">
            <RadioIcon width={22} height={22} />
            <p>No public activities are scheduled right now.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function RoomScreen({ roomId, onBack }: { roomId: string; onBack: () => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [posts, setPosts] = useState<RoomPost[]>([]);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        api<{ room: Room }>(`/v1/activities/rooms/${roomId}`),
        api<{ posts: RoomPost[] }>(`/v1/activities/rooms/${roomId}/posts`),
      ]);
      setRoom(r.room);
      setPosts(p.posts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load this room");
    }
  }, [roomId]);

  useEffect(() => { void load(); }, [load]);

  async function join() {
    setBusy(true);
    try { await api(`/v1/activities/rooms/${roomId}/join`, { body: {}, idempotencyKey: idempotencyKey("join") }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not join"); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api(`/v1/activities/rooms/${roomId}/posts`, { body: { body: draft.trim() }, idempotencyKey: idempotencyKey("rp") });
      setDraft("");
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not post"); }
    finally { setBusy(false); }
  }

  async function share() {
    try {
      const { link } = await api<{ link: { url: string; token: string } }>(`/v1/activities/rooms/${roomId}/share`, {
        body: {}, idempotencyKey: idempotencyKey("share"),
      });
      setShareUrl(link.url);
      try { await navigator.clipboard.writeText(link.url); } catch { /* clipboard may be unavailable */ }
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not create a link"); }
  }

  async function remind() {
    try {
      await api(`/v1/activities/rooms/${roomId}/reminder`, { body: { leadMinutes: 15 }, idempotencyKey: idempotencyKey("rem") });
      setMessage("Reminder set. You can turn it off any time.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not set a reminder"); }
  }

  if (!room) {
    return (
      <div>
        <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
          <ArrowLeftIcon width={18} height={18} /> Back
        </button>
        <h1 className="screen-title">Room</h1>
        {error ? <div className="notice danger">{error}</div> : <div className="skeleton" aria-busy="true" />}
      </div>
    );
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title"><KindIcon kind={room.kind} /> {room.title}</h1>

      <div className="card">
        <div className="row spread">
          <span className="row" style={{ gap: 6 }}>
            <span className="meta">{room.host.displayName}</span>
            <HostLabel host={room.host} />
          </span>
          <StateBadge state={room.state} />
        </div>
        {room.topic && <p style={{ marginTop: 6 }}>{room.topic}</p>}
        <div className="meta row" style={{ gap: "var(--space-3)", flexWrap: "wrap", marginTop: 6 }}>
          <span className="row" style={{ gap: 4 }}><ClockIcon width={13} height={13} /> {when(room.startsAt)}</span>
          <span className="row" style={{ gap: 4 }}><UsersIcon width={13} height={13} /> {room.memberCount} here</span>
        </div>
        {room.isSponsored && <p className="sponsored-tag" style={{ marginTop: 6 }}>{room.sponsorLabel ?? "Sponsored"}</p>}
        {room.rules && <p className="meta" style={{ marginTop: 6 }}>{room.rules}</p>}
      </div>

      {/* Where facts come from, stated plainly. */}
      {room.dataSource && (
        <p className="meta row" style={{ gap: 4 }}>
          <InfoIcon width={13} height={13} /> Data: {room.dataSource}
          {room.dataSourceUrl && <> · <a href={room.dataSourceUrl} target="_blank" rel="noreferrer">source</a></>}
        </p>
      )}

      {/* Vibe coordinates; it never retransmits. Say which. */}
      {room.externalUrl && (
        <p className="meta row" style={{ gap: 4 }}>
          <LinkIcon width={13} height={13} />
          {room.playbackMode === "synchronized"
            ? "Synchronized playback through the licensed service"
            : "Vibe is coordinating this session — listen or watch on the licensed service"}{" "}
          · <a href={room.externalUrl} target="_blank" rel="noreferrer">open</a>
        </p>
      )}
      {room.spoilerPolicy === "spoiler_safe" && (
        <p className="meta row" style={{ gap: 4 }}><ShieldIcon width={13} height={13} /> Spoiler-safe: messages stay hidden until you reveal them.</p>
      )}

      <div className="row" style={{ gap: "var(--space-2)", padding: "0 var(--space-4)" }}>
        <button className="btn small" onClick={join} disabled={busy}>Join</button>
        <button className="btn small ghost" onClick={share}><ShareIcon width={14} height={14} /> Share</button>
        <button className="btn small ghost" onClick={remind}><BellIcon width={14} height={14} /> Remind me</button>
      </div>

      {shareUrl && <p className="meta" >Link ready (copied): {shareUrl}</p>}
      {message && <p className="meta row" style={{ gap: 4 }}><CheckIcon width={13} height={13} /> {message}</p>}
      {error && <p className="error" role="alert" >{error}</p>}

      <ul className="room-posts">
        {posts.map((p) => (
          <li key={p.id} className="room-post">
            <div className="meta row" style={{ gap: 6 }}>
              <strong>{p.author.displayName}</strong>
              {p.author.kind !== "person" && <span className="host-tag"><ShieldIcon width={11} height={11} /> Official host</span>}
              <span className="muted">{new Date(p.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {p.hidden && !revealed.has(p.id) ? (
              <button className="spoiler" onClick={() => setRevealed((s) => new Set(s).add(p.id))}>
                Spoiler — tap to reveal
              </button>
            ) : (
              <p>{p.body}</p>
            )}
          </li>
        ))}
        {posts.length === 0 && <li className="empty"><p>No messages yet. Say hello.</p></li>}
      </ul>

      <div className="composer">
        <input
          className="input"
          value={draft}
          placeholder="Add to the conversation"
          aria-label="Message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
        />
        <button className="btn small" onClick={send} disabled={busy || !draft.trim()}>Send</button>
      </div>
    </div>
  );
}
