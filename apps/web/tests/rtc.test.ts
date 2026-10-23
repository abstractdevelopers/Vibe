import { describe, expect, it, beforeEach } from "vitest";
import { audioProfileFor, loadIceServers, resetIceCache } from "../src/rtc";

/**
 * A music room must not sound like a phone call, and a call must connect on a
 * network where STUN alone fails. Both are decided here, so pin them.
 */
describe("audio profiles", () => {
  it("gives listen and music rooms a wideband, filter-free profile", () => {
    for (const kind of ["listen", "music"]) {
      const p = audioProfileFor(kind);
      expect(p.music).toBe(true);
      expect(p.maxBitrate).toBeGreaterThan(64_000);
      // Speech filters damage music and must be off.
      expect(p.constraints.noiseSuppression).toBe(false);
      expect(p.constraints.autoGainControl).toBe(false);
      expect(p.constraints.channelCount).toBe(2);
      // Echo cancellation stays: a listener's speaker feeds back otherwise.
      expect(p.constraints.echoCancellation).toBe(true);
    }
  });

  it("keeps conversation rooms on the speech profile", () => {
    for (const kind of ["voice", "sports", "other", null, undefined]) {
      const p = audioProfileFor(kind);
      expect(p.music).toBe(false);
      expect(p.maxBitrate).toBeLessThanOrEqual(64_000);
      expect(p.constraints.noiseSuppression).toBe(true);
      expect(p.constraints.autoGainControl).toBe(true);
    }
  });
});

describe("ICE servers", () => {
  beforeEach(() => {
    resetIceCache();
    // The node test env has no localStorage; the client reads its session
    // token from there before asking for ICE servers.
    (globalThis as { localStorage?: Storage }).localStorage = { getItem: () => "tok-123" } as unknown as Storage;
  });

  it("returns the API's servers, including TURN, when reachable", async () => {
    const turn = { urls: "turn:1.2.3.4:3478", username: "123:u", credential: "abc" };
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return { ok: true, json: async () => ({ iceServers: [{ urls: "stun:x" }, turn] }) };
    }) as unknown as typeof fetch;

    const servers = await loadIceServers();
    expect(servers).toContainEqual(turn);
    expect(servers.some((s) => String(s.urls).startsWith("stun:"))).toBe(true);
    // `/v1/rtc/ice` is session-gated. Sending no token made every call fall
    // back to STUN, which cannot relay through carrier NAT.
    expect((seen?.headers as Record<string, string>)?.authorization).toBe("Bearer tok-123");
  });

  it("falls back to a public STUN server when the API fails", async () => {
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const servers = await loadIceServers();
    expect(servers.length).toBeGreaterThan(0);
    expect(String(servers[0]!.urls)).toContain("stun:");
  });
});
