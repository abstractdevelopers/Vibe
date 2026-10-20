import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, idempotencyKey, mediaSrc } from "../api";
import { useRoomChannel, type RealtimeEvent } from "../realtime";
import { peersToOfferTo } from "../rtc-mesh";
import { audioProfileFor, loadIceServers, type AudioProfile } from "../rtc";
import { uploadImageFile } from "../media";
import { Avatar } from "./Avatar";
import { GiftSheet } from "./GiftSheet";
import { PaidGiftSheet } from "./PaidGiftSheet";
import { AudioQueue, ROOM_KINDS, Scoreboard, TicketPanel, WatchPanel, type Score } from "./RoomKindPanels";
import { useActivityTheme } from "./useActivityTheme";
import { themeForRoom } from "../themes";
import {
  ArrowLeftIcon, BellIcon, CheckIcon, CheerIcon, CloseIcon, EditIcon, FlameIcon, GiftIcon,
  HandIcon, HeadphonesIcon, LinkIcon, MicIcon, MicOffIcon, MicOnIcon, MusicIcon,
  LogOutIcon, MoreIcon, ShareIcon, ShieldIcon, TicketIcon, TrashIcon, UploadIcon, UsersIcon,
} from "./Icons";
import { GiftArt } from "./GiftArt";

/** How many speakers a peer-to-peer mesh can carry before it needs an SFU. */
export const MESH_SPEAKER_LIMIT = 8;

/**
 * The reaction set. Each reaction is a drawn mark with a stable id, so a room
 * burst animates the same mark a person tapped, and the id is what crosses the
 * wire (the server stores an opaque string).
 */
export const REACTIONS = [
  { id: "fire", label: "Fire" },
  { id: "clap", label: "Applause" },
  { id: "heart", label: "Love" },
  { id: "laugh", label: "Laugh" },
  { id: "party", label: "Celebrate" },
  { id: "hundred", label: "Hundred" },
] as const;

export interface Room {
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
  hype: number;
  isSponsored: boolean;
  sponsorLabel: string | null;
  rules: string | null;
  bannerUrl: string | null;
  externalUrl: string | null;
  playbackMode: "coordinated" | "synchronized";
  spoilerPolicy: "open" | "spoiler_safe";
  layout: "stage" | "broadcast";
  audioTrack: { title: string; artist?: string; artworkUrl?: string } | null;
  audioQueue: Array<{ id: string; title: string; artist?: string; artworkUrl?: string }>;
  audioStartedAt: string | null;
  ticketPriceMinor: number;
  isTicketed: boolean;
}

interface Member {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  hostKind: string;
  handRaised: boolean;
  muted: boolean;
  mutedByHost: boolean;
}

interface RoomPost {
  id: string;
  body: string;
  hidden: boolean;
  createdAt: string;
  author: { id: string; handle: string; displayName: string; kind: string };
}

interface Props {
  roomId: string;
  viewerId: string;
  viewerName: string;
  onBack: () => void;
  onLeft: () => void;
}

/**
 * The live room studio.
 *
 * A voice or listen room is a stage plus an audience. The host is always on the
 * stage; listeners raise a hand and the host brings them up. Audio is carried
 * peer-to-peer (WebRTC mesh) with the server relaying only signalling, so it
 * scales to a handful of speakers; beyond `MESH_SPEAKER_LIMIT` a room needs an
 * SFU. Energy — reactions and gifts — is broadcast over the room channel and
 * floats across the stage.
 */
export function RoomStudio({ roomId, viewerId, viewerName, onBack, onLeft }: Props) {
  const [room, setRoom] = useState<Room | null>(null);
  const [stage, setStage] = useState<Member[]>([]);
  const [audience, setAudience] = useState<Member[]>([]);
  const [posts, setPosts] = useState<RoomPost[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [ticket, setTicket] = useState<{ status: string } | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // Studio state
  const [micOn, setMicOn] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [bursts, setBursts] = useState<Array<{ id: number; art: string; left: number }>>([]);
  const [gifting, setGifting] = useState(false);
  const [paidGifting, setPaidGifting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState(false);
  const [more, setMore] = useState(false);
  const [peers, setPeers] = useState<Record<string, MediaStream>>({});
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [score, setScore] = useState<Score | null>(null);

  const localStream = useRef<MediaStream | null>(null);
  const peerConns = useRef<Map<string, RTCPeerConnection>>(new Map());
  // ICE servers (STUN + TURN) are fetched once, before the first peer is made.
  const iceServersRef = useRef<{ urls: string | string[]; username?: string; credential?: string }[]>([
    { urls: "stun:stun.l.google.com:19302" },
  ]);
  const iceLoadedRef = useRef(false);

  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map());
  const analysers = useRef<Map<string, { ctx: AudioContext; raf: number }>>(new Map());
  const localAnalyser = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const [micLevel, setMicLevel] = useState(0);

  // The room kind decides the audio profile; it is only known after the first
  // load, so the profile is read through a ref at stream/peer creation time.
  const profileRef = useRef<AudioProfile>(audioProfileFor(null));
  profileRef.current = audioProfileFor(room?.kind);

  const isHost = room?.host.id === viewerId;
  const isOnStage = stage.some((m) => m.id === viewerId);
  const canSpeak = room?.kind === "voice" || room?.kind === "listen" || room?.kind === "other";

  const load = useCallback(async () => {
    try {
      const [r, p, t, m] = await Promise.all([
        api<{ room: Room }>(`/v1/activities/rooms/${roomId}`),
        api<{ posts: RoomPost[] }>(`/v1/activities/rooms/${roomId}/posts`),
        api<{ ticket: { status: string } | null }>(`/v1/activities/rooms/${roomId}/ticket`).catch(() => ({ ticket: null })),
        api<{ stage: Member[]; audience: Member[] }>(`/v1/activities/rooms/${roomId}/members`).catch(() => ({ stage: [], audience: [] })),
      ]);
      setRoom(r.room);
      setPosts(p.posts);
      setTicket(t.ticket);
      setStage(m.stage);
      setAudience(m.audience);
      // Membership is a fact on the server, not something the viewer should have
      // to assert. The host is written to room_members when the room is created,
      // so the host is already in — but `joined` started false, so the host was
      // shown a Join button for their own room and had to press it before the mic
      // would come on. Derive it from the member lists instead.
      if (m.stage.some((x) => x.id === viewerId) || m.audience.some((x) => x.id === viewerId)) {
        setJoined(true);
      }
      // A match room has a score; other kinds return null.
      if (r.room.kind === "sports") {
        const s = await api<{ score: Score | null }>(`/v1/activities/rooms/${roomId}/score`).catch(() => ({ score: null }));
        setScore(s.score);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load this room");
    }
  }, [roomId, viewerId]);

  useEffect(() => { void load(); }, [load]);

  // Fetch ICE servers (STUN + TURN) once, before any peer connection is built.
  // Without a TURN relay, calls between two people behind carrier NAT never
  // connect at all, which is the common case on mobile.
  useEffect(() => {
    if (iceLoadedRef.current) return;
    iceLoadedRef.current = true;
    void loadIceServers().then((servers) => { iceServersRef.current = servers; });
  }, []);

  // A live room keeps itself fresh even without an event.
  useEffect(() => {
    const t = window.setInterval(() => { void load(); }, 8000);
    return () => window.clearInterval(t);
  }, [load]);

  // ---- WebRTC mesh (small rooms; an SFU is the next step) ----
  const closePeer = useCallback((id: string) => {
    peerConns.current.get(id)?.close();
    peerConns.current.delete(id);
    const a = analysers.current.get(id);
    if (a) { cancelAnimationFrame(a.raf); a.ctx.close(); analysers.current.delete(id); }
    setPeers((prev) => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  const attachAudio = useCallback((id: string, stream: MediaStream) => {
    let el = audioEls.current.get(id);
    if (!el) { el = document.createElement("audio"); el.autoplay = true; el.setAttribute("playsinline", "true"); audioEls.current.set(id, el); }
    el.srcObject = stream;
    void el.play().catch(() => { /* autoplay may need a gesture */ });
    setPeers((prev) => ({ ...prev, [id]: stream }));
    // Speaking indicator from the remote stream's level.
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const level = data.reduce((s, v) => s + v, 0) / data.length;
        setSpeaking((prev) => {
          const next = new Set(prev);
          if (level > 12) next.add(id); else next.delete(id);
          return next;
        });
        const a = analysers.current.get(id);
        if (a) a.raf = requestAnimationFrame(tick);
      };
      analysers.current.set(id, { ctx, raf: requestAnimationFrame(tick) });
    } catch { /* analyser is best-effort */ }
  }, []);

  const ensurePeer = useCallback((peerId: string, initiator: boolean): RTCPeerConnection => {
    const existing = peerConns.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    peerConns.current.set(peerId, pc);
    localStream.current?.getTracks().forEach((t) => pc.addTrack(t, localStream.current!));
    // Tune the audio sender for the room. Speech stays at ~32 kbps to keep a
    // broadcast host's uplink affordable; a music room gets a wideband ceiling
    // so a track does not sound like a phone call.
    const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
    if (audioSender) {
      const params = audioSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0]!.maxBitrate = profileRef.current.maxBitrate;
      void audioSender.setParameters(params).catch(() => { /* negotiated defaults are fine */ });
    }
    pc.ontrack = (e) => attachAudio(peerId, e.streams[0]!);
    pc.onicecandidate = (e) => {
      if (e.candidate) signalRef.current({ type: "rtc.ice", to: peerId, payload: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      // "disconnected" is usually a transient blip (a phone changing network, a
      // moment of packet loss) and recovers on its own. Tearing the peer down on
      // it killed the call for good — the other person simply went silent with no
      // way back. Only "failed" and "closed" are terminal; a disconnected peer
      // gets a short grace period and is dropped only if it does not recover.
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        closePeer(peerId);
        return;
      }
      if (pc.connectionState === "disconnected") {
        window.setTimeout(() => {
          if (peerConns.current.get(peerId) === pc && pc.connectionState === "disconnected") closePeer(peerId);
        }, 5000);
      }
    };
    if (initiator && localStream.current) {
      void pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => signalRef.current({ type: "rtc.offer", to: peerId, payload: offer }))
        .catch(() => { /* negotiation retried on next stage change */ });
    }
    return pc;
  }, [attachAudio, closePeer]);

  // Forward-declared signalling send, filled by the room channel below.
  const signalRef = useRef<(msg: Record<string, unknown>) => void>(() => {});

  const onRoomEvent = useCallback((event: RealtimeEvent) => {
    const p = event.payload as Record<string, unknown>;
    if (event.type === "room.reaction") {
      addBurst(String(p.emoji ?? "fire"));
      return;
    }
    if (event.type === "room.gift") {
      addBurst("gift");
      setMessage(`${p.fromName ?? p.from} sent a ${String(p.kind).replace("_", " ")}`);
      return;
    }
    if (event.type === "room.hand" || event.type === "room.stage") {
      void load();
      return;
    }
    if (event.type === "room.updated") {
      if (p.room) setRoom(p.room as Room);
      return;
    }
    if (event.type === "room.score") {
      setScore(p.score as Score | null);
      return;
    }
    if (event.type === "room.queue") {
      setRoom((prev) => (prev ? { ...prev, audioQueue: (p.queue as Room["audioQueue"]) ?? [] } : prev));
      return;
    }
    if (event.type === "room.left") {
      void load();
      return;
    }
    if (event.type === "room.kicked") {
      if (p.userId === viewerId) {
        peerConns.current.forEach((pc) => pc.close());
        peerConns.current.clear();
        setError("You were removed from this room.");
      } else {
        void load();
      }
      return;
    }
    if (event.type === "room.deleted" || event.type === "room.ended") {
      // The room is over: drop every peer so the mic is not left publishing into
      // nothing, and say so plainly instead of showing a room that is gone.
      peerConns.current.forEach((pc) => pc.close());
      peerConns.current.clear();
      setError("This room has ended.");
      return;
    }
    // WebRTC signalling.
    if (event.type === "rtc.offer" && p.to === viewerId) {
      const from = String(p.from);
      const pc = ensurePeer(from, false);
      void pc.setRemoteDescription(new RTCSessionDescription(p.data as RTCSessionDescriptionInit))
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer).then(() => answer))
        .then((answer) => signalRef.current({ type: "rtc.answer", to: from, payload: answer }))
        .catch(() => {});
      return;
    }
    if (event.type === "rtc.answer" && p.to === viewerId) {
      const pc = peerConns.current.get(String(p.from));
      if (pc) void pc.setRemoteDescription(new RTCSessionDescription(p.data as RTCSessionDescriptionInit)).catch(() => {});
      return;
    }
    if (event.type === "rtc.ice" && p.to === viewerId) {
      const pc = peerConns.current.get(String(p.from));
      if (pc) void pc.addIceCandidate(new RTCIceCandidate(p.data as RTCIceCandidateInit)).catch(() => {});
    }
  }, [ensurePeer, load]);

  const { send: signal, status: channelStatus } = useRoomChannel(roomId, viewerId, onRoomEvent);
  signalRef.current = signal;

  function addBurst(id: string) {
    const key = Date.now() + Math.random();
    setBursts((b) => [...b.slice(-24), { id: key, art: id, left: 8 + Math.random() * 84 }]);
    window.setTimeout(() => setBursts((b) => b.filter((x) => x.id !== key)), 2200);
  }

  // The host is on the stage, so the host's mic is on by default.
  const ensureLocalStream = useCallback(async () => {
    if (localStream.current) return localStream.current;
    // Capture is tuned per room kind. Echo cancellation matters most in a
    // broadcast, where every listener's speaker can otherwise feed straight
    // back into the host's mic. A music room drops the speech filters, which
    // would otherwise mangle a track.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: profileRef.current.constraints,
      video: false,
    });
    localStream.current = stream;
    return stream;
  }, []);

  async function toggleMic() {
    setMicError(null);
    try {
      if (micOn) {
        localStream.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
        stopLocalMeter();
        setMicOn(false);
        return;
      }
      const stream = await ensureLocalStream();
      stream.getAudioTracks().forEach((t) => { t.enabled = true; });
      startLocalMeter(stream);
      setMicOn(true);
      // Who this speaker connects to depends on the room's format. In an open
      // mic every speaker meshes with every other speaker. In broadcast only the
      // host publishes, so a host offers to every listener and a listener who is
      // brought up offers only to the host — that is what lets a broadcast carry
      // far more listeners than a full mesh before it needs an SFU.
      for (const id of peersToOfferTo({ viewerId, peerIds: stageOthers.map((m) => m.id), layout: room?.layout, isHost })) {
        ensurePeer(id, true);
      }
    } catch {
      setMicError("Microphone permission is needed to speak. Allow it in your browser, then try again.");
    }
  }

  // A live level for the viewer's own mic, so "is my voice being picked up?"
  // is answerable without asking someone else. This is the missing feedback
  // that made voice rooms feel dead.
  const stopLocalMeter = useCallback(() => {
    const a = localAnalyser.current;
    if (a) { cancelAnimationFrame(a.raf); void a.ctx.close(); localAnalyser.current = null; }
    setMicLevel(0);
  }, []);

  const startLocalMeter = useCallback((stream: MediaStream) => {
    if (localAnalyser.current) return;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const level = data.reduce((s, v) => s + v, 0) / data.length;
        setMicLevel(Math.min(100, Math.round((level / 40) * 100)));
        const a = localAnalyser.current;
        if (a) a.raf = requestAnimationFrame(tick);
      };
      localAnalyser.current = { ctx, raf: requestAnimationFrame(tick) };
    } catch { /* meter is best-effort */ }
  }, []);

  // Tear down audio on unmount, and tell the server we are gone. The leave is
  // keepalive so it survives the navigation, and it is guarded by a ref because
  // the effect must not re-run when membership changes.
  const joinedRef = useRef(false);
  joinedRef.current = joined;
  useEffect(() => () => {
    localStream.current?.getTracks().forEach((t) => t.stop());
    peerConns.current.forEach((pc) => pc.close());
    analysers.current.forEach((a) => { cancelAnimationFrame(a.raf); void a.ctx.close(); });
    if (localAnalyser.current) { cancelAnimationFrame(localAnalyser.current.raf); void localAnalyser.current.ctx.close(); }
    if (joinedRef.current) {
      void api(`/v1/activities/rooms/${roomId}/leave`, { body: {}, keepalive: true }).catch(() => {});
    }
  }, [roomId]);

  async function join() {
    setBusy(true); setError(null);
    try {
      await api(`/v1/activities/rooms/${roomId}/join`, { body: {}, idempotencyKey: idempotencyKey("join") });
      setJoined(true);
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not join"); }
    finally { setBusy(false); }
  }

  // A voice room is only worth entering if you can be heard. The host goes on
  // the stage when they join, so the host's mic must come on with it — before
  // this, joining turned nothing on, `micOn` stayed false, and both sides sat
  // in silence until each pressed a button they had no reason to know about.
  // Speakers join the same way; a listener in a broadcast room stays muted.
  useEffect(() => {
    if (!joined || !canSpeak || micOn) return;
    if (!isHost && !isOnStage) return;
    void toggleMic();
    // toggleMic is stable for a given room; re-running on every stage change
    // would re-acquire the mic and fight the user's own mute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, canSpeak, isHost, isOnStage]);

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

  async function react(emoji: string) {
    addBurst(emoji);
    try { await api(`/v1/activities/rooms/${roomId}/reactions`, { body: { emoji }, idempotencyKey: idempotencyKey("rx") }); }
    catch { /* the local burst already played */ }
  }

  async function raiseHand(raised: boolean) {
    try { await api(`/v1/activities/rooms/${roomId}/hand`, { body: { raised } }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not raise your hand"); }
  }

  async function stageAction(userId: string, action: "promote" | "demote" | "mute" | "unmute") {
    try { await api(`/v1/activities/rooms/${roomId}/stage`, { body: { userId, action } }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not change the stage"); }
  }

  /** Remove someone from the room (host). */
  async function kickMember(userId: string) {
    try {
      await api(`/v1/activities/rooms/${roomId}/moderate`, { body: { action: "kick", targetId: userId } });
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not remove them"); }
  }

  /** Mute the whole stage at once (host). */
  async function muteAll() {
    try {
      await api(`/v1/activities/rooms/${roomId}/moderate`, { body: { action: "mute_all" } });
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not mute the stage"); }
  }

  async function buyTicket() {
    try {
      const result = await api<{ redirectUrl: string | null }>(`/v1/activities/rooms/${roomId}/ticket`, {
        body: {}, idempotencyKey: idempotencyKey("ticket"),
      });
      if (result.redirectUrl) window.location.href = result.redirectUrl; else await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not start the ticket purchase"); }
  }

  async function share() {
    try {
      const { link } = await api<{ link: { url: string } }>(`/v1/activities/rooms/${roomId}/share`, {
        body: {}, idempotencyKey: idempotencyKey("share"),
      });
      try { await navigator.clipboard.writeText(link.url); } catch { /* clipboard may be unavailable */ }
      setMessage("Link copied to your clipboard.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not create a link"); }
  }

  async function removeRoom() {
    if (!window.confirm("Delete this room? This cannot be undone.")) return;
    try {
      await api(`/v1/activities/rooms/${roomId}`, { method: "DELETE" });
      onLeft();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not delete the room"); }
  }

  /** Leave the room: tell the server, then go back. A no-op if never joined. */
  async function leaveRoom() {
    try {
      if (joined) await api(`/v1/activities/rooms/${roomId}/leave`, { body: {} });
    } catch { /* leaving is best-effort; navigation must not be blocked */ }
    onBack();
  }

  /**
   * End the room (host). This is the "meeting is over" control a live room needs:
   * it stops the room showing as live, clears the stage, and tells everyone
   * inside so their screens close rather than sit in a room that no longer
   * exists.
   */
  async function endRoom() {
    if (!window.confirm("End this room for everyone?")) return;
    setBusy(true);
    try {
      await api(`/v1/activities/rooms/${roomId}/moderate`, { body: { action: "close_room" } });
      onLeft();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not end the room");
      setBusy(false);
    }
  }

  const stageOthers = useMemo(() => stage.filter((m) => m.id !== viewerId), [stage, viewerId]);
  useActivityTheme(room ? themeForRoom(room.kind) : null);

  // Keep the mesh converged as the stage changes.
  //
  // Peer setup used to happen only inside toggleMic, and only for peers whose id
  // sorted above the viewer's. If the lower-sorting id joined last, nobody ever
  // offered and the call stayed silent. The same gap appeared whenever someone
  // was promoted to the stage after both sides had already turned their mic on.
  // Deciding by id still avoids a double offer, but it is now re-evaluated on
  // every stage change, so the peer that should speak up always does.
  useEffect(() => {
    if (!joined || !micOn) return;
    for (const id of peersToOfferTo({ viewerId, peerIds: stageOthers.map((m) => m.id), layout: room?.layout, isHost })) {
      ensurePeer(id, true);
    }
  }, [joined, micOn, stageOthers, room?.layout, isHost, viewerId, ensurePeer]);

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

  const energy = Math.min(100, Math.round((room.hype / 60) * 100));
  const kindMeta = ROOM_KINDS[room.kind];
  // Zoom-style spotlight: the person actually talking is the big tile; with
  // nobody talking it falls back to the host, so the tile is never empty and the
  // room always has a face.
  const spotlight = stage.find((m) => speaking.has(m.id)) ?? stage.find((m) => m.role === "host") ?? stage[0];
  const othersOnStage = stage.filter((m) => m.id !== spotlight?.id);
  const canBroadcast = room.layout === "broadcast" && (room.kind === "voice" || room.kind === "listen" || room.kind === "other");

  return (
    <div className={`studio kind-${room.kind}`}>
      <div className="studio-top">
        <button className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeftIcon width={18} height={18} /></button>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="studio-title truncate">{room.title}</div>
          <div className="meta">
            <kindMeta.Icon width={12} height={12} /> {kindMeta.label} · {room.host.displayName} · {room.memberCount} here
            {channelStatus !== "open" && <span className="live-dot connecting" title="Reconnecting" />}
          </div>
        </div>
        {room.state === "live" && <span className="live-badge"><span className="live-dot" /> LIVE</span>}
      </div>

      <p className="kind-tagline meta">{kindMeta.tagline}</p>

      {/* Energy meter: reactions and gifts in the last hour. */}
      <div className="energy" aria-label={`Room energy ${energy}%`}>
        <FlameIcon className="energy-flame" width={16} height={16} />
        <span className="energy-track"><span className="energy-fill" style={{ width: `${energy}%` }} /></span>
        <span className="energy-value">{room.hype}</span>
      </div>

      {room.bannerUrl && <img className="room-banner" src={mediaSrc(room.bannerUrl)} alt="" loading="lazy" />}

      {/* The one panel this kind exists for. */}
      {room.kind === "sports" && (
        <Scoreboard roomId={room.id} score={score} isHost={isHost} onChanged={load} />
      )}
      {(room.kind === "listen" || room.kind === "music") && (
        <AudioQueue roomId={room.id} queue={room.audioQueue ?? []} isHost={isHost} onChanged={load} />
      )}
      {room.kind === "movie" && <WatchPanel room={room} />}

      {/* The stage, as a Zoom-like gallery: one big tile for whoever is speaking,
          and everyone else in a grid beneath it. The grid used to be a row of
          small squares with the role as a label, so a busy room read as a list
          rather than as people in a call. */}
      {canSpeak && (
        <section className="stage" aria-label="Stage">
          <div className="stage-head">
            <span className="eyebrow"><MicIcon width={13} height={13} /> Stage · {stage.length}</span>
            {room.layout === "broadcast" && (
              <span className="meta">Broadcast — the host speaks, everyone listens</span>
            )}
            {room.layout === "stage" && stage.length > MESH_SPEAKER_LIMIT && (
              <span className="meta">P2P mesh — best with {MESH_SPEAKER_LIMIT} or fewer speakers</span>
            )}
          </div>

          {!spotlight ? (
            <p className="meta">The stage is open. Join it to speak.</p>
          ) : (
            <div className="stage-gallery">
              <div className={`stage-tile spotlight${speaking.has(spotlight.id) ? " speaking" : ""}${spotlight.muted ? " muted" : ""}`}>
                <Avatar name={spotlight.displayName} url={spotlight.avatarUrl} seed={spotlight.id} className="stage-tile-face" />
                <span className="stage-tile-bar">
                  <span className="stage-name truncate">{spotlight.id === viewerId ? "You" : spotlight.displayName}</span>
                  {spotlight.muted && <span className="stage-mute" title="Muted"><MicIcon width={12} height={12} /></span>}
                </span>
                <span className="stage-role">{spotlight.role === "host" ? "Host" : "Speaker"}</span>
                {isHost && spotlight.id !== viewerId && (
                  <div className="stage-controls">
                    {spotlight.role === "speaker" && (
                      <button className="mini" onClick={() => void stageAction(spotlight.id, "demote")} title="Send to audience">↓</button>
                    )}
                    <button className="mini" onClick={() => void stageAction(spotlight.id, spotlight.muted ? "unmute" : "mute")} title={spotlight.muted ? "Unmute" : "Mute"}>
                      {spotlight.muted ? <MicOffIcon width={13} height={13} /> : <MicOnIcon width={13} height={13} />}
                    </button>
                  </div>
                )}
              </div>

              {othersOnStage.length > 0 && (
                <div className="stage-row">
                  {othersOnStage.map((m) => (
                    <div key={m.id} className={`stage-tile${speaking.has(m.id) ? " speaking" : ""}${m.muted ? " muted" : ""}`}>
                      <Avatar name={m.displayName} url={m.avatarUrl} seed={m.id} className="stage-tile-face" />
                      <span className="stage-tile-bar">
                        <span className="stage-name truncate">{m.id === viewerId ? "You" : m.displayName}</span>
                        {m.muted && <span className="stage-mute" title="Muted"><MicIcon width={12} height={12} /></span>}
                      </span>
                      {isHost && m.id !== viewerId && (
                        <div className="stage-controls">
                          {m.role === "speaker" && (
                            <button className="mini" onClick={() => void stageAction(m.id, "demote")} title="Send to audience">↓</button>
                          )}
                          <button className="mini" onClick={() => void stageAction(m.id, m.muted ? "unmute" : "mute")} title={m.muted ? "Unmute" : "Mute"}>
                            {m.muted ? <MicOffIcon width={13} height={13} /> : <MicOnIcon width={13} height={13} />}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Broadcast mode: a listener can still ask to speak and be brought up. */}
          {canBroadcast && !isOnStage && (
            <p className="meta">You are in the audience. Raise a hand and the host can bring you up.</p>
          )}
        </section>
      )}

      {/* Floating energy bursts. */}
      <div className="burst-layer" aria-hidden="true">
        {bursts.map((b) => (
          <span key={b.id} className="burst" style={{ left: `${b.left}%` }}><GiftArt id={b.art} size={30} /></span>
        ))}
      </div>

      {/* Reaction bar + mic share one dock that stays in reach while the room
          scrolls. The mic is the control you must never have to hunt for, and
          reactions belong next to it, not above it. */}
      <div className="studio-dock">
        <div className="react-bar" role="group" aria-label="Reactions">
          {REACTIONS.map((r) => (
            <button key={r.id} className="react-emoji" onClick={() => void react(r.id)} aria-label={`React ${r.label}`}>
              <GiftArt id={r.id} size={26} />
            </button>
          ))}
          <button className="react-emoji gift" onClick={() => setGifting(true)} aria-label="Send a gift"><CheerIcon width={18} height={18} /></button>
          <button className="react-emoji gift" onClick={() => setPaidGifting(true)} aria-label="Send a paid gift"><GiftIcon width={18} height={18} /></button>
        </div>

        {/* One row, always the same height: the mic, the hand, the people count
            and one More. A wrapping row of every control made the dock four rows
            tall, and because it sticks to the bottom of the scroll it then sat
            over the stage and the conversation. */}
        <div className="studio-controls">
          {canSpeak && (
            <button
              className={`btn mic-btn${micOn ? " live" : ""}`}
              onClick={() => void toggleMic()}
              aria-pressed={micOn}
              title={micOn ? "Mute your microphone" : "Turn your microphone on"}
            >
              {micOn ? <MicOnIcon width={17} height={17} /> : <MicOffIcon width={17} height={17} />}
              <span className="mic-btn-label">{micOn ? "Mic on" : "Mic off"}</span>
              <span className="mic-meter" aria-hidden="true">
                <span className="mic-meter-fill" style={{ width: `${micOn ? micLevel : 0}%` }} />
              </span>
            </button>
          )}
          {!isOnStage && canSpeak && (
            <button
              className="btn ghost icon-only"
              onClick={() => void raiseHand(true)}
              disabled={audience.find((a) => a.id === viewerId)?.handRaised}
              title={audience.find((a) => a.id === viewerId)?.handRaised ? "Hand raised" : "Raise hand"}
              aria-label={audience.find((a) => a.id === viewerId)?.handRaised ? "Hand raised" : "Raise hand"}
            >
              <HandIcon width={16} height={16} />
            </button>
          )}
          <button
            className="btn ghost"
            onClick={() => setPeople(true)}
            aria-label={`People, ${stage.length + audience.length} in the room`}
            title="People in the room"
          >
            <UsersIcon width={15} height={15} /> {stage.length + audience.length}
          </button>
          {!joined ? (
            <button className="btn" onClick={() => void join()} disabled={busy}>Join</button>
          ) : (
            <button className="btn" onClick={() => void leaveRoom()}><LogOutIcon width={15} height={15} /> Leave</button>
          )}
          <button className="btn ghost icon-only" onClick={() => setMore(true)} title="More" aria-label="More controls">
            <MoreIcon width={17} height={17} />
          </button>
        </div>
        {/* Only when it says something the button does not. The mic button
            already reads "Mic off", and when there is an error the notice below
            is the useful message. */}
        {canSpeak && micOn && !micError && (
          <p className="meta mic-state">
            {isOnStage ? "You are on the stage — everyone can hear you." : "You are unmuted; the host can bring you up."}
          </p>
        )}
        {micError && <div className="notice">{micError}</div>}
      </div>

      {/* Host: hands raised, waiting to be brought up. */}
      {isHost && audience.some((a) => a.handRaised) && (
        <div className="card hands">
          <p className="eyebrow"><HandIcon width={13} height={13} /> Hands raised</p>
          {audience.filter((a) => a.handRaised).map((a) => (
            <div key={a.id} className="row spread">
              <span>@{a.handle}</span>
              <button className="btn small primary" onClick={() => void stageAction(a.id, "promote")}>Invite to speak</button>
            </div>
          ))}
        </div>
      )}

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

      {room.externalUrl && (
        <p className="meta row" style={{ gap: 4 }}>
          <LinkIcon width={13} height={13} />
          {room.playbackMode === "synchronized" ? "Synchronized playback through the licensed service" : "Coordinated — open on the licensed service"}
          {" "}· <a href={room.externalUrl} target="_blank" rel="noreferrer">open</a>
        </p>
      )}

      {room.isTicketed && ticket?.status !== "granted" && (
        <TicketPanel room={room} onBuy={() => void buyTicket()} />
      )}

      {message && <p className="meta row" style={{ gap: 4 }}><CheckIcon width={13} height={13} /> {message}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {/* Audience. */}
      <section className="audience" aria-label="Audience">
        <span className="eyebrow"><UsersIcon width={13} height={13} /> Audience · {audience.length}</span>
        <div className="audience-strip">
          {audience.map((a) => (
            <span key={a.id} className="audience-chip" title={`@${a.handle}`}>
              {a.handRaised && <HandIcon width={11} height={11} />}
              {a.id === viewerId ? "You" : a.displayName}
            </span>
          ))}
          {audience.length === 0 && <span className="meta">No one in the audience yet.</span>}
        </div>
      </section>

      {/* Chat. */}
      <ul className="room-posts">
        {posts.map((p) => (
          <li key={p.id} className="room-post">
            <div className="meta row" style={{ gap: 6 }}>
              <strong>{p.author.displayName}</strong>
              {p.author.kind !== "person" && <span className="host-tag"><ShieldIcon width={11} height={11} /> Official host</span>}
              <span className="muted">{new Date(p.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {p.hidden && !revealed.has(p.id) ? (
              <button className="spoiler" onClick={() => setRevealed((s) => new Set(s).add(p.id))}>Spoiler — tap to reveal</button>
            ) : (<p>{p.body}</p>)}
          </li>
        ))}
        {posts.length === 0 && <li className="empty"><p>No messages yet. Say hello.</p></li>}
      </ul>

      <div className="composer">
        <input className="input" value={draft} placeholder="Add to the conversation" aria-label="Message"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} />
        <button className="btn small" onClick={send} disabled={busy || !draft.trim()}>Send</button>
      </div>

      {gifting && <GiftSheet roomId={room.id} authorName={room.host.displayName} onClose={() => setGifting(false)} onSent={load} />}
      {paidGifting && (
        <PaidGiftSheet recipientId={room.host.id} recipientName={room.host.handle} roomId={room.id} onClose={() => setPaidGifting(false)} onPurchased={load} />
      )}
      {editing && <RoomEditSheet room={room} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />}
      {more && (
        <MoreSheet
          isHost={isHost}
          isLive={room.state === "live"}
          canMuteAll={canSpeak && stage.some((m) => m.role === "speaker" && !m.muted)}
          busy={busy}
          onShare={() => { setMore(false); void share(); }}
          onEdit={() => { setMore(false); setEditing(true); }}
          onMuteAll={() => { setMore(false); void muteAll(); }}
          onEndRoom={() => { setMore(false); void endRoom(); }}
          onDelete={() => { setMore(false); void removeRoom(); }}
          onClose={() => setMore(false)}
        />
      )}
      {people && (
        <PeopleSheet
          stage={stage}
          audience={audience}
          viewerId={viewerId}
          isHost={isHost}
          canSpeak={canSpeak}
          onClose={() => setPeople(false)}
          onStageAction={stageAction}
          onKick={kickMember}
        />
      )}
    </div>
  );
}

/** Host edit sheet: retitle, retopic, rules, banner, visibility, price. */
function RoomEditSheet({ room, onClose, onSaved }: { room: Room; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(room.title);
  const [topic, setTopic] = useState(room.topic ?? "");
  const [rules, setRules] = useState(room.rules ?? "");
  const [city, setCity] = useState(room.city ?? "");
  const [visibility, setVisibility] = useState(room.visibility);
  const [layout, setLayout] = useState(room.layout ?? "stage");
  const [bannerUrl, setBannerUrl] = useState(room.bannerUrl ?? "");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickBanner(file?: File) {
    if (!file) return;
    setUploading(true);
    try { setBannerUrl(await uploadImageFile(file, 1280)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not upload that image"); }
    finally { setUploading(false); }
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      await api(`/v1/activities/rooms/${room.id}`, {
        method: "PATCH",
        body: { title, topic: topic || null, rules: rules || null, city: city || null, visibility, layout, bannerUrl: bannerUrl || null },
      });
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save"); }
    finally { setBusy(false); }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet-card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Edit room</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><CloseIcon width={18} height={18} /></button>
        </div>
        {error && <div className="notice danger">{error}</div>}
        <label htmlFor="rt">Title</label>
        <input id="rt" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
        <label htmlFor="rtopic">Topic</label>
        <input id="rtopic" className="input" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={400} />
        <label htmlFor="rrules">House rules</label>
        <textarea id="rrules" className="input" rows={2} value={rules} onChange={(e) => setRules(e.target.value)} maxLength={1000} />
        <label htmlFor="rcity">City</label>
        <input id="rcity" className="input" value={city} onChange={(e) => setCity(e.target.value)} />
        <label htmlFor="rvis">Visibility</label>
        <select id="rvis" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "private")}>
          <option value="public">Public</option>
          <option value="private">Private (members only)</option>
        </select>
        {(room.kind === "voice" || room.kind === "listen" || room.kind === "other") && (
          <>
            <label htmlFor="rlayout">Format</label>
            <select id="rlayout" className="input" value={layout} onChange={(e) => setLayout(e.target.value as "stage" | "broadcast")}>
              <option value="stage">Open mic — everyone on stage can talk</option>
              <option value="broadcast">Broadcast — you speak, everyone listens</option>
            </select>
          </>
        )}
        <label>Banner</label>
        {bannerUrl && <img className="room-banner" src={mediaSrc(bannerUrl)} alt="" />}
        <label className="dropzone">
          <UploadIcon width={18} height={18} />
          <span>{uploading ? "Uploading…" : "Replace banner"}</span>
          <input type="file" accept="image/*" hidden onChange={(e) => void pickBanner(e.target.files?.[0])} />
        </label>
        <button className="btn primary block" onClick={() => void save()} disabled={busy || uploading || !title.trim()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

/**
 * The people roster: who is on the stage and who is listening, with the host's
 * controls on each row. The audience used to be a strip of chips with no way to
 * act on anyone, so a host could see a name and do nothing about it.
 */
function PeopleSheet({
  stage, audience, viewerId, isHost, canSpeak, onClose, onStageAction, onKick,
}: {
  stage: Member[];
  audience: Member[];
  viewerId: string;
  isHost: boolean;
  canSpeak: boolean;
  onClose: () => void;
  onStageAction: (userId: string, action: "promote" | "demote" | "mute" | "unmute") => void;
  onKick: (userId: string) => void;
}) {
  const row = (m: Member) => {
    const isSelf = m.id === viewerId;
    return (
      <li key={m.id} className="people-row">
        <Avatar name={m.displayName} url={m.avatarUrl} seed={m.id} size="sm" />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="people-name truncate">{isSelf ? "You" : m.displayName}</span>
          <span className="meta row" style={{ gap: 4 }}>
            {m.role === "host" ? "Host" : m.role === "speaker" ? "Speaker" : "Listener"}
            {m.handRaised && <><HandIcon width={11} height={11} /> Hand raised</>}
            {m.muted && <><MicIcon width={11} height={11} /> Muted</>}
          </span>
        </span>
        {isHost && !isSelf && m.role !== "host" && (
          <span className="people-actions">
            {canSpeak && (m.role === "speaker" ? (
              <button className="mini" onClick={() => onStageAction(m.id, "demote")} title="Send to audience">↓</button>
            ) : (
              <button className="mini" onClick={() => onStageAction(m.id, "promote")} title="Invite to speak">↑</button>
            ))}
            {canSpeak && m.role === "speaker" && (
              <button className="mini" onClick={() => onStageAction(m.id, m.muted ? "unmute" : "mute")} title={m.muted ? "Unmute" : "Mute"}>
                {m.muted ? <MicOffIcon width={13} height={13} /> : <MicOnIcon width={13} height={13} />}
              </button>
            )}
            <button className="mini danger" onClick={() => onKick(m.id)} title="Remove from room">✕</button>
          </span>
        )}
      </li>
    );
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet-card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>People</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><CloseIcon width={18} height={18} /></button>
        </div>

        <p className="eyebrow"><MicIcon width={13} height={13} /> On stage · {stage.length}</p>
        <ul className="people-list">
          {stage.map(row)}
          {stage.length === 0 && <li className="meta">No one is on the stage.</li>}
        </ul>

        <p className="eyebrow"><UsersIcon width={13} height={13} /> Listening · {audience.length}</p>
        <ul className="people-list">
          {audience.map(row)}
          {audience.length === 0 && <li className="meta">No one is listening yet.</li>}
        </ul>
      </div>
    </div>
  );
}


/**
 * Everything that is not the mic. The dock keeps one row for the controls a
 * call cannot work without; the rest lives here, so the bar never wraps and
 * never grows over the room.
 */
function MoreSheet({
  isHost, isLive, canMuteAll, busy, onShare, onEdit, onMuteAll, onEndRoom, onDelete, onClose,
}: {
  isHost: boolean;
  isLive: boolean;
  canMuteAll: boolean;
  busy: boolean;
  onShare: () => void;
  onEdit: () => void;
  onMuteAll: () => void;
  onEndRoom: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet-card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Room controls</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><CloseIcon width={18} height={18} /></button>
        </div>

        <div className="sheet-actions">
          <button className="menu-item" onClick={onShare}><ShareIcon width={17} height={17} /> Copy invite link</button>
          {isHost && <button className="menu-item" onClick={onEdit}><EditIcon width={17} height={17} /> Edit room</button>}
          {isHost && canMuteAll && (
            <button className="menu-item" onClick={onMuteAll}><MicOffIcon width={17} height={17} /> Mute everyone on stage</button>
          )}
          {isHost && isLive && (
            <button className="menu-item danger" onClick={onEndRoom} disabled={busy}>End room for everyone</button>
          )}
          {isHost && (
            <button className="menu-item danger" onClick={onDelete}><TrashIcon width={17} height={17} /> Delete room</button>
          )}
        </div>
      </div>
    </div>
  );
}

