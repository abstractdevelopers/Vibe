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
