import type { JSX } from "react";

/**
 * Gift artwork.
 *
 * Every gift — the free social gestures and the paid collectibles — is a drawn
 * mark, not an emoji. Each is built on the same 48×48 grid with a material
 * treatment (a metal, a gem, a light) so the set reads as one designed range,
 * and each carries its own glow. `tier` (paid gifts only) adds weight to that
 * glow; it never changes what the gift is.
 *
 * Colour is passed in, so a gift sits inside whatever environment it is sent in.
 */

export type GiftTier = 1 | 2 | 3;

interface Material {
  /** The body of the mark. */
  fill: string;
  /** A highlight, for the lit edge. */
  hi: string;
  /** The halo behind the mark. */
  glow: string;
}

/** Materials, named for what they are made of rather than a colour. */
const MATERIALS: Record<string, Material> = {
  light: { fill: "#ffe27a", hi: "#fff7cf", glow: "#ffd24a" },
  gold: { fill: "#f5c451", hi: "#fff0b8", glow: "#ffb020" },
  rose: { fill: "#ff5d86", hi: "#ffc2d4", glow: "#ff3d74" },
  ruby: { fill: "#ff5566", hi: "#ffc0c7", glow: "#ff2f45" },
  ember: { fill: "#ff8a3d", hi: "#ffd9a8", glow: "#ff6a1e" },
  violet: { fill: "#a37bff", hi: "#e0d3ff", glow: "#8b5cff" },
  cyan: { fill: "#3fd9ff", hi: "#c4f1ff", glow: "#18c8ff" },
  jade: { fill: "#49e0b0", hi: "#c6f7e6", glow: "#22d19a" },
  steel: { fill: "#c9d2e3", hi: "#ffffff", glow: "#9fb0cc" },
  cocoa: { fill: "#b98055", hi: "#eccfae", glow: "#96603a" },
};

function m(name: string): Material {
  return MATERIALS[name] ?? MATERIALS.light!;
}

/** Draw functions, keyed by gift id. */
const MARKS: Record<string, (c: Material) => JSX.Element> = {
  // ---- Free gestures -----------------------------------------------------
  sparkle: (c) => (
    <>
      <path d="M24 6l3.2 10.8L38 20l-10.8 3.2L24 34l-3.2-10.8L10 20l10.8-3.2z" fill={c.fill} />
      <path d="M36 32l1.4 4.6L42 38l-4.6 1.4L36 44l-1.4-4.6L30 38l4.6-1.4z" fill={c.hi} opacity="0.9" />
    </>
  ),
  high_five: (c) => (
    <>
      <path d="M18 42V24a3 3 0 0 1 6 0v-8a3 3 0 0 1 6 0v-2a3 3 0 0 1 6 0v10a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-10z" fill={c.fill} />
      <path d="M10 20l4-3M8 28h5M10 36l4 3" stroke={c.hi} strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
  cheer: (c) => (
    <>
      <path d="M16 18h10l12-6v24l-12-6H16z" fill={c.fill} />
      <path d="M16 18v12" stroke={c.hi} strokeWidth="2" />
      <path d="M42 20v8" stroke={c.hi} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  hug: (c) => (
    <>
      <path d="M24 40C14 33 8 28 8 21a8 8 0 0 1 16-4 8 8 0 0 1 16 4c0 7-6 12-16 19z" fill={c.fill} />
      <path d="M16 22c2-3 5-3 7 0M25 22c2-3 5-3 7 0" stroke={c.hi} strokeWidth="2" fill="none" strokeLinecap="round" />
    </>
  ),
  fire: (c) => (
    <>
      <path d="M24 6c6 8 12 12 12 20a12 12 0 0 1-24 0c0-6 4-9 6-13 1 3 3 4 4 6 1-5 0-9 2-13z" fill={c.fill} />
      <path d="M24 24c2 3 4 5 4 8a4 4 0 0 1-8 0c0-3 2-5 4-8z" fill={c.hi} />
    </>
  ),

  // ---- Paid collectibles -------------------------------------------------
  rose: (c) => (
    <>
      <path d="M24 26c-5-1-8-5-8-9a8 8 0 0 1 16 0c0 4-3 8-8 9z" fill={c.fill} />
      <path d="M24 12c3 2 3 6 0 8-3-2-3-6 0-8z" fill={c.hi} opacity="0.85" />
      <path d="M24 26v14M24 33l5-4M24 37l-5-4" stroke={MATERIALS.jade!.fill} strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </>
  ),
  coffee: (c) => (
    <>
      <path d="M12 20h22v10a9 9 0 0 1-9 9h-4a9 9 0 0 1-9-9z" fill={c.fill} />
      <path d="M34 22h3a4 4 0 0 1 0 8h-3" fill="none" stroke={c.hi} strokeWidth="2.4" />
      <path d="M18 14c2-2 0-4 0-6M24 14c2-2 0-4 0-6" stroke={c.hi} strokeWidth="2" strokeLinecap="round" fill="none" />
    </>
  ),
  spark: (c) => (
    <>
      <path d="M24 8l3 11 11 3-11 3-3 11-3-11-11-3 11-3z" fill={c.fill} />
      <path d="M24 20l1.4 3.6L29 25l-3.6 1.4L24 30l-1.4-3.6L19 25l3.6-1.4z" fill={c.hi} />
    </>
  ),
  heart: (c) => (
    <>
      <path d="M24 40C13 32 7 27 7 20a9 9 0 0 1 17-5 9 9 0 0 1 17 5c0 7-6 12-17 20z" fill={c.fill} />
      <path d="M16 18c2-3 5-3 7 0" stroke={c.hi} strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </>
  ),
  clap: (c) => (
    <>
      <path d="M16 40V26a3 3 0 0 1 6 0v-8a3 3 0 0 1 6 0v-2a3 3 0 0 1 6 0v12a10 10 0 0 1-10 10h-1a7 7 0 0 1-7-8z" fill={c.fill} />
      <path d="M36 14l4-4M40 22h5M36 30l4 4" stroke={c.hi} strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
  fireworks: (c) => (
    <>
      <g stroke={c.fill} strokeWidth="2.6" strokeLinecap="round">
        <path d="M24 24V8M24 24v16M24 24H8M24 24h16M24 24L13 13M24 24l11 11M24 24L35 13M24 24L13 35" />
      </g>
      <circle cx="24" cy="24" r="4" fill={c.hi} />
    </>
  ),
  guitar: (c) => (
    <>
      <path d="M18 34a8 8 0 1 1 8-8c0 3 2 5 5 5a7 7 0 1 1-7 7c0-3-2-4-6-4z" fill={c.fill} />
      <path d="M28 26l12-16" stroke={c.hi} strokeWidth="3" strokeLinecap="round" />
      <circle cx="23" cy="30" r="3" fill={c.hi} opacity="0.8" />
    </>
  ),
  drum: (c) => (
    <>
      <path d="M18 14h12l-4 10 4 10H18l4-10z" fill={c.fill} />
      <path d="M18 14c0-3 12-3 12 0M18 34c0 3 12 3 12 0" fill="none" stroke={c.hi} strokeWidth="2" />
      <path d="M34 12l4 6M38 12l-4 6" stroke={c.hi} strokeWidth="2.2" strokeLinecap="round" />
    </>
  ),
  crown: (c) => (
    <>
      <path d="M10 18l6 6 8-12 8 12 6-6-3 18H13z" fill={c.fill} />
      <path d="M13 36h22" stroke={c.hi} strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="24" cy="16" r="2.4" fill={c.hi} />
    </>
  ),
  diamond: (c) => (
    <>
      <path d="M14 14h20l6 8-16 20L8 22z" fill={c.fill} />
      <path d="M8 22h32M20 14l4 8 4-8M24 22l-4 20M24 22l4 20" stroke={c.hi} strokeWidth="1.6" fill="none" opacity="0.85" />
    </>
  ),
  rocket: (c) => (
    <>
      <path d="M24 6c6 5 9 12 9 20l-5 5h-8l-5-5c0-8 3-15 9-20z" fill={c.fill} />
      <circle cx="24" cy="20" r="3.4" fill={c.hi} />
      <path d="M20 31l-4 8 6-3M28 31l4 8-6-3" fill={c.hi} opacity="0.9" />
    </>
  ),
  trophy: (c) => (
    <>
      <path d="M16 10h16v9a8 8 0 0 1-16 0z" fill={c.fill} />
      <path d="M16 13h-5a6 6 0 0 0 6 6M32 13h5a6 6 0 0 1-6 6" fill="none" stroke={c.hi} strokeWidth="2.2" />
      <path d="M22 27h4v6h-4z" fill={c.hi} />
      <path d="M16 33h16v5H16z" fill={c.fill} />
    </>
  ),
  galaxy: (c) => (
    <>
      <ellipse cx="24" cy="24" rx="17" ry="7" fill={c.fill} transform="rotate(-28 24 24)" />
      <ellipse cx="24" cy="24" rx="9" ry="4" fill={c.hi} transform="rotate(-28 24 24)" opacity="0.9" />
      <circle cx="24" cy="24" r="3" fill="#fff" />
    </>
  ),
  castle: (c) => (
    <>
      <path d="M12 20l3-4 3 4v18H12zM30 20l3-4 3 4v18h-6z" fill={c.fill} />
      <path d="M20 16l4-5 4 5v22h-8z" fill={c.fill} opacity="0.9" />
      <path d="M22 38v-7a2 2 0 0 1 4 0v7" fill={c.hi} />
    </>
  ),
  lion: (c) => (
    <>
      <path d="M24 8l5 4 6-1 1 6 5 5-4 5 1 6-6 1-4 5-5-4-5 4-4-5-6-1 1-6-4-5 5-5 1-6 6 1z" fill={c.fill} />
      <circle cx="24" cy="24" r="8" fill={c.hi} />
      <circle cx="21" cy="22" r="1.6" fill="#3a2a12" />
      <circle cx="27" cy="22" r="1.6" fill="#3a2a12" />
      <path d="M21 28c2 2 4 2 6 0" stroke="#3a2a12" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </>
  ),
  universe: (c) => (
    <>
      <circle cx="24" cy="24" r="12" fill={c.fill} />
      <path d="M8 28c8 6 24 6 32 0" fill="none" stroke={c.hi} strokeWidth="2.6" />
      <ellipse cx="24" cy="24" rx="19" ry="6" fill="none" stroke={c.hi} strokeWidth="2" transform="rotate(-18 24 24)" opacity="0.8" />
      <circle cx="18" cy="20" r="2.4" fill={c.hi} opacity="0.85" />
    </>
  ),
  jet: (c) => (
    <>
      <path d="M40 22L26 26l-6 12h-4l3-13-9-3 2-3 11 1 8-9h4l-3 9 8-2z" fill={c.fill} />
      <path d="M14 34h12" stroke={c.hi} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  yacht: (c) => (
    <>
      <path d="M24 10l8 20H16z" fill={c.fill} />
      <path d="M24 10v20" stroke={c.hi} strokeWidth="1.8" />
      <path d="M8 32h32l-4 6H12z" fill={c.fill} opacity="0.9" />
      <path d="M8 40c3 2 6 2 9 0s6-2 9 0 6 2 9 0" stroke={c.hi} strokeWidth="2" fill="none" strokeLinecap="round" />
    </>
  ),

  // ---- Live-room reactions ----------------------------------------------
  laugh: (c) => (
    <>
      <circle cx="24" cy="24" r="15" fill={c.fill} />
      <path d="M14 20c2-2 5-2 7 0M27 20c2-2 5-2 7 0" stroke={c.hi} strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M14 28c3 6 17 6 20 0z" fill={c.hi} />
    </>
  ),
  party: (c) => (
    <>
      <path d="M12 38l10-24 14 14z" fill={c.fill} />
      <path d="M22 14l4 4" stroke={c.hi} strokeWidth="2" strokeLinecap="round" />
      <circle cx="34" cy="12" r="2.4" fill={c.hi} />
      <circle cx="40" cy="22" r="2" fill={c.hi} opacity="0.8" />
      <circle cx="30" cy="6" r="1.8" fill={c.hi} opacity="0.7" />
    </>
  ),
  hundred: (c) => (
    <>
      <path d="M8 18h10l-4 6 4 6H8z" fill={c.fill} />
      <circle cx="26" cy="24" r="7" fill="none" stroke={c.fill} strokeWidth="4" />
      <circle cx="40" cy="24" r="7" fill="none" stroke={c.fill} strokeWidth="4" />
      <path d="M8 34h34" stroke={c.hi} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  // A battle reaction, drawn like the rest of the artwork rather than set as an
  // emoji character: the client has no emoji anywhere, because they render
  // differently on every platform and read as a toy next to the SVG marks.
  shock: (c) => (
    <>
      <circle cx="24" cy="24" r="15" fill={c.fill} />
      <circle cx="18" cy="20" r="2.6" fill={c.hi} />
      <circle cx="30" cy="20" r="2.6" fill={c.hi} />
      <ellipse cx="24" cy="31" rx="4" ry="5" fill={c.hi} />
    </>
  ),
};

const FALLBACK = (c: Material): JSX.Element => (
  <path d="M24 8l14 10v12L24 40 10 30V18z" fill={c.fill} />
);

/** The material each gift is made of. */
const GIFT_MATERIAL: Record<string, string> = {
  sparkle: "light", high_five: "light", cheer: "violet", hug: "rose", fire: "ember",
  rose: "rose", coffee: "cocoa", spark: "light", heart: "ruby", clap: "gold",
  fireworks: "violet", guitar: "cocoa", drum: "cocoa", crown: "gold", diamond: "cyan",
  rocket: "steel", trophy: "gold", galaxy: "violet", castle: "steel", lion: "gold",
  universe: "cyan", jet: "steel", yacht: "cyan",
  laugh: "light", party: "violet", hundred: "gold", gift: "rose", shock: "light",
};

export function giftMaterialName(id: string): string {
  return GIFT_MATERIAL[id] ?? "light";
}

/**
 * A gift, drawn. `tier` adds a halo for the larger paid gifts; the mark itself
 * is the same shape at every tier.
 */
export function GiftArt({ id, size = 48, tier = 1 }: { id: string; size?: number; tier?: GiftTier }): JSX.Element {
  const c = m(GIFT_MATERIAL[id] ?? "light");
  const draw = MARKS[id] ?? FALLBACK;
  const haloR = tier === 3 ? 22 : tier === 2 ? 19 : 16;
  const haloOpacity = tier === 3 ? 0.5 : tier === 2 ? 0.34 : 0.2;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
      <circle cx="24" cy="24" r={haloR} fill={c.glow} opacity={haloOpacity} />
      {draw(c)}
    </svg>
  );
}

/** A stable, per-gift glow colour, for use in CSS outside the SVG. */
export function giftGlow(id: string): string {
  return m(GIFT_MATERIAL[id] ?? "light").glow;
}
