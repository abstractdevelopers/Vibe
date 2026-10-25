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
  ArrowLeftIcon, BellIcon, ChatIcon, CheckIcon, CheerIcon, CloseIcon, EditIcon, FlameIcon, GiftIcon,
  HandIcon, HeadphonesIcon, LinkIcon, MicIcon, MicOffIcon, MicOnIcon, MusicIcon, RadioIcon,
  LogOutIcon, MoreIcon, ShareIcon, ShieldIcon, TicketIcon, TrashIcon, UploadIcon, UsersIcon,
} from "./Icons";
import { GiftArt } from "./GiftArt";
// A room is its own place with its own material; the sheet is lazy, so its CSS
// splits with it and the launch bundle pays nothing for it.
import "../room.css";

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
  dataSource: string | null;
  dataSourceUrl: string | null;
  externalUrl: string | null;
  playbackMode: "coordinated" | "synchronized";
  spoilerPolicy: "open" | "spoiler_safe";
  layout: "stage" | "broadcast";
  allowHands: boolean;
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
  // True once the browser refuses to start a remote stream without a gesture.
  // The room then offers one explicit "Tap to hear" button rather than leaving
  // someone staring at a silent stage and blaming the app.
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [panel, setPanel] = useState<"stage" | "chat">("stage");

  const localStream = useRef<MediaStream | null>(null);
  const peerConns = useRef<Map<string, RTCPeerConnection>>(new Map());
  // ICE servers (STUN + TURN) are fetched once, before the first peer is made.
  const iceServersRef = useRef<{ urls: string | string[]; username?: string; credential?: string }[]>([
    { urls: "stun:stun.l.google.com:19302" },
  ]);
  const iceLoadedRef = useRef(false);

  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map());
  /** Candidates that arrived before their peer's remote description. */
  const pendingIce = useRef<Map<string, RTCIceCandidate[]>>(new Map());

  /** Try to start every remote stream. Returns true when they are all playing. */
  const playRemoteAudio = useCallback(async (): Promise<boolean> => {
    let ok = true;
    for (const el of audioEls.current.values()) {
      try {
        await el.play();
      } catch {
        ok = false;
      }
    }
    return ok;
  }, []);
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
    pendingIce.current.delete(id);
    const a = analysers.current.get(id);
    if (a) { cancelAnimationFrame(a.raf); a.ctx.close(); analysers.current.delete(id); }
    setPeers((prev) => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  // Declared first, because `ensurePeer` and the offer path read it at call
  // time. It used to be declared after `ensurePeer`, which captured the
  // initial no-op through a memoised closure — every offer and ICE candidate
  // was then sent into a function that did nothing, and the pair never
  // connected. Reading through a ref keeps the value current without
  // re-creating the peer callbacks on every render.
  const signalRef = useRef<(msg: Record<string, unknown>) => void>(() => {});

  /**
   * Attach a remote stream.
   *
   * The audio element is rendered by this component rather than created here
   * and left detached: a media element that is not in the document is allowed
   * to play in some browsers and silently not in others, and there was no way
   * for a listener to tell "nobody is talking" from "I cannot hear anything".
   * The stream goes into state; the JSX mounts one `<audio>` per peer and this
   * function tries to start it. If the browser blocks autoplay (it will unless
   * the click that joined the room counts), `audioBlocked` is set and the room
   * shows a single "Tap to hear" control instead of pretending to work.
   */
  const attachAudio = useCallback((id: string, stream: MediaStream) => {
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

  /**
   * Put the local microphone on an existing peer connection.
   *
   * A peer is often created by an *incoming* offer before this browser has ever
   * opened its microphone — a listener answers the host, or two people join at
   * once and the lower id offers first. At that moment there is no local track
   * to add, and the old code never revisited the connection, so when that person
   * later pressed "Mic on" the track was enabled but never attached to any
   * sender: they were audible to themselves and to nobody else. Adding the
   * track here (and renegotiating as the polite peer) closes that hole.
   */
  const syncLocalTracks = useCallback((peerId: string, pc: RTCPeerConnection) => {
    const stream = localStream.current;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      const already = pc.getSenders().some((s) => s.track === track);
      if (!already) {
        // A listener's peer already has a receive-only audio transceiver, put
        // there so the offer had something to negotiate. Reuse it and flip the
        // direction, rather than adding a second m-line for the same audio.
        const idle = pc.getTransceivers().find(
          (t) => t.receiver.track.kind === "audio" && !t.sender.track && t.direction === "recvonly",
        );
        if (idle) {
          idle.direction = "sendrecv";
          void idle.sender.replaceTrack(track).catch(() => {});
        } else {
          pc.addTrack(track, stream);
        }
        // Renegotiation is driven by whoever is not the offering side, so a
        // single new track cannot start a glare between two peers.
        void pc
          .createOffer()
          .then((offer) => pc.setLocalDescription(offer).then(() => offer))
          .then((offer) => signalRef.current({ type: "rtc.offer", to: peerId, payload: offer }))
          .catch(() => { /* the next stage change retries */ });
      }
    }
  }, []);

  const ensurePeer = useCallback((peerId: string, initiator: boolean): RTCPeerConnection => {
    const existing = peerConns.current.get(peerId);
    if (existing) {
      if (initiator) syncLocalTracks(peerId, existing);
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    peerConns.current.set(peerId, pc);
    const localTracks = localStream.current?.getTracks() ?? [];
    if (localTracks.length > 0) {
      localTracks.forEach((t) => pc.addTrack(t, localStream.current!));
    } else {
      // A listener has no local track, but an offer still needs an m-line to
      // negotiate. Without one the SDP is a bare header with no media, so ICE
      // never gathers and the connection sits at `new` — the room looks
      // connected and is silent. Ask for receive-only audio instead.
      pc.addTransceiver("audio", { direction: "recvonly" });
    }
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
    // The offer must not depend on a local microphone. A listener has no
    // stream, but their connection is what carries the audio to them; gating
    // the offer on `localStream` left every audience member with a peer that
    // never negotiated. A connection with no local track is perfectly valid.
    if (initiator) {
      void pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => signalRef.current({ type: "rtc.offer", to: peerId, payload: offer }))
        .catch(() => { /* negotiation retried on next stage change */ });
    }
    return pc;
  }, [attachAudio, closePeer, syncLocalTracks]);

  /** Add candidates that arrived before the peer had a remote description. */
  const flushIce = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const queued = pendingIce.current.get(peerId);
    if (!queued) return;
    pendingIce.current.delete(peerId);
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
  }, []);

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
        .then(() => flushIce(from, pc))
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer).then(() => answer))
        .then((answer) => signalRef.current({ type: "rtc.answer", to: from, payload: answer }))
        .catch(() => {});
      return;
    }
    if (event.type === "rtc.answer" && p.to === viewerId) {
      // Only an answer to an offer this browser made. `ensurePeer` here would
      // create a second connection for a pair that already has one.
      const from = String(p.from);
      const pc = peerConns.current.get(from);
      if (pc) {
        void pc.setRemoteDescription(new RTCSessionDescription(p.data as RTCSessionDescriptionInit))
          .then(() => flushIce(from, pc))
          .catch(() => {});
      }
      return;
    }
    if (event.type === "rtc.ice" && p.to === viewerId) {
      const from = String(p.from);
      const pc = peerConns.current.get(from);
      const candidate = new RTCIceCandidate(p.data as RTCIceCandidateInit);
      // A candidate can arrive before the remote description it belongs to
      // (offer and ICE are separate frames). Adding it then throws, and the
      // connection is left with no route — so queue it until there is one.
      if (!pc || !pc.remoteDescription) {
        pendingIce.current.set(from, [...(pendingIce.current.get(from) ?? []), candidate]);
        return;
      }
      void pc.addIceCandidate(candidate).catch(() => {});
    }
  }, [ensurePeer, load, flushIce]);

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
      // The mic can need a moment to open. Remember the click so the auto-mute
      // effect does not immediately undo it, and so a second click while the
      // browser is still asking for permission is treated as "turn it on",
      // not as "turn off something that is not on yet".
      micWanted.current = true;
      const stream = await ensureLocalStream();
      stream.getAudioTracks().forEach((t) => { t.enabled = true; });
      startLocalMeter(stream);
      setMicOn(true);
    } catch {
      micWanted.current = false;
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
  // The user's intent for the mic. It can lead the rendered state by a moment
  // while getUserMedia resolves, so it is only ever written by an explicit
  // action, never derived from state on every render.
  const micWanted = useRef(false);
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
  //
  // It runs once per arrival, not on every stage change: re-running it would
  // turn the microphone back on after someone deliberately muted themselves.
  const autoMicDone = useRef(false);
  useEffect(() => {
    if (!joined || !canSpeak) return;
    if (!isHost && !isOnStage) return;
    if (autoMicDone.current) return;
    autoMicDone.current = true;
    if (!micOn) void toggleMic();
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

  async function stageAction(userId: string, action: "promote" | "demote" | "mute" | "unmute" | "decline") {
    try { await api(`/v1/activities/rooms/${roomId}/stage`, { body: { userId, action } }); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not change the stage"); }
  }

  /** Turn hand-raising on or off for the room. Clubhouse lets a host do this. */
  async function toggleHands(next: boolean) {
    try {
      await api(`/v1/activities/rooms/${roomId}`, { method: "PATCH", body: { allowHands: next } });
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not change hand raising"); }
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
  // Who this viewer must hear. A listener hears the whole stage; a speaker
  // hears the other speakers. In a broadcast room only the host publishes, so
  // that is the one peer worth connecting to.
  const hearPeers = useMemo(() => {
    if (!room) return [];
    if (room.layout === "broadcast") {
      return room.host.id === viewerId ? [] : [room.host.id];
    }
    return stageOthers.map((m) => m.id);
  }, [room, stageOthers, viewerId]);
  const hearKey = hearPeers.join(",");

  useActivityTheme(room ? themeForRoom(room.kind) : null);

  // Keep the mesh converged.
  //
  // The connection belongs to whoever wants the audio, not to whoever produces
  // it. An audience member publishes nothing, but they still need a peer
  // connection per speaker to hear anything at all — this is the whole point of
  // a voice room. The earlier version only built peers while the viewer's own
  // mic was on, so joining as a listener gave you a room that looked alive and
  // made no sound.
  //
  // It must also re-run when the stage changes. A person promoted after both
  // sides were already connected would otherwise never be meshed in, and a
  // speaker who leaves would keep a dead peer.
  useEffect(() => {
    if (!joined || !room) return;
    if (!(room.kind === "voice" || room.kind === "listen" || room.kind === "other")) return;
    if (!globalThis.RTCPeerConnection) return;
    const wanted = new Set(hearPeers);
    for (const [id, pc] of peerConns.current) {
      if (!wanted.has(id)) { pc.close(); closePeer(id); }
    }
    for (const id of peersToOfferTo({ viewerId, peerIds: hearPeers, layout: room.layout, isHost })) {
      ensurePeer(id, true);
    }
    // A peer that is already connected but has no local track needs one now
    // that the viewer has spoken.
    if (micOn) {
      for (const id of hearPeers) {
        const pc = peerConns.current.get(id);
        if (pc) syncLocalTracks(id, pc);
      }
    }
    // hearKey stands in for the array identity so this does not re-run on every
    // roster poll that returns the same people.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, room?.kind, room?.layout, hearKey, micOn, isHost, viewerId, ensurePeer, closePeer, syncLocalTracks]);

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

  const kindMeta = ROOM_KINDS[room.kind];
  // The stage is a ring of people, so the "spotlight" is no longer a single
  // tile: whoever is talking is scaled up and ringed, and everyone else sits
  // beside them. With nobody talking the host is visually first, so the stage
  // still has a centre.
  const speakingNow = stage.filter((m) => speaking.has(m.id));
  const stageOrder = [...stage].sort((a, b) => {
    const rank = (m: Member) => (speaking.has(m.id) ? 0 : m.role === "host" ? 1 : 2);
    return rank(a) - rank(b);
  });
  const myHand = audience.find((a) => a.id === viewerId)?.handRaised ?? false;
  const canBroadcast = room.layout === "broadcast" && (room.kind === "voice" || room.kind === "listen" || room.kind === "other");
  const stageEmptyCopy = room.layout === "broadcast"
    ? "The host has not opened the stage yet."
    : "Join and the host can bring you up to speak.";
  // A room with nothing to listen to does not need a stage panel; go straight
  // to the conversation. A live voice room always opens on the stage.
  const showsStagePanel = canSpeak && stage.length > 0;
  const activePanel: "stage" | "chat" = panel === "stage" && showsStagePanel ? "stage" : "chat";

  return (
    <div className={`studio kind-${room.kind} panel-${activePanel}${room.bannerUrl ? "" : " no-banner"}`}>
      {/* One audio element per remote peer. Mounted, not detached: a media
          element outside the document may play in one browser and stay silent
          in another, and a blocked autoplay is surfaced as "Tap to hear". */}
      <div className="studio-audio" aria-hidden="true">
        {Object.entries(peers).map(([id, stream]) => (
          <audio
            key={id}
            autoPlay
            playsInline
            ref={(el) => {
              if (!el) {
                audioEls.current.delete(id);
                return;
              }
              audioEls.current.set(id, el);
              if (el.srcObject !== stream) el.srcObject = stream;
              void el.play().catch(() => setAudioBlocked(true));
            }}
          />
        ))}
      </div>

      <div className="studio-backdrop" aria-hidden="true">
        {room.bannerUrl && <img src={mediaSrc(room.bannerUrl)} alt="" />}
      </div>

      <header className="studio-top">
        <button className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeftIcon width={18} height={18} /></button>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="studio-title truncate">{room.title}</div>
          <div className="studio-sub">
            <span className="studio-kind"><kindMeta.Icon width={12} height={12} /> {kindMeta.label}</span>
            <span className="studio-dot" aria-hidden>·</span>
            <span className="truncate">{room.host.displayName}</span>
            <span className="studio-dot" aria-hidden>·</span>
            <span className="studio-people"><UsersIcon width={12} height={12} /> {room.memberCount}</span>
            {channelStatus !== "open" && <span className="live-dot connecting" title="Reconnecting" />}
          </div>
        </div>
        {room.state === "live" && <span className="live-badge"><span className="live-dot" /> LIVE</span>}
      </header>

      {/* One segmented switch, always present, so the conversation is never a
          screen away. It sits under the title rather than in the flow, so it
          costs the stage no height. */}
      <div className="studio-switch" role="tablist" aria-label="Room panel">
        {showsStagePanel && (
          <button
            role="tab"
            aria-selected={activePanel === "stage"}
            className={`switch-seg${activePanel === "stage" ? " is-on" : ""}`}
            onClick={() => setPanel("stage")}
          >
            <MicIcon width={13} height={13} /> Stage
            <span className="switch-count">{stage.length}</span>
          </button>
        )}
        <button
          role="tab"
          aria-selected={activePanel === "chat"}
          className={`switch-seg${activePanel === "chat" ? " is-on" : ""}`}
          onClick={() => setPanel("chat")}
        >
          <ChatIcon width={13} height={13} /> Chat
          {posts.length > 0 && <span className="switch-count">{posts.length}</span>}
        </button>
      </div>

      {audioBlocked && (
        <button
          className="studio-unmute"
          onClick={() => { void playRemoteAudio().then((ok) => setAudioBlocked(!ok)); }}
        >
          <HeadphonesIcon width={16} height={16} /> Tap to hear the room
        </button>
      )}

      {activePanel === "stage" ? (
        <>
          {/* The stage: the room's one hero. Who is talking, at a glance. */}
          {canSpeak && (
            <section className="stage-hero" aria-label={`Stage, ${stage.length} on stage`}>
              <span className="stage-hero-mode">
                <MicIcon width={11} height={11} />
                {room.layout === "broadcast" ? "Broadcast" : "Open mic"}
              </span>
              <span className="stage-hero-count">
                <UsersIcon width={11} height={11} /> {stage.length}
              </span>

              {stage.length === 0 ? (
                <div className="stage-hero-empty">
                  <MicIcon width={22} height={22} />
                  <strong>The stage is open</strong>
                  <span>{stageEmptyCopy}</span>
                </div>
              ) : (
                <div className="stage-ring">
                  {stageOrder.map((m) => {
                    const isMe = m.id === viewerId;
                    const isSpeaking = speaking.has(m.id);
                    return (
                      <div
                        key={m.id}
                        className={`stage-person${isSpeaking ? " is-speaking" : ""}${m.muted ? " is-muted" : ""}`}
                        aria-label={`${isMe ? "You" : m.displayName}${m.role === "host" ? ", host" : ""}${isSpeaking ? ", speaking" : ""}${m.muted ? ", muted" : ""}`}
                      >
                        <span className="face">
                          <span className="ring" aria-hidden />
                          <Avatar name={m.displayName} url={m.avatarUrl} seed={m.id} />
                          {m.muted && (
                            <span className="stage-mute" title="Muted"><MicOffIcon width={12} height={12} /></span>
                          )}
                        </span>
                        <span className="name">{isMe ? "You" : m.displayName}</span>
                        <span className="role">
                          {m.role === "host" ? "Host" : m.muted ? "Muted" : isSpeaking ? "Speaking" : "Speaker"}
                        </span>
                        {isHost && !isMe && (
                          <span className="stage-person-tools">
                            {m.role === "speaker" && (
                              <button onClick={() => void stageAction(m.id, "demote")} title={`Send ${m.displayName} to the audience`} aria-label={`Send ${m.displayName} to the audience`}>↓</button>
                            )}
                            <button
                              onClick={() => void stageAction(m.id, m.muted ? "unmute" : "mute")}
                              title={m.muted ? `Unmute ${m.displayName}` : `Mute ${m.displayName}`}
                              aria-label={m.muted ? `Unmute ${m.displayName}` : `Mute ${m.displayName}`}
                            >
                              {m.muted ? <MicOffIcon width={13} height={13} /> : <MicOnIcon width={13} height={13} />}
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          <div className="room-facts">
            {room.kind === "sports" && <Scoreboard roomId={room.id} score={score} isHost={isHost} onChanged={load} />}
            {(room.kind === "listen" || room.kind === "music") && (
              <AudioQueue roomId={room.id} queue={room.audioQueue ?? []} isHost={isHost} onChanged={load} />
            )}
            {room.kind === "movie" && <WatchPanel room={room} />}

            {/* The audience, as faces on a rail. A room with forty listeners
                should look like forty people, not forty lines of text. */}
            {canSpeak && (
              <section aria-label={`Audience, ${audience.length} listening`}>
                <div className="fact-head">
                  <span className="fact-label"><UsersIcon width={12} height={12} /> Listening</span>
                  <span className="fact-count">{audience.length}</span>
                </div>
                {audience.length === 0 ? (
                  <p className="facts-empty">No one is listening yet. Share the room to fill it.</p>
                ) : (
                  <div className="audience-rail">
                    {audience.map((a) => (
                      <span
                        key={a.id}
                        className={`audience-face${a.handRaised ? " is-hand" : ""}`}
                        title={`${a.id === viewerId ? "You" : a.displayName}${a.handRaised ? " · hand raised" : ""}`}
                      >
                        <Avatar name={a.displayName} url={a.avatarUrl} seed={a.id} size="sm" />
                        {a.handRaised && <span className="audience-hand" aria-hidden><HandIcon width={10} height={10} /></span>}
                      </span>
                    ))}
                  </div>
                )}
                {canBroadcast && !isOnStage && (
                  <p className="facts-empty" style={{ marginTop: 8 }}>
                    You are in the audience. Raise a hand and the host can bring you up.
                  </p>
                )}
              </section>
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
              <p className="meta row" style={{ gap: 4, flexWrap: "wrap" }}>
                <LinkIcon width={13} height={13} />
                {room.playbackMode === "synchronized" ? "Synchronized through the licensed service" : "Coordinated — open on the licensed service"}
                {" "}· <a href={room.externalUrl} target="_blank" rel="noreferrer">open</a>
              </p>
            )}

            {room.dataSource && (
              <p className="meta row" style={{ gap: 4, flexWrap: "wrap" }}>
                <RadioIcon width={13} height={13} />
                Data: {room.dataSourceUrl
                  ? <a href={room.dataSourceUrl} target="_blank" rel="noreferrer">{room.dataSource}</a>
                  : room.dataSource}
              </p>
            )}

            {isHost && canSpeak && (
              <section aria-label="Hands raised">
                <div className="fact-head">
                  <span className="fact-label"><HandIcon width={12} height={12} /> Hands raised</span>
                  <button
                    className="btn small"
                    onClick={() => void toggleHands(!room.allowHands)}
                    aria-pressed={room.allowHands}
                  >
                    {room.allowHands ? "Open" : "Closed"}
                  </button>
                </div>
                {audience.filter((a) => a.handRaised).length === 0 ? (
                  <p className="facts-empty">
                    {room.allowHands ? "No hands raised yet." : "Hand raising is off. The audience can see this."}
                  </p>
                ) : (
                  <div className="stack">
                    {audience.filter((a) => a.handRaised).map((a) => (
                      <div key={a.id} className="row spread">
                        <span className="truncate">@{a.handle}</span>
                        <span className="people-actions">
                          <button className="btn small primary" onClick={() => void stageAction(a.id, "promote")}>Invite to speak</button>
                          <button className="mini" onClick={() => void stageAction(a.id, "decline")} title="Decline" aria-label={`Decline ${a.handle}`}><CloseIcon width={12} height={12} /></button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {room.rules && (
              <details className="studio-rules">
                <summary>House rules</summary>
                <p>{room.rules}</p>
              </details>
            )}
          </div>
        </>
      ) : (
        <div className="room-chat">
          {posts.length === 0 && <p className="chat-empty">No messages yet. Say hello.</p>}
          {posts.map((p) => (
            <div key={p.id} className="chat-bubble">
              <Avatar name={p.author.displayName} seed={p.author.id} size="sm" />
              <div className="chat-bubble-body">
                <div className="chat-meta">
                  <strong className="truncate">{p.author.displayName}</strong>
                  {p.author.kind !== "person" && <span className="host-tag"><ShieldIcon width={11} height={11} /> Official</span>}
                  <time>{new Date(p.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                </div>
                {p.hidden && !revealed.has(p.id) ? (
                  <button className="spoiler" onClick={() => setRevealed((s) => new Set(s).add(p.id))}>Spoiler — tap to reveal</button>
                ) : (<p className="chat-text">{p.body}</p>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {room.isTicketed && ticket?.status !== "granted" && (
        <TicketPanel room={room} onBuy={() => void buyTicket()} />
      )}

      <div className="studio-dock">
        {activePanel === "chat" ? (
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
        ) : (
          <div className="react-rail" role="group" aria-label="Reactions">
            {REACTIONS.slice(0, 5).map((r) => (
              <button key={r.id} className="react-chip" onClick={() => void react(r.id)} aria-label={`React ${r.label}`} title={r.label}>
                <GiftArt id={r.id} size={24} />
              </button>
            ))}
            <button className="react-chip" onClick={() => setGifting(true)} aria-label="Send a gift" title="Send a gift"><CheerIcon width={18} height={18} /></button>
            <button className="react-chip" onClick={() => setPaidGifting(true)} aria-label="Send a paid gift" title="Send a paid gift"><GiftIcon width={18} height={18} /></button>
          </div>
        )}

        <div className="studio-controls">
          {(isOnStage || isHost) && canSpeak ? (
            <button
              className={`mic-btn${micOn ? " live" : ""}`}
              onClick={() => void toggleMic()}
              aria-pressed={micOn}
              title={micOn ? "Mute your microphone" : "Turn your microphone on"}
            >
              <span className="mic-btn-icon">{micOn ? <MicOnIcon width={18} height={18} /> : <MicOffIcon width={18} height={18} />}</span>
              <span>{micOn ? "Mic on" : "Mic off"}</span>
              <span className="mic-meter" aria-hidden="true">
                <span className="mic-meter-fill" style={{ width: `${micOn ? micLevel : 0}%` }} />
              </span>
            </button>
          ) : null}

          {!isOnStage && canSpeak && !joined && (
            <button className="btn primary dock-cta" onClick={() => void join()} disabled={busy}>Join room</button>
          )}
          {!isOnStage && canSpeak && joined && room.allowHands && (
            <button
              className={`btn raise-hand dock-cta${myHand ? " waiting" : ""}`}
              onClick={() => void raiseHand(!myHand)}
              title={myHand ? "Lower your hand" : "Ask to speak"}
            >
              <HandIcon width={16} height={16} />
              <span>{myHand ? "Hand raised" : "Raise hand"}</span>
            </button>
          )}

          <button
            className="dock-btn"
            onClick={() => setPeople(true)}
            aria-label={`People, ${stage.length + audience.length} in the room`}
            title="People in the room"
          >
            <UsersIcon width={17} height={17} />
            <span className="dock-badge">{stage.length + audience.length}</span>
          </button>

          <button className="dock-btn" onClick={() => setMore(true)} title="More" aria-label="More controls">
            <MoreIcon width={18} height={18} />
          </button>

          {joined && (
            <button className="btn ghost dock-leave" onClick={() => void leaveRoom()} aria-label="Leave the room" title="Leave">
              <LogOutIcon width={15} height={15} />
            </button>
          )}
        </div>

        {micError && <div className="notice">{micError}</div>}
        {canSpeak && isOnStage && micOn && !micError && (
          <p className="mic-state">Live on stage — everyone can hear you.</p>
        )}
        {canSpeak && !isOnStage && myHand && (
          <p className="mic-state">Hand raised — the host decides who speaks.</p>
        )}
      </div>

      {message && <p className="meta row" style={{ gap: 4, padding: "0 var(--space-3)" }}><CheckIcon width={13} height={13} /> {message}</p>}
      {error && <p className="error" role="alert" style={{ padding: "0 var(--space-3)" }}>{error}</p>}

      <div className="burst-layer" aria-hidden="true">
        {bursts.map((b) => (
          <span key={b.id} className="burst" style={{ left: `${b.left}%` }}><GiftArt id={b.art} size={30} /></span>
        ))}
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
  onStageAction: (userId: string, action: "promote" | "demote" | "mute" | "unmute" | "decline") => void;
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
            {canSpeak && m.handRaised && m.role !== "speaker" && (
              <button className="mini" onClick={() => onStageAction(m.id, "decline")} title="Decline the raised hand" aria-label={`Decline ${m.handle}`}>✕</button>
            )}
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

