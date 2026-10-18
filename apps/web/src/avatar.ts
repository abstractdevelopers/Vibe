/**
 * Vibe avatars — the trait model.
 *
 * A person without an uploaded photo should still have a face, not an initial
 * in a grey circle. This module turns a stable seed (the user id) into a set of
 * traits, so the same person always gets the same avatar on every device and in
 * every session, with no storage and no round trip.
 *
 * It is deliberately a pure function of the seed: the 2D renderer and the 3D
 * renderer both read these traits, so a person's 2D and 3D faces are the same
 * character. Nothing here touches the DOM, which is what makes it testable.
 */

export interface AvatarTraits {
  /** Background wash behind the head. */
  background: string;
  /** Skin tone. */
  skin: string;
  /** Shadow tone for the neck and under the jaw. */
  skinShade: string;
  /** Hair colour. */
  hairColor: string;
  /** Hair silhouette: 0 crop, 1 afro, 2 bob, 3 long, 4 bun, 5 wrap. */
  hairStyle: number;
  /** Face shape: 0 round, 1 oval, 2 square. */
  face: number;
  /** 0 none, 1 glasses, 2 earrings, 3 cap. */
  accessory: number;
  /** 0 smile, 1 grin, 2 neutral, 3 surprised. */
  expression: number;
  /** Clothes colour across the shoulders. */
  clothes: string;
}

/** FNV-1a. Small, fast, and stable across runs — unlike Math.random. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic stream of values in [0,1) from one seed. */
function stream(seed: number) {
  let state = seed || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

const SKINS = ["#f2c9a0", "#e8b184", "#d99a63", "#c07c46", "#9a5c2f", "#6f3d1c", "#f7d9bd"];
const HAIRS = ["#1b1512", "#2f2119", "#4a2f1c", "#6b4423", "#0f0d0c", "#3a3a3a", "#7a5230"];
const CLOTHES = ["#e0603f", "#3f7ae0", "#4fa06b", "#b45fd6", "#e0a23f", "#3fb0c9", "#d64f77", "#6b6fe0"];
const BACKGROUNDS = ["#f6e7d8", "#e7eef6", "#eaf3ea", "#f3e9f6", "#fdf0dd", "#e6f2f3"];

function pick<T>(r: () => number, list: T[]): T {
  return list[Math.floor(r() * list.length)]!;
}

export function traitsFor(seed: string): AvatarTraits {
  const r = stream(hashSeed(seed));
  const skin = pick(r, SKINS);
  return {
    background: pick(r, BACKGROUNDS),
    skin,
    // The shade is a fixed darkening of the chosen skin, so the two never
    // drift apart the way two independent picks would.
    skinShade: shade(skin, -0.18),
    hairColor: pick(r, HAIRS),
    hairStyle: Math.floor(r() * 6),
    face: Math.floor(r() * 3),
    accessory: r() < 0.42 ? 1 + Math.floor(r() * 3) : 0,
    expression: Math.floor(r() * 4),
    clothes: pick(r, CLOTHES),
  };
}

/** Darken (amount < 0) or lighten (amount > 0) a hex colour. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
    return Math.max(0, Math.min(255, Math.round(v)));
  });
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The head outline for a face shape, on a 0..100 box with the head centred at
 * x=50. Shared so the 2D path and the 3D silhouette agree on the shape.
 */
export function faceWidth(face: number): number {
  return face === 0 ? 30 : face === 1 ? 27 : 32;
}

export function faceHeight(face: number): number {
  return face === 0 ? 32 : face === 1 ? 36 : 31;
}
