/**
 * iso — an orthographic isometric renderer for the battle arenas.
 *
 * This is the Lagos Life shape: a fixed 2:1 dimetric camera, everything built
 * from flat-shaded extruded boxes sitting on a tile grid, sorted back to front.
 * There is no perspective divide and no rotation, which is exactly why it stays
 * cheap enough to live inside the Battles lazy chunk — a few kilobytes of
 * arithmetic instead of a 3D engine.
 *
 * The projection is the standard one:
 *
 *   sx = (x - z) * tileW / 2
 *   sy = (x + z) * tileH / 2 - y
 *
 * so +x runs down-right, +z runs down-left and +y runs up. Depth is therefore
 * (x + z): larger is nearer the viewer, and drawing in ascending order is a
 * correct painter's sort for axis-aligned boxes that do not interpenetrate.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface IsoCamera {
  /** Half-width of one tile in screen pixels. */
  tileW: number;
  /** Half-height of one tile in screen pixels. */
  tileH: number;
  /** Screen position of the world origin. */
  originX: number;
  originY: number;
  /** Uniform scale for small previews. */
  scale: number;
}

export function camera(tileW: number, tileH: number, originX: number, originY: number, scale = 1): IsoCamera {
  return { tileW, tileH, originX, originY, scale };
}

/** World point (tile units) to screen pixels. */
export function project(x: number, y: number, z: number, cam: IsoCamera): Pt {
  const s = cam.scale;
  return {
    x: cam.originX + (x - z) * (cam.tileW / 2) * s,
    y: cam.originY + (x + z) * (cam.tileH / 2) * s - y * (cam.tileH / 2) * 2 * s,
  };
}

/* ------------------------------------------------------------------ colour */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(hex: string): [number, number, number] {
  const m = HEX.exec(hex);
  if (!m) return [128, 128, 128];
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Multiply a hex colour by a factor, clamped. */
export function shade(hex: string, factor: number): string {
  const [r, g, b] = parseHex(hex);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `#${[c(r), c(g), c(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Blend two hex colours; t=0 is a, t=1 is b. */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  const c = (v1: number, v2: number) => Math.round(v1 + (v2 - v1) * Math.max(0, Math.min(1, t)));
  return `#${[c(r1, r2), c(g1, g2), c(b1, b2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/* ------------------------------------------------------------------- scene */

export interface IsoItem {
  /** Painter's key; larger draws later. */
  depth: number;
  paint: (ctx: CanvasRenderingContext2D) => void;
}

export interface BoxOptions {
  x: number;
  z: number;
  /** Footprint in tiles. */
  w?: number;
  d?: number;
  /** Base height in world units; 0 sits on the ground plane. */
  y?: number;
  /** Height in world units. */
  h?: number;
  color: string;
  /** Draw a darker outline. Off by default: Lagos Life is flat fills. */
  stroke?: string | null;
  /** 0..1, applied to the whole box. */
  alpha?: number;
  /** Top-face-only tint (roofs, highlights). */
  topColor?: string;
}

export interface SpriteOptions {
  x: number;
  z: number;
  y?: number;
  /** Depth nudge when two sprites share a cell. */
  bias?: number;
  paint: (ctx: CanvasRenderingContext2D) => void;
}

/** Face brightness: top lit, the two visible sides recede. */
const TOP = 1;
const SIDE_Z = 0.74;
const SIDE_X = 0.56;

export class IsoScene {
  readonly items: IsoItem[] = [];

  /** Draw a quad from four screen points. */
  quad(points: Pt[], fill: string, depth: number, opts: { stroke?: string | null; alpha?: number } = {}): void {
    this.items.push({
      depth,
      paint: (ctx) => {
        ctx.beginPath();
        ctx.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
        ctx.closePath();
        const prior = ctx.globalAlpha;
        if (opts.alpha !== undefined) ctx.globalAlpha = prior * opts.alpha;
        ctx.fillStyle = fill;
        ctx.fill();
        if (opts.stroke) {
          ctx.strokeStyle = opts.stroke;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.globalAlpha = prior;
      },
    });
  }

  /** One flat tile on the ground plane. */
  tile(x: number, z: number, color: string, cam: IsoCamera, opts: { alpha?: number } = {}): void {
    const a = project(x, 0, z, cam);
    const b = project(x + 1, 0, z, cam);
    const c = project(x + 1, 0, z + 1, cam);
    const d = project(x, 0, z + 1, cam);
    this.quad([a, b, c, d], color, x + z, opts);
  }

  /** An extruded box. Three faces are visible from this camera. */
  box(opts: BoxOptions, cam: IsoCamera): void {
    const { x, z, w = 1, d = 1, y = 0, h = 1, color } = opts;
    const y1 = y;
    const y2 = y + h;

    // bottom / top corners in world space
    const t0 = project(x, y2, z, cam);
    const t1 = project(x + w, y2, z, cam);
    const t2 = project(x + w, y2, z + d, cam);
    const t3 = project(x, y2, z + d, cam);

    const b1 = project(x + w, y1, z, cam);
    const b2 = project(x + w, y1, z + d, cam);
    const b3 = project(x, y1, z + d, cam);

    const stroke = opts.stroke ?? null;
    const alpha = opts.alpha;
    // The +z face is the left-hand visible side, +x the right-hand one.
    this.quad([t1, t2, b2, b1], shade(color, SIDE_X), x + w + z + d * 0.5, { stroke, alpha });
    this.quad([t3, t2, b2, b3], shade(color, SIDE_Z), x + w * 0.5 + z + d, { stroke, alpha });
    this.quad([t0, t1, t2, t3], opts.topColor ?? shade(color, TOP), x + w * 0.5 + z + d * 0.5 + h * 0.001, { stroke, alpha });
  }

  /** A custom-painted sprite anchored at a world point. */
  sprite(opts: SpriteOptions): void {
    this.items.push({ depth: opts.x + opts.z + (opts.bias ?? 0), paint: opts.paint });
  }

  /** Soft elliptical shadow on the ground. */
  shadow(cx: number, cz: number, radius: number, cam: IsoCamera, alpha = 0.28): void {
    const p = project(cx, 0, cz, cam);
    const rx = radius * (cam.tileW / 2) * cam.scale;
    const ry = radius * (cam.tileH / 2) * cam.scale;
    this.items.push({
      depth: cx + cz - 0.02,
      paint: (ctx) => {
        const prior = ctx.globalAlpha;
        ctx.globalAlpha = prior * alpha;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = "#000";
        ctx.fill();
        ctx.globalAlpha = prior;
      },
    });
  }

  /** Screen-space layer drawn after everything (labels, HUD). */
  overlay(paint: (ctx: CanvasRenderingContext2D) => void): void {
    this.items.push({ depth: Number.POSITIVE_INFINITY, paint });
  }

  sorted(): IsoItem[] {
    return [...this.items].sort((a, b) => a.depth - b.depth);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const item of this.sorted()) item.paint(ctx);
  }
}

/* ------------------------------------------------------------------ scenes */

export interface StadiumSpec {
  id: string;
  name: string;
  blurb: string;
  /** Ground / sand. */
  floor: string;
  /** Alternating tier colour. */
  tier: string;
  /** Structural stone. */
  stone: string;
  /** Signal colour for lights, flags, score flames. */
  accent: string;
  /** Side A and B colours, so a fight is readable at a glance. */
  sideA: string;
  sideB: string;
  /** Two-stop backdrop. */
  sky: [string, string];
}

export const STADIUMS: StadiumSpec[] = [
  {
    id: "colosseum",
    name: "The Colosseum",
    blurb: "Old stone, loud crowd.",
    floor: "#c8a97a",
    tier: "#8b7a63",
    stone: "#6f6152",
    accent: "#f5c518",
    sideA: "#e2574c",
    sideB: "#3f8fd6",
    sky: ["#1a1526", "#3a2c3f"],
  },
  {
    id: "dunes",
    name: "Dune Pit",
    blurb: "Sand, heat, no cover.",
    floor: "#d99a4e",
    tier: "#a8622f",
    stone: "#7d4726",
    accent: "#ffb347",
    sideA: "#c0392b",
    sideB: "#2e86ab",
    sky: ["#2a1608", "#6b3a14"],
  },
  {
    id: "lagoon",
    name: "Lagoon Deck",
    blurb: "Fight over water.",
    floor: "#3fa9a0",
    tier: "#2b6f74",
    stone: "#204f57",
    accent: "#5eead4",
    sideA: "#f472b6",
    sideB: "#facc15",
    sky: ["#06202b", "#0f4c5c"],
  },
  {
    id: "neon",
    name: "Neon Grid",
    blurb: "Lights off, volume up.",
    floor: "#1b1630",
    tier: "#2d2450",
    stone: "#3b2f6b",
    accent: "#c084fc",
    sideA: "#22d3ee",
    sideB: "#f43f5e",
    sky: ["#08060f", "#1a0f2e"],
  },
  {
    id: "rooftop",
    name: "Rooftop Ring",
    blurb: "City below, sky above.",
    floor: "#5b6472",
    tier: "#3f4753",
    stone: "#2c333d",
    accent: "#fbbf24",
    sideA: "#f97316",
    sideB: "#a78bfa",
    sky: ["#0b1220", "#243b53"],
  },
  {
    id: "quarry",
    name: "The Quarry",
    blurb: "Cut stone, hard floor.",
    floor: "#8d8b86",
    tier: "#6a6862",
    stone: "#4b4a46",
    accent: "#f59e0b",
    sideA: "#ef4444",
    sideB: "#38bdf8",
    sky: ["#141416", "#3a3a3c"],
  },
];

export function stadium(id: string | null | undefined): StadiumSpec {
  return STADIUMS.find((s) => s.id === id) ?? STADIUMS[0]!;
}

/**
 * The battle bowl: a stepped ring of blocks around a sand floor, two podiums,
 * a crowd that bobs, two fighter figures and a score column per side.
 *
 * Everything is deterministic from `phase` so it can be redrawn on a timer
 * without keeping any state: the same phase always paints the same frame,
 * which makes the animation a pure function of time.
 */
export interface ArenaState {
  scoreA: number;
  scoreB: number;
  crowd: number;
  phase: number;
  /** 0..1 fraction of the round remaining, for the clock ring. */
  remaining: number;
  status: "open" | "closed" | "cancelled";
  winner: "a" | "b" | "tie" | null;
  /** Transient punches, oldest first. `age` is 0..1. */
  impacts: Array<{ side: "a" | "b"; age: number; power: number }>;
  fighterA?: HTMLImageElement | null;
  fighterB?: HTMLImageElement | null;
}

export function buildArena(scene: IsoScene, spec: StadiumSpec, state: ArenaState, cam: IsoCamera): void {
  const { phase } = state;

  // The camera looks from the low-x, low-z corner, so anything on the +x/+z
  // sides of the floor is IN FRONT of the action and would hide it. The bowl
  // therefore only rings the two far sides (-x and -z) plus low stub walls on
  // the near ones, which is also how an amphitheatre actually reads from a
  // raised seat.

  // ---- ground: sand, then a chalk ring marking the fight area
  for (let x = -3; x < 4; x++) {
    for (let z = -3; z < 4; z++) {
      const dark = (x + z) % 2 === 0;
      scene.tile(x, z, dark ? shade(spec.floor, 0.93) : spec.floor, cam);
    }
  }
  for (let i = -2; i <= 2; i++) {
    scene.tile(i, -2.02, shade(spec.accent, 0.9), cam, { alpha: 0.35 });
    scene.tile(i, 2.02, shade(spec.accent, 0.9), cam, { alpha: 0.35 });
    scene.tile(-2.02, i, shade(spec.accent, 0.9), cam, { alpha: 0.35 });
    scene.tile(2.02, i, shade(spec.accent, 0.9), cam, { alpha: 0.35 });
  }

  // ---- the far tiers: four steps rising away from the floor
  for (let ring = 0; ring < 4; ring++) {
    const off = 3 + ring;
    const height = 0.7 + ring * 0.55;
    const color = ring % 2 === 0 ? spec.tier : spec.stone;
    const span = 3 + ring;
    for (let i = -span; i <= span; i++) {
      // back-left wall (constant z, running along x)
      scene.box({ x: i, z: -off, w: 1, d: 1, h: height, color }, cam);
      // back-right wall (constant x, running along z)
      scene.box({ x: -off, z: i, w: 1, d: 1, h: height, color }, cam);
    }
    // A single low near-side kerb: it frames the floor without covering it.
    if (ring === 0) {
      for (let i = -3; i <= 3; i++) {
        scene.box({ x: i, z: 3.7, w: 1, d: 0.3, h: 0.12, color: spec.stone, alpha: 0.7 }, cam);
        scene.box({ x: 3.7, z: i, w: 0.3, d: 1, h: 0.12, color: spec.stone, alpha: 0.7 }, cam);
      }
    }
  }

  // ---- crowd: spectators on the far tiers, bobbing out of phase.
  //
  // A stadium is never literally empty even with nobody watching — stewards,
  // lights, the place itself. The ambient floor keeps the bowl alive at zero
  // while the real crowd still drives how full it gets, so the number on the
  // scoreboard is not decoration.
  const watched = Math.max(0, Math.min(72, state.crowd));
  const crowd = 10 + watched;
  for (let i = 0; i < crowd; i++) {
    const ring = i % 4;
    const span = 3 + ring;
    const slot = (i * 7) % 21;
    const t = -span + (slot / 20) * span * 2;
    const bob = Math.sin(phase * 2.4 + i * 0.7) * 0.1 + 0.16;
    const color = i % 3 === 0 ? spec.accent : i % 2 === 0 ? spec.tier : spec.stone;
    const y = 0.7 + ring * 0.55;
    // Alternate walls so the crowd wraps both far sides.
    if (i % 2 === 0) scene.box({ x: t, z: -3 - ring + 0.28, w: 0.28, d: 0.28, y, h: 0.3 + bob, color, alpha: 0.9 }, cam);
    else scene.box({ x: -3 - ring + 0.28, z: t, w: 0.28, d: 0.28, y, h: 0.3 + bob, color, alpha: 0.9 }, cam);
  }

  // ---- two podiums, on opposite diagonals so the fighters never overlap on
  // screen: A sits back-left, B front-right, and the eye reads a face-off.
  const podiumA = { x: -2.1, z: -0.9 } as const;
  const podiumB = { x: 1.1, z: 1.9 } as const;
  scene.box({ x: podiumA.x, z: podiumA.z, w: 1.0, d: 1.0, h: 0.2, color: shade(spec.sideA, 0.7) }, cam);
  scene.box({ x: podiumB.x, z: podiumB.z, w: 1.0, d: 1.0, h: 0.2, color: shade(spec.sideB, 0.7) }, cam);

  // ---- fighters
  drawFighter(scene, cam, spec.sideA, podiumA.x + 0.5, podiumA.z + 0.5, state.fighterA, phase, "a", state);
  drawFighter(scene, cam, spec.sideB, podiumB.x + 0.5, podiumB.z + 0.5, state.fighterB, phase, "b", state);

  // ---- score columns behind each fighter: the taller one leads
  const maxScore = Math.max(1, state.scoreA, state.scoreB);
  column(scene, cam, spec, -2.9, -2.0, state.scoreA / maxScore, spec.sideA, phase, "a", state);
  column(scene, cam, spec, 2.0, 2.9, state.scoreB / maxScore, spec.sideB, phase, "b", state);

  // ---- floodlights at the far corners
  for (const [fx, fz] of [[-6, -6], [-6, 3], [3, -6]] as const) {
    scene.box({ x: fx, z: fz, w: 0.34, d: 0.34, h: 3.6, color: spec.stone }, cam);
    scene.box({ x: fx - 0.16, z: fz - 0.16, w: 0.7, d: 0.7, y: 3.6, h: 0.26, color: spec.accent, topColor: "#fff8dc" }, cam);
  }

  // ---- the winner's laurel: a ring of flowers around the winning fighter
  if (state.status === "closed" && state.winner && state.winner !== "tie") {
    const winning = state.winner === "a" ? spec.sideA : spec.sideB;
    const cx = state.winner === "a" ? podiumA.x + 0.55 : podiumB.x + 0.55;
    const cz = state.winner === "a" ? podiumA.z + 0.55 : podiumB.z + 0.55;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + phase * 0.35;
      scene.box({
        x: cx + Math.cos(a) * 0.85,
        z: cz + Math.sin(a) * 0.85,
        w: 0.14,
        d: 0.14,
        y: 0.12 + (i % 2) * 0.2,
        h: 0.4,
        color: winning,
        alpha: 0.9,
      }, cam);
    }
  }
}

function drawFighter(
  scene: IsoScene,
  cam: IsoCamera,
  color: string,
  x: number,
  z: number,
  image: HTMLImageElement | null | undefined,
  phase: number,
  side: "a" | "b",
  state: ArenaState,
): void {
  const bob = Math.sin(phase * 1.7 + (side === "a" ? 0 : 1.6)) * 0.05;
  const hit = state.impacts.filter((i) => i.side === side).reduce((s, i) => s + (1 - i.age) * 0.15, 0);
  const y = 0.22 + bob;
  const lunge = hit > 0 ? hit * 0.5 : 0;
  scene.shadow(x, z, 0.75, cam, 0.3);

  if (image && image.complete && image.naturalWidth > 0) {
    const p = project(x, y + 1.25, z, cam);
    const h = 96 * cam.scale;
    const w = (image.naturalWidth / Math.max(1, image.naturalHeight)) * h;
    scene.sprite({
      x,
      z,
      bias: 0.01,
      paint: (ctx) => {
        ctx.drawImage(image, p.x - w / 2 + lunge * 12, p.y - h, w, h);
      },
    });
    return;
  }

  // No artwork: a voxel fighter — legs, torso, head, and a raised fist. Made
  // 1.6× the old build so a fighter is a character, not a chess piece.
  const s = 1.6;
  const legY = y;
  scene.box({ x: x - 0.3 * s, z: z - 0.18 * s, w: 0.24 * s, d: 0.36 * s, y: legY, h: 0.34 * s, color: shade(color, 0.62) }, cam);
  scene.box({ x: x + 0.06 * s, z: z - 0.18 * s, w: 0.24 * s, d: 0.36 * s, y: legY, h: 0.34 * s, color: shade(color, 0.62) }, cam);
  scene.box({ x: x - 0.3 * s, z: z - 0.24 * s, w: 0.6 * s, d: 0.48 * s, y: legY + 0.34 * s, h: 0.42 * s, color }, cam);
  scene.box({ x: x - 0.2 * s, z: z - 0.18 * s, w: 0.4 * s, d: 0.34 * s, y: legY + 0.76 * s, h: 0.3 * s, color: shade(color, 1.18) }, cam);
  // headband
  scene.box({ x: x - 0.22 * s, z: z - 0.2 * s, w: 0.44 * s, d: 0.38 * s, y: legY + 0.86 * s, h: 0.09 * s, color: spec_accent_fallback(color) }, cam);
  // fists: forward when a punch landed, guarding otherwise
  const fistZ = z - 0.2 * s + lunge;
  scene.box({ x: x + 0.3 * s, z: fistZ, w: 0.2 * s, d: 0.2 * s, y: legY + 0.66 * s, h: 0.2 * s, color: shade(color, 1.3) }, cam);
  scene.box({ x: x - 0.42 * s, z: fistZ, w: 0.18 * s, d: 0.18 * s, y: legY + 0.6 * s, h: 0.18 * s, color: shade(color, 1.22) }, cam);
}

/** A lighter tint for details that must not blend into the body colour. */
function spec_accent_fallback(color: string): string {
  return mix(color, "#ffffff", 0.55);
}

function column(
  scene: IsoScene,
  cam: IsoCamera,
  spec: StadiumSpec,
  x: number,
  z: number,
  ratio: number,
  color: string,
  phase: number,
  side: "a" | "b",
  state: ArenaState,
): void {
  const pulse = 0.5 + 0.5 * Math.sin(phase * 3 + (side === "a" ? 0 : 1));
  // A column of glowing blocks. The height IS the score share, so the lead is
  // readable from across the room.
  const blocks = Math.max(1, Math.round(1 + ratio * 5));
  for (let i = 0; i < blocks; i++) {
    const wobble = Math.sin(phase * 2.4 + i) * 0.04;
    scene.box({
      x: x - 0.16 + wobble,
      z: z - 0.16,
      w: 0.32,
      d: 0.32,
      y: 0.2 + i * 0.34,
      h: 0.3,
      color: mix(color, spec.accent, (i / Math.max(1, blocks)) * 0.65),
      alpha: 0.6 + 0.4 * pulse,
    }, cam);
  }
  // Punch bursts: an expanding diamond over the fighter's chest.
  for (const impact of state.impacts.filter((i) => i.side === side)) {
    const age = impact.age;
    if (age >= 1) continue;
    const p = project(x + (side === "a" ? 0.8 : -0.9), 1.5, z + (side === "a" ? 0.8 : -0.9), cam);
    const r = (8 + age * 40) * cam.scale * (0.6 + impact.power * 0.5);
    scene.overlay((ctx) => {
      ctx.globalAlpha = (1 - age) * 0.95;
      ctx.strokeStyle = spec.accent;
      ctx.lineWidth = 2.5 * cam.scale;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - r);
      ctx.lineTo(p.x + r, p.y);
      ctx.lineTo(p.x, p.y + r);
      ctx.lineTo(p.x - r, p.y);
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }
}

/**
 * The map: a field of numbered plots, each a miniature stadium. The plot a
 * battle sits on comes from its id, so the map is stable without storing a
 * coordinate.
 */
export interface MapPlot {
  id: string;
  x: number;
  z: number;
  spec: StadiumSpec;
  live: boolean;
  sides: { a: string; b: string };
  score: { a: number; b: number };
}

export function buildMap(scene: IsoScene, plots: MapPlot[], cam: IsoCamera, phase: number): void {
  // Ground: a dark grid so the plots read as lights on a surface, not cards.
  for (let x = -7; x <= 7; x++) {
    for (let z = -7; z <= 7; z++) {
      const even = (x + z) % 2 === 0;
      scene.tile(x, z, even ? "#12111a" : "#17151f", cam, { alpha: 0.9 });
    }
  }

  for (const plot of plots) {
    const { spec, x, z } = plot;
    const pulse = plot.live ? 0.5 + 0.5 * Math.sin(phase * 2.4 + x + z) : 0;
    // Base plate
    scene.box({ x, z, w: 3, d: 3, h: 0.14, color: shade(spec.stone, 0.9) }, cam);
    // Ring of tiers
    for (let i = 0; i < 4; i++) {
      const o = i * 0.28;
      scene.box({ x: x + o, z: z + o, w: 3 - o * 2, d: 0.18, h: 0.3 + i * 0.16, color: i % 2 ? spec.tier : spec.stone }, cam);
      scene.box({ x: x + o, z: z + 3 - o - 0.18, w: 3 - o * 2, d: 0.18, h: 0.3 + i * 0.16, color: i % 2 ? spec.tier : spec.stone }, cam);
    }
    // Pitch
    scene.box({ x: x + 0.7, z: z + 0.7, w: 1.6, d: 1.6, h: 0.06, color: spec.floor }, cam);
    // Two side slivers — the score as a pair of blocks
    const total = Math.max(1, plot.score.a + plot.score.b);
    scene.box({ x: x + 0.7, z: z + 0.7, w: 0.7 * (plot.score.a / total) + 0.05, d: 1.6, h: 0.12, color: spec.sideA }, cam);
    scene.box({ x: x + 2.3 - 0.7 * (plot.score.b / total) - 0.05, z: z + 0.7, w: 0.7 * (plot.score.b / total) + 0.05, d: 1.6, h: 0.12, color: spec.sideB }, cam);
    // Flare
    if (plot.live) {
      scene.box({ x: x + 1.3, z: z + 1.3, w: 0.4, d: 0.4, y: 0.2, h: 0.9 + pulse * 0.6, color: spec.accent, alpha: 0.55 + pulse * 0.4 }, cam);
    }
  }
}

/* ------------------------------------------------------------------ canvas */

export function fitCamera(width: number, height: number, plotRadius: number): IsoCamera {
  // The scene is a diamond: 2r tiles across, r tiles tall, plus height for the
  // structures. Pick a tile size that keeps the whole diamond inside the box,
  // then lift the origin so the back of the bowl is not clipped.
  const tileW = Math.min(width / (plotRadius * 2.05), height / (plotRadius * 0.95));
  const tileH = tileW / 2;
  const originY = Math.max(height * 0.2, height / 2 - plotRadius * tileH * 0.45);
  return camera(tileW, tileH, width / 2, originY, 1);
}
