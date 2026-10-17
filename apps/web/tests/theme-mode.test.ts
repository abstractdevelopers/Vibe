import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The environment a viewer meets is now decided by a mode, not only by a stored
 * theme. Auto is the default and rotates; pinning overrides it. This is the
 * behaviour the product is judged on at first sight, so it is worth a test that
 * does not need a browser: the mode logic is pure once localStorage exists.
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

const PICK = "vibe.vibetheme";
const MODE = "vibe.theme.mode";

async function load() {
  vi.resetModules();
  return import("../src/theme-runtime");
}

describe("environment mode", () => {
  beforeEach(() => {
    (globalThis as { localStorage: Storage }).localStorage = memoryStorage();
    (globalThis as { window?: unknown }).window = { dispatchEvent: () => true };
  });

  it("defaults to auto, not to a frozen default theme", async () => {
    const t = await load();
    expect(t.themeMode()).toBe("auto");
  });

  it("treats a legacy stored theme as a pin, so nobody is overridden", async () => {
    localStorage.setItem(PICK, JSON.stringify(t0()));
    const t = await load();
    expect(t.themeMode()).toBe("pinned");
  });

  it("holds one world for the visit and rotates on the interval", async () => {
    const t = await load();
    const first = t.autoTheme();
    // Repeated calls in a visit are stable — StrictMode invokes effects twice.
    expect(t.autoTheme().id).toBe(first.id);
    // The interval advances through the worlds and wraps.
    const seen = new Set<string>([first.id]);
    for (let i = 0; i < t.ROTATION.length; i++) seen.add(t.rotateAutoTheme().id);
    expect(seen.size).toBe(t.ROTATION.length);
  });

  it("changes the environment on every visit", async () => {
    const first = (await load()).autoTheme().id;
    // A fresh load is a new visit: it must not land on the same world.
    const second = (await load()).autoTheme().id;
    expect(second).not.toBe(first);
  });

  it("only offers signature worlds to rotate through", async () => {
    const t = await load();
    for (const theme of t.ROTATION) {
      expect(theme.family).toBe("signature");
      expect(theme.ramp.hue).toBeGreaterThanOrEqual(0);
    }
  });

  it("setThemeMode('auto') clears the pin so rotation resumes", async () => {
    localStorage.setItem(PICK, JSON.stringify(t0()));
    localStorage.setItem(MODE, "pinned");
    const t = await load();
    t.setThemeMode("auto");
    expect(t.themeMode()).toBe("auto");
    expect(localStorage.getItem(PICK)).toBeNull();
  });
});

function t0() {
  return {
    id: "neon-arcade", name: "Neon Arcade", family: "signature", style: "neon",
    accent: "#38e8ff", accentInk: "#04222a", accentSoft: "#1b6d84",
    glowA: "a", glowB: "b", ramp: { hue: 232, tint: 26, light: 0 },
  };
}
