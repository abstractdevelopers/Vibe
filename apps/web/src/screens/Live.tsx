import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { useNav } from "../nav";
import {
  ArrowLeftIcon, RadioIcon, GoalIcon, FilmIcon, MusicIcon, ClockIcon, UsersIcon,
  ShareIcon, BellIcon, CheckIcon, ShieldIcon, InfoIcon, LinkIcon, GlobeIcon, LockIcon,
  MicIcon, TicketIcon, UploadIcon, CloseIcon,
} from "../components/Icons";
import { uploadImageFile } from "../media";

/**
 * Live Now + activity rooms (addendum §1–§4, §8).
 *
 * The state badge is rendered from the server's derived state, never guessed
 * from the clock here, so the screen cannot claim a room is live when it is not.
 * Official/automated hosts are labelled on the card and inside the room.
 */

interface Room {
  id: string;
  kind: "sports" | "movie" | "music" | "other" | "voice" | "listen";
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
  bannerUrl: string | null;
  audioTrack: { title: string; artist?: string; artworkUrl?: string } | null;
  audioStartedAt: string | null;
  ticketPriceMinor: number;
  isTicketed: boolean;
  viewerTicket?: { status: string } | null;
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
  if (kind === "music" || kind === "listen") return <MusicIcon width={size} height={size} />;
  if (kind === "voice") return <MicIcon width={size} height={size} />;
  return <RadioIcon width={size} height={size} />;
}

const KIND_LABEL: Record<string, string> = {
  voice: "Voice room",
  listen: "Listen together",
};

/** Format a minor-unit price the way the rest of the app does. */
function naira(minor: number): string {
  return `₦${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    api<{ rooms: Room[] }>("/v1/activities/live")
      .then((r) => setRooms(r.rooms))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load activities"));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <div className="row spread" style={{ alignItems: "center" }}>
        <h1 className="screen-title" style={{ margin: 0 }}>Live Now</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <RadioIcon width={16} height={16} /> Go live
        </button>
      </div>
      <p className="meta">
        Voice rooms, listening parties, sports rooms and film clubs. Go live any day — daily, weekly, or once.
        States are exact: nothing is shown as live unless it is.
      </p>

      {creating && (
        <GoLiveSheet
          onClose={() => setCreating(false)}
          onCreated={(roomId) => { setCreating(false); reload(); nav.push({ name: "room", roomId }); }}
        />
      )}

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
              {KIND_LABEL[room.kind] && <span className="chip tiny">{KIND_LABEL[room.kind]}</span>}
              {room.isTicketed ? (
                <span className="chip tiny"><TicketIcon width={11} height={11} /> {naira(room.ticketPriceMinor)}</span>
              ) : (
                <span className="chip tiny">Free</span>
              )}
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


/**
 * Go Live — the host's sheet.
 *
 * A creator picks the vibe (voice room, listening party, watch party, match
 * room), names it, says when, and decides whether it is free or ticketed.
 * Nothing here invents money: a price creates a provider checkout, and entry is
 * granted by the verified webhook, never by this screen.
 */
const LIVE_KINDS: Array<{ id: Room["kind"]; label: string; hint: string; Icon: typeof RadioIcon }> = [
  { id: "voice", label: "Voice room", hint: "Open stage — people join and talk.", Icon: MicIcon },
  { id: "listen", label: "Listen together", hint: "You play the music, everyone listens.", Icon: MusicIcon },
  { id: "movie", label: "Watch party", hint: "Watch on a licensed service, talk here.", Icon: FilmIcon },
  { id: "sports", label: "Match room", hint: "Follow a match together.", Icon: GoalIcon },
  { id: "music", label: "Music room", hint: "Talk around a set or an album.", Icon: MusicIcon },
  { id: "other", label: "Something else", hint: "Anything worth gathering for.", Icon: RadioIcon },
];

const CADENCES = ["", "daily", "weekly", "fortnightly", "monthly"] as const;

function GoLiveSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (roomId: string) => void }) {
  const [kind, setKind] = useState<Room["kind"]>("voice");
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [when, setWhen] = useState(() => {
    // Default to now, rounded to the next five minutes — going live is often
    // immediate, and the picker should not fight the host.
    const d = new Date(Date.now() + 5 * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [cadence, setCadence] = useState<(typeof CADENCES)[number]>("");
  const [paid, setPaid] = useState(false);
  const [price, setPrice] = useState(1000);
  const [trackTitle, setTrackTitle] = useState("");
  const [trackArtist, setTrackArtist] = useState("");
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAudio = kind === "voice" || kind === "listen";

  async function pickBanner(file: File) {
    setError(null);
    setUploading(true);
    try {
      setBannerUrl(await uploadImageFile(file, 1280));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload that image");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!title.trim()) { setError("Give your room a name."); return; }
    setBusy(true);
    setError(null);
    try {
      const { room } = await api<{ room: Room }>("/v1/activities/rooms", {
        body: {
          kind,
          title: title.trim(),
          ...(topic.trim() ? { topic: topic.trim() } : {}),
          startsAt: new Date(when).toISOString(),
          durationMinutes,
          visibility: "public",
          ...(cadence ? { recurrence: cadence } : {}),
          ticketPriceMinor: paid ? Math.round(price * 100) : 0,
          currency: "NGN",
          ...(bannerUrl ? { bannerUrl } : {}),
          ...(isAudio && trackTitle.trim()
            ? { audioTrack: { title: trackTitle.trim(), ...(trackArtist.trim() ? { artist: trackArtist.trim() } : {}) } }
            : {}),
        },
        idempotencyKey: idempotencyKey("golive"),
      });
      onCreated(room.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not go live");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Go live" onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
          <div>
            <p className="eyebrow">Go live</p>
            <h2 style={{ fontSize: "var(--text-title)" }}>Start a room</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        {error && <div className="notice danger">{error}</div>}

        <label htmlFor="liveKind">The vibe</label>
        <div className="pill-row" role="tablist" aria-label="Room type">
          {LIVE_KINDS.map((k) => (
            <button
              key={k.id}
              className="pill"
              role="tab"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
            >
              <k.Icon width={15} height={15} style={{ marginRight: 6 }} />
              {k.label}
            </button>
          ))}
        </div>
        <p className="meta" style={{ marginTop: "-4px" }}>
          {LIVE_KINDS.find((k) => k.id === kind)?.hint}
        </p>

        <label htmlFor="liveTitle">Name</label>
        <input id="liveTitle" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sunday Afrobeats listening" maxLength={160} />

        <label htmlFor="liveTopic">What is it about? <span className="meta">(optional)</span></label>
        <textarea id="liveTopic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Say a little about what is happening." maxLength={400} style={{ minHeight: 60 }} />

        <div className="row" style={{ gap: "var(--space-3)" }}>
          <div className="grow">
            <label htmlFor="liveWhen">Starts</label>
            <input id="liveWhen" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <div style={{ width: 130 }}>
            <label htmlFor="liveDuration">Minutes</label>
            <input id="liveDuration" type="number" min={5} max={1440} value={durationMinutes} onChange={(e) => setDurationMinutes(Number(e.target.value) || 60)} />
          </div>
        </div>

        <label htmlFor="liveCadence">Repeats</label>
        <select id="liveCadence" value={cadence} onChange={(e) => setCadence(e.target.value as (typeof CADENCES)[number])}>
          <option value="">Once</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="fortnightly">Every two weeks</option>
          <option value="monthly">Every month</option>
        </select>

        {isAudio && (
          <>
            <label htmlFor="liveTrack">Now playing <span className="meta">(optional)</span></label>
            <div className="row" style={{ gap: "var(--space-2)" }}>
              <input id="liveTrack" className="grow" value={trackTitle} onChange={(e) => setTrackTitle(e.target.value)} placeholder="Track or set name" maxLength={200} />
              <input value={trackArtist} onChange={(e) => setTrackArtist(e.target.value)} placeholder="Artist" maxLength={200} style={{ maxWidth: 160 }} />
            </div>
          </>
        )}

        <label htmlFor="liveBanner">Banner <span className="meta">(optional)</span></label>
        <label className="dropzone" style={{ marginBottom: "var(--space-3)" }}>
          {bannerUrl ? (
            <img src={bannerUrl} alt="Banner preview" style={{ width: "100%", borderRadius: "var(--radius-sm)" }} />
          ) : (
            <>
              <UploadIcon width={22} height={22} />
              <span>{uploading ? "Uploading…" : "Add a banner image"}</span>
              <span className="meta">A wide image reads best. JPEG, PNG or WebP.</span>
            </>
          )}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { if (e.target.files?.[0]) void pickBanner(e.target.files[0]); e.target.value = ""; }}
          />
        </label>

        <label className="row spread" htmlFor="livePaid" style={{ cursor: "pointer" }}>
          <span>
            <span style={{ display: "block", fontWeight: 600 }}>Charge for entry</span>
            <span className="meta">Free to everyone when off. Vibe keeps 30% of a ticket.</span>
          </span>
          <span className="row switch-wrap" style={{ gap: "var(--space-2)" }}>
            <span className={`switch${paid ? " on" : ""}`} aria-hidden="true"><span className="switch-knob" /></span>
            <span className="switch-state meta" aria-hidden="true">{paid ? "On" : "Off"}</span>
            <input id="livePaid" type="checkbox" className="switch-input" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          </span>
        </label>

        {paid && (
          <div className="row" style={{ gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
            <div className="grow">
              <label htmlFor="livePrice">Ticket price (₦)</label>
              <input id="livePrice" type="number" min={1} value={price} onChange={(e) => setPrice(Number(e.target.value) || 0)} />
            </div>
            <p className="meta grow" style={{ alignSelf: "flex-end", marginBottom: 8 }}>
              You earn {naira(Math.round(price * 100 * 0.7))} per ticket.
            </p>
          </div>
        )}

        <button className="btn primary block" onClick={() => void submit()} disabled={busy || uploading} style={{ marginTop: "var(--space-4)" }}>
          <RadioIcon width={16} height={16} /> {busy ? "Opening…" : "Go live"}
        </button>
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
  const [ticket, setTicket] = useState<{ status: string } | null>(null);
  const [joined, setJoined] = useState(false);
  const [buying, setBuying] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, p, t] = await Promise.all([
        api<{ room: Room }>(`/v1/activities/rooms/${roomId}`),
        api<{ posts: RoomPost[] }>(`/v1/activities/rooms/${roomId}/posts`),
        api<{ ticket: { status: string } | null }>(`/v1/activities/rooms/${roomId}/ticket`).catch(() => ({ ticket: null })),
      ]);
      setRoom(r.room);
      setPosts(p.posts);
      setTicket(t.ticket);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load this room");
    }
  }, [roomId]);

  useEffect(() => { void load(); }, [load]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/activities/rooms/${roomId}/join`, { body: {}, idempotencyKey: idempotencyKey("join") });
      setJoined(true);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not join");
    } finally { setBusy(false); }
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

  async function buyTicket() {
    setBuying(true);
    setError(null);
    try {
      const result = await api<{ redirectUrl: string | null; status: string }>(
        `/v1/activities/rooms/${roomId}/ticket`,
        { body: {}, idempotencyKey: idempotencyKey("ticket") },
      );
      if (result.redirectUrl) {
        // The provider collects the money; the ticket is granted on its webhook.
        window.location.href = result.redirectUrl;
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start the ticket purchase");
    } finally {
      setBuying(false);
    }
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

      {room.bannerUrl && (
        <img className="room-banner" src={room.bannerUrl} alt="" loading="lazy" />
      )}

      <div className="card">
        <div className="row spread">
          <span className="row" style={{ gap: 6 }}>
            <span className="meta">{room.host.displayName}</span>
            <HostLabel host={room.host} />
            {KIND_LABEL[room.kind] && <span className="chip tiny">{KIND_LABEL[room.kind]}</span>}
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

      {/* The room is playing something. A live bar makes it feel occupied. */}
      {room.audioTrack && (
        <div className="now-playing">
          <span className="eq" aria-hidden="true"><i /><i /><i /></span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 600 }} className="truncate">{room.audioTrack.title}</span>
            {room.audioTrack.artist && <span className="meta">{room.audioTrack.artist}</span>}
          </span>
          <span className="meta">{room.state === "live" ? "Live" : "Queued"}</span>
        </div>
      )}

      {/* Entry: free, or a ticket bought through the provider. */}
      {room.isTicketed && (
        <div className="card ticket-card">
          {ticket?.status === "granted" ? (
            <p className="row" style={{ gap: 6, margin: 0 }}>
              <CheckIcon width={15} height={15} /> Your ticket is in — you are on the list.
            </p>
          ) : (
            <>
              <div className="row spread">
                <span className="row" style={{ gap: 6 }}>
                  <TicketIcon width={16} height={16} /> <strong>{naira(room.ticketPriceMinor)}</strong> entry
                </span>
                <span className="meta">Vibe keeps 30%</span>
              </div>
              <button className="btn primary block" style={{ marginTop: "var(--space-3)" }} onClick={() => void buyTicket()} disabled={buying}>
                {buying ? "Opening checkout…" : `Get a ticket · ${naira(room.ticketPriceMinor)}`}
              </button>
            </>
          )}
        </div>
      )}

      <div className="row" style={{ gap: "var(--space-2)", padding: "0 var(--space-4)" }}>
        <button className="btn small" onClick={join} disabled={busy || joined}>{joined ? "You're in" : "Join"}</button>
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
