/**
 * WebRTC transport config and audio profiles.
 *
 * Two things make a call fail or sound bad in the field, and both are decided
 * here rather than scattered through the room component:
 *
 * 1. ICE. STUN alone only discovers a public address; it cannot relay. When two
 *    people sit behind symmetric NAT or a carrier-grade NAT — the norm on mobile
 *    networks — there is no direct path and the call simply never connects. A
 *    TURN relay is what makes those calls work. TURN credentials are served
 *    short-lived by the API (see `/v1/rtc/ice`), so no long-lived secret is
 *    baked into the client bundle.
 *
 * 2. Bitrate. 32 kbps Opus is clear speech but audibly lossy for music. A
 *    listen/music room raises the ceiling and turns off the speech filters that
 *    mangle music (noise suppression and auto gain chew up cymbals and dynamic
 *    range; echo cancellation is kept because a listener's speaker feeds back
 *    otherwise).
 */

import { apiUrl, getToken } from "./api";

const ICE_CACHE_MS = 10 * 60 * 1000;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

let cached: { at: number; servers: IceServer[] } | null = null;

/**
 * A last-resort public STUN server. It keeps two friendly networks connecting
 * even if the API's ICE endpoint is briefly unavailable; it is never enough on
 * its own, which is why TURN comes from the server.
 */
const FALLBACK: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export async function loadIceServers(): Promise<IceServer[]> {
  if (cached && Date.now() - cached.at < ICE_CACHE_MS) return cached.servers;
  try {
    // `/v1/rtc/ice` is session-gated: without the bearer token it answers 401
    // and the call silently falls back to STUN, which cannot relay through
    // carrier NAT.
    const token = getToken();
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(apiUrl("/v1/rtc/ice"), { headers });
    if (!res.ok) return FALLBACK;
    const data = (await res.json()) as { iceServers?: IceServer[] };
    const servers = data.iceServers?.length ? data.iceServers : FALLBACK;
    cached = { at: Date.now(), servers };
    return servers;
  } catch {
    return FALLBACK;
  }
}

/** Test seam. */
export function resetIceCache(): void {
  cached = null;
}

export interface AudioProfile {
  /** Sender bitrate ceiling, in bits per second. */
  maxBitrate: number;
  /** MediaTrackConstraints for getUserMedia. */
  constraints: globalThis.MediaTrackConstraints;
  /** True when the profile is tuned for music rather than speech. */
  music: boolean;
}

const SPEECH: AudioProfile = {
  maxBitrate: 32_000,
  music: false,
  constraints: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
  },
};

const MUSIC: AudioProfile = {
  // ~128 kbps stereo is transparent enough for music without a broadcast host's
  // uplink becoming the bottleneck. Noise suppression and auto-gain are off:
  // both are speech filters and both damage music.
  maxBitrate: 128_000,
  music: true,
  constraints: {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
    sampleRate: 48000,
  },
};

/**
 * Pick the audio profile for a room. `listen` and `music` rooms carry music and
 * get the wideband profile; everything else is a conversation.
 */
export function audioProfileFor(kind: string | null | undefined): AudioProfile {
  return kind === "listen" || kind === "music" ? MUSIC : SPEECH;
}
