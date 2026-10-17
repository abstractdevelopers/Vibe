/**
 * Theme runtime.
 *
 * The part of the environment system the app needs at boot: the shape of a
 * theme, how to build its surface ramp, and how to apply it. The full catalogue
 * of 136 environments lives in `themes.ts`, which is only loaded by the screens
 * that browse it (Settings, the game world). Keeping the two apart means the
 * launch bundle carries the one theme a viewer actually chose, not all of them.
 *
 * A chosen theme is persisted as its resolved spec (a few hundred bytes) so it
 * can be re-applied without the catalogue.
 */

export interface Surfaces {
  void: string;
  s0: string;
  s1: string;
  s2: string;
  s3: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textMuted: string;
}

export interface Theme {
  id: string;
  name: string;
  family: string;
  style: string;
  /** Drives buttons, highlights and the active state. */
  accent: string;
  /** Legible ink on the accent. */
  accentInk: string;
  /** A softer companion to the accent, for secondary emphasis. */
  accentSoft: string;
  /** The two atmosphere glows. */
  glowA: string;
  glowB: string;
  /**
   * How to build this environment's surface ramp: a hue, how far the surfaces
   * lean toward it, and a lift. Kept as three numbers rather than ten colour
   * strings so the catalogue stays small — the ramp is computed on apply.
   */
  ramp: { hue: number; tint: number; light: number };
}

export const PICK_KEY = "vibe.vibetheme";
export const FOLLOW_KEY = "vibe.theme.follow";

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Build a surface ramp from a base hue. The ramp stays dark (this is an
 * after-dark product) but picks up the environment's hue, so a Neon Arcade room
 * is blue-black while an Obsidian Lounge is warm black. `tint` controls how much
 * the surfaces lean toward the hue; `light` lifts the whole ramp.
 */
export function rampFor(theme: Theme): Surfaces {
  const { hue, tint, light } = theme.ramp;
  const s = (l: number): string => hslToHex(hue, tint, Math.max(2, l + light));
  return {
    void: s(4),
    s0: s(7),
    s1: s(10),
    s2: s(14),
    s3: s(19),
    border: "rgba(255, 255, 255, 0.09)",
    borderStrong: "rgba(255, 255, 255, 0.16)",
    text: "#f8f7fc",
    textSecondary: "#c8cad8",
    textMuted: "#8d90a2",
  };
}

const SURFACE_KEYS: Array<[keyof Surfaces, string]> = [
  ["void", "--void"],
  ["s0", "--surface-0"],
  ["s1", "--surface-1"],
  ["s2", "--surface-2"],
  ["s3", "--surface-3"],
  ["border", "--border"],
  ["borderStrong", "--border-strong"],
  ["text", "--text"],
  ["textSecondary", "--text-secondary"],
  ["textMuted", "--text-muted"],
];

/**
 * Apply a theme to the document. Pass null to restore the brand default.
 *
 * The surface ramp is written as inline custom properties on the root, which
 * outrank the stylesheet's `:root` defaults but lose to `[data-theme="light"]`
 * — so light mode still wins, which is correct: light mode is an accessibility
 * choice, a theme is a mood.
 */
export function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  if (!theme) {
    root.dataset.vibe = "";
    for (const [, prop] of SURFACE_KEYS) root.style.removeProperty(prop);
    for (const prop of ["--accent", "--accent-ink", "--accent-soft", "--theme-glow-a", "--theme-glow-b"]) {
      root.style.removeProperty(prop);
    }
    return;
  }
  root.dataset.vibe = theme.id;
  const surfaces = rampFor(theme);
  for (const [key, prop] of SURFACE_KEYS) root.style.setProperty(prop, surfaces[key]);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-ink", theme.accentInk);
  root.style.setProperty("--accent-soft", theme.accentSoft);
  root.style.setProperty("--theme-glow-a", theme.glowA);
  root.style.setProperty("--theme-glow-b", theme.glowB);
}

/** Apply a theme and remember it, so it is restored on the next load. */
export function chooseTheme(theme: Theme | null): void {
  if (theme) {
    try {
      localStorage.setItem(PICK_KEY, JSON.stringify(theme));
    } catch {
      /* storage may be full or blocked; the theme still applies now */
    }
  } else {
    localStorage.removeItem(PICK_KEY);
  }
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent("vibe:theme"));
}

/** Re-apply whatever the viewer last chose. Safe to call at boot. */
export function restoreTheme(): void {
  const mode = themeMode();
  if (mode === "auto") {
    applyTheme(autoTheme());
    return;
  }
  const raw = localStorage.getItem(PICK_KEY);
  if (!raw) return;
  try {
    const theme = JSON.parse(raw) as Theme;
    if (theme && theme.ramp) applyTheme(theme);
  } catch {
    localStorage.removeItem(PICK_KEY);
  }
}

/** The theme the viewer has pinned by hand, if any. */
export function pickedTheme(): Theme | null {
  const raw = localStorage.getItem(PICK_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Theme;
  } catch {
    return null;
  }
}

/** Whether the environment should follow the activity you are in. On by default. */
export function followActivity(): boolean {
  return localStorage.getItem(FOLLOW_KEY) !== "0";
}

export const MODE_KEY = "vibe.theme.mode";

/** Auto, pinned, or following the activity. Auto is the default. */
export type ThemeMode = "auto" | "pinned" | "follow";

/**
 * How the environment is chosen. Auto is the default and needs no storage: a
 * viewer who has never touched the picker gets it, and a pinned theme is the
 * only thing that turns it off. "follow" is the older behaviour (change with the
 * room or game you are in) and is kept for anyone who set it.
 */
export function themeMode(): ThemeMode {
  const raw = localStorage.getItem(MODE_KEY);
  if (raw === "pinned" || raw === "follow" || raw === "auto") return raw;
  return pickedTheme() ? "pinned" : "auto";
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(MODE_KEY, mode);
  if (mode !== "pinned") {
    localStorage.removeItem(PICK_KEY);
  }
  window.dispatchEvent(new CustomEvent("vibe:theme"));
}

/**
 * The environments auto mode rotates through, in order. Deliberately a small,
 * authored set of the four signature worlds: they were designed to be the
 * product's moods, they are the ones a visitor should meet first, and holding
 * the list here keeps it out of the launch bundle.
 */
export const ROTATION: Array<Omit<Theme, "ramp"> & { ramp: Theme["ramp"] }> = [
  {
    id: "neon-arcade", name: "Neon Arcade", family: "signature", style: "neon",
    accent: "#38e8ff", accentInk: "#04222a", accentSoft: "#1b6d84",
    glowA: "radial-gradient(circle at 50% 50%, rgba(56,232,255,0.5), transparent 70%)",
    glowB: "radial-gradient(circle at 50% 50%, rgba(255,74,196,0.4), transparent 70%)",
    ramp: { hue: 232, tint: 26, light: 0 },
  },
  {
    id: "cyber-arena", name: "Cyber Arena", family: "signature", style: "neon",
    accent: "#ffab3d", accentInk: "#241300", accentSoft: "#8a5a1f",
    glowA: "radial-gradient(circle at 50% 50%, rgba(255,171,61,0.5), transparent 70%)",
    glowB: "radial-gradient(circle at 50% 50%, rgba(94,140,255,0.4), transparent 70%)",
    ramp: { hue: 214, tint: 22, light: 0 },
  },
  {
    id: "obsidian-lounge", name: "Obsidian Lounge", family: "signature", style: "dusk",
    accent: "#e2b46a", accentInk: "#241703", accentSoft: "#8a6d3a",
    glowA: "radial-gradient(circle at 50% 50%, rgba(226,180,106,0.45), transparent 70%)",
    glowB: "radial-gradient(circle at 50% 50%, rgba(120,90,160,0.35), transparent 70%)",
    ramp: { hue: 258, tint: 14, light: 0 },
  },
  {
    id: "royal-chamber", name: "Royal Chamber", family: "signature", style: "classic",
    accent: "#d9a441", accentInk: "#241703", accentSoft: "#8a6a2a",
    glowA: "radial-gradient(circle at 50% 50%, rgba(217,164,65,0.45), transparent 70%)",
    glowB: "radial-gradient(circle at 50% 50%, rgba(150,40,60,0.4), transparent 70%)",
    ramp: { hue: 18, tint: 24, light: 0 },
  },
];

/** How long each auto environment holds before the next. */
export const ROTATION_MS = 30_000;
const ROTATION_STEP_KEY = "vibe.theme.rotation.step";

let current: Theme | null = null;

/** Advance the persisted step and return that world. */
function advance(): Theme {
  let step: number;
  try {
    step = Number(localStorage.getItem(ROTATION_STEP_KEY) ?? "-1") + 1;
    localStorage.setItem(ROTATION_STEP_KEY, String(step));
  } catch {
    step = Math.floor(Date.now() / ROTATION_MS);
  }
  const idx = ((step % ROTATION.length) + ROTATION.length) % ROTATION.length;
  return ROTATION[idx]!;
}

/**
 * The environment auto mode shows for this visit. It advances exactly once per
 * page load — React's StrictMode invokes effects twice in development, and
 * advancing per call would skip a world — then holds steady. So the mood changes
 * every time someone opens Vibe, which is the point of auto.
 */
export function autoTheme(): Theme {
  if (!current) current = advance();
  return current;
}

/** Move to the next world. Used by the interval that keeps auto moving. */
export function rotateAutoTheme(): Theme {
  current = advance();
  return current;
}
