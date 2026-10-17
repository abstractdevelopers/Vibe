/**
 * Vibe environments — the catalogue.
 *
 * A theme is not a colour pick; it is a whole environment. Every theme carries a
 * surface ramp (the void, four surfaces, borders and ink), an accent, a legible
 * ink for that accent, and the two atmospheric glows the backdrop drifts.
 * Applying one rewrites the surface ramp on the document root, so the entire
 * interface — not just the buttons — changes character. The runtime that does
 * that lives in `theme-runtime.ts`; this file is only the catalogue.
 *
 * The named environments are hand-authored, each with its own material story:
 *
 *   Neon Arcade     — an arcade at night. Deep indigo glass, electric cyan and
 *                     magenta light, high-energy.
 *   Obsidian Lounge — dark luxury. Near-black stone, restrained brass, warm low
 *                     light, quiet and expensive.
 *   Cyber Arena     — competitive futuresport. Cold steel panels, sharp amber
 *                     warning light, structured.
 *   Royal Chamber   — an exclusive hall. Oxblood velvet, aged gold, candlelight.
 *
 * Every other theme is generated from an authored base palette and one of the
 * four house styles, so the catalogue is broad without any of it being random.
 */
import type { Theme } from "./theme-runtime";

export type { Surfaces, Theme } from "./theme-runtime";
export { applyTheme, rampFor, chooseTheme, restoreTheme, pickedTheme, followActivity } from "./theme-runtime";

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  const lin = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Dark ink for bright accents, white for dark ones. Keeps labels legible. */
function inkFor(accent: string): string {
  return luminance(accent) > 0.42 ? "#12131a" : "#ffffff";
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function glow(hex: string, alpha = 0.5): string {
  return `radial-gradient(circle at 50% 50%, ${rgba(hex, alpha)}, transparent 70%)`;
}

// ---- Authored environments ------------------------------------------------

const NAMED: Theme[] = [
  {
    id: "neon-arcade", name: "Neon Arcade", family: "signature", style: "neon",
    accent: "#22e0d6", accentInk: inkFor("#22e0d6"), accentSoft: "#7af4ec",
    glowA: glow("#1de0ff", 0.55), glowB: glow("#ff3db4", 0.45),
    ramp: { hue: 232, tint: 34, light: 0 },
  },
  {
    id: "obsidian-lounge", name: "Obsidian Lounge", family: "signature", style: "dusk",
    accent: "#d8b26a", accentInk: inkFor("#d8b26a"), accentSoft: "#e6cd97",
    glowA: glow("#c99a4e", 0.4), glowB: glow("#7a5a2e", 0.35),
    ramp: { hue: 28, tint: 10, light: -1 },
  },
  {
    id: "cyber-arena", name: "Cyber Arena", family: "signature", style: "neon",
    accent: "#ffb020", accentInk: inkFor("#ffb020"), accentSoft: "#ffcf6b",
    glowA: glow("#ff8a1e", 0.5), glowB: glow("#2ad0ff", 0.34),
    ramp: { hue: 214, tint: 22, light: -1 },
  },
  {
    id: "royal-chamber", name: "Royal Chamber", family: "signature", style: "classic",
    accent: "#e0b23c", accentInk: inkFor("#e0b23c"), accentSoft: "#f0cf7a",
    glowA: glow("#b8332f", 0.42), glowB: glow("#8a6a22", 0.38),
    ramp: { hue: 348, tint: 26, light: 1 },
  },
];

// ---- Generated catalogue --------------------------------------------------

interface Base { id: string; name: string; family: string; hue: number; accentLight: number; glowHue: number; tint?: number }

const BASES: Base[] = [
  // Games — cards
  { id: "whot", name: "Whot Table", family: "cards", hue: 8, accentLight: 62, glowHue: 22 },
  { id: "blackjack", name: "Blackjack Felt", family: "cards", hue: 150, accentLight: 58, glowHue: 168 },
  { id: "poker", name: "Poker Room", family: "cards", hue: 350, accentLight: 60, glowHue: 12 },
  { id: "war", name: "War Deck", family: "cards", hue: 28, accentLight: 62, glowHue: 6 },
  // Games — board
  { id: "board-classic", name: "Board Classic", family: "board", hue: 205, accentLight: 60, glowHue: 224 },
  { id: "checkers", name: "Checkers Wood", family: "board", hue: 32, accentLight: 58, glowHue: 18 },
  { id: "reversi", name: "Reversi", family: "board", hue: 168, accentLight: 58, glowHue: 200 },
  { id: "battleship", name: "Battleship Sonar", family: "board", hue: 196, accentLight: 60, glowHue: 172 },
  { id: "gomoku", name: "Gomoku Ink", family: "board", hue: 250, accentLight: 64, glowHue: 280 },
  { id: "snakes", name: "Snakes & Ladders", family: "board", hue: 96, accentLight: 58, glowHue: 140 },
  // Games — mind
  { id: "trivia", name: "Trivia Buzz", family: "mind", hue: 45, accentLight: 62, glowHue: 30 },
  { id: "memory", name: "Memory Bloom", family: "mind", hue: 322, accentLight: 64, glowHue: 300 },
  { id: "wordplay", name: "Wordplay", family: "mind", hue: 178, accentLight: 58, glowHue: 210 },
  { id: "hangman", name: "Hangman Dusk", family: "mind", hue: 268, accentLight: 62, glowHue: 240 },
  { id: "sudoku", name: "Sudoku Grid", family: "mind", hue: 218, accentLight: 60, glowHue: 250 },
  // Games — action
  { id: "reaction", name: "Reaction Flash", family: "action", hue: 58, accentLight: 64, glowHue: 38 },
  { id: "penalty", name: "Penalty Turf", family: "action", hue: 118, accentLight: 56, glowHue: 88 },
  { id: "simon", name: "Simon Says", family: "action", hue: 288, accentLight: 64, glowHue: 330 },
  { id: "rps", name: "RPS Clash", family: "action", hue: 12, accentLight: 62, glowHue: 340 },
  // Games — casino
  { id: "casino", name: "Casino Midnight", family: "casino", hue: 44, accentLight: 60, glowHue: 268 },
  { id: "roulette", name: "Roulette Rouge", family: "casino", hue: 356, accentLight: 58, glowHue: 20 },
  { id: "slots", name: "Slots Jackpot", family: "casino", hue: 48, accentLight: 64, glowHue: 8 },
  { id: "crash", name: "Crash Curve", family: "casino", hue: 142, accentLight: 58, glowHue: 190 },
  // Games — party
  { id: "party", name: "Party Pop", family: "party", hue: 336, accentLight: 66, glowHue: 268 },
  { id: "charades", name: "Charades Stage", family: "party", hue: 16, accentLight: 64, glowHue: 300 },
  { id: "truthdare", name: "Truth or Dare", family: "party", hue: 300, accentLight: 64, glowHue: 350 },
  // Rooms
  { id: "voice", name: "Voice Lounge", family: "rooms", hue: 192, accentLight: 60, glowHue: 228 },
  { id: "music", name: "Music Party", family: "rooms", hue: 318, accentLight: 64, glowHue: 268 },
  { id: "match", name: "Match Room", family: "rooms", hue: 154, accentLight: 58, glowHue: 196 },
  { id: "sports", name: "Sports Bar", family: "rooms", hue: 34, accentLight: 62, glowHue: 8 },
  { id: "watch", name: "Watch Party", family: "rooms", hue: 258, accentLight: 62, glowHue: 300 },
  // Social
  { id: "circle", name: "Circle Glow", family: "social", hue: 224, accentLight: 62, glowHue: 268 },
  { id: "explore", name: "Explore", family: "social", hue: 176, accentLight: 60, glowHue: 320 },
  { id: "wallet", name: "Wallet Gold", family: "social", hue: 46, accentLight: 60, glowHue: 30 },
];

interface Style { id: string; name: string; sat: number; lightShift: number; glowSat: number; glowLight: number; tint: number }

const STYLES: Style[] = [
  { id: "classic", name: "Classic", sat: 74, lightShift: 0, glowSat: 78, glowLight: 56, tint: 14 },
  { id: "dusk", name: "Dusk", sat: 52, lightShift: -8, glowSat: 60, glowLight: 46, tint: 9 },
  { id: "neon", name: "Neon", sat: 92, lightShift: 4, glowSat: 100, glowLight: 62, tint: 30 },
  { id: "aurora", name: "Aurora", sat: 64, lightShift: 2, glowSat: 70, glowLight: 58, tint: 20 },
];

function build(): Theme[] {
  const out: Theme[] = [...NAMED];

  for (const base of BASES) {
    for (const style of STYLES) {
      const accent = hslToHex(base.hue, style.sat, base.accentLight + style.lightShift);
      const glowA = hslToHex(base.glowHue, style.glowSat, style.glowLight);
      const glowB = hslToHex((base.glowHue + 40) % 360, style.glowSat, Math.max(30, style.glowLight - 8));
      out.push({
        id: `${base.id}-${style.id}`,
        name: style.id === "classic" ? base.name : `${base.name} · ${style.name}`,
        family: base.family,
        style: style.id,
        accent,
        accentInk: inkFor(accent),
        accentSoft: hslToHex(base.hue, Math.max(40, style.sat - 20), Math.min(78, base.accentLight + 14)),
        glowA: glow(glowA),
        glowB: glow(glowB),
        ramp: { hue: base.tint ?? base.hue, tint: style.tint, light: 0 },
      });
    }
  }

  return out;
}

export const THEMES: Theme[] = build();
export const THEME_COUNT = THEMES.length;

const byId = new Map(THEMES.map((t) => [t.id, t]));

export function getTheme(id: string | null | undefined): Theme | null {
  return id ? byId.get(id) ?? null : null;
}

/**
 * Resolve a theme for a piece of content. Games map by id (falling back to their
 * category), rooms by kind, and anything else by a stable hash of its id, so a
 * Circle always wears the same colours.
 */
export function themeForGame(gameId: string, category?: string): Theme {
  return getTheme(`${gameId}-classic`)
    ?? getTheme(`${category}-classic`)
    ?? getTheme("board-classic")!;
}

export function themeForRoom(kind: string): Theme {
  return getTheme(`${kind}-classic`) ?? getTheme("voice-classic")!;
}

export function themeForId(seed: string, family = "social"): Theme {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const pool = THEMES.filter((t) => t.family === family);
  const list = pool.length > 0 ? pool : THEMES;
  return list[h % list.length]!;
}
