import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The API can live on a different origin from the web client. Getting the base
 * wrong is invisible in development (Vite proxies `/v1`) and fatal in production
 * (every call would hit the static host), so the resolution is pinned here.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

async function load() {
  vi.resetModules();
  return import("../src/api.js");
}

describe("api base resolution", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("location", { protocol: "https:", host: "vibe.launchverse.site" });
  });

  it("prefixes requests with VITE_API_URL when set, without a double slash", async () => {
    vi.stubEnv("VITE_API_URL", "https://vibeapi.launchverse.site/");
    const mod = await load();
    expect(mod.apiUrl("/v1/feed")).toBe("https://vibeapi.launchverse.site/v1/feed");
  });

  it("stays same-origin when VITE_API_URL is unset", async () => {
    vi.stubEnv("VITE_API_URL", "");
    const mod = await load();
    expect(mod.apiUrl("/v1/feed")).toBe("/v1/feed");
  });

  it("points the realtime socket at the API host, upgraded to wss", async () => {
    vi.stubEnv("VITE_API_URL", "https://vibeapi.launchverse.site");
    const mod = await load();
    expect(mod.realtimeUrl("tok")).toBe("wss://vibeapi.launchverse.site/v1/realtime?token=tok");
  });

  it("falls back to the page host for the socket when unset", async () => {
    vi.stubEnv("VITE_API_URL", "");
    const mod = await load();
    expect(mod.realtimeUrl("tok")).toBe("wss://vibe.launchverse.site/v1/realtime?token=tok");
  });
});
