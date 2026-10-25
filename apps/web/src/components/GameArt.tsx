import type { JSX } from "react";

/**
 * Game artwork.
 *
 * Every game gets a drawn mark — no emoji anywhere in the catalogue. Each mark
 * is a small, purpose-built SVG on a shared 48×48 grid with a shared stroke
 * language, so the whole set reads as one designed family rather than a set of
 * clip-art. They are line marks with a single accent fill, which lets them sit
 * on any environment (the accent is passed in), and they scale cleanly from a
 * 20px chip to a 96px hero.
 *
 * The catalogue in the database still carries an `icon` column from the emoji
 * era; it is deliberately ignored. Identity comes from the game id, so a game
 * added to the catalogue without artwork still gets a coherent generated mark
 * (see `GameArt` fallback) rather than an emoji.
 */

type ArtProps = { size?: number; accent?: string; className?: string };

const STROKE = 2.1;

/** A card pip: the base shape for every card game. */
function cardFrame(accent: string): JSX.Element {
  return (
    <>
      <rect x="14" y="9" width="20" height="30" rx="3.5" stroke={accent} strokeWidth={STROKE} fill="none" />
      <path d="M19 16h10M19 21h10" stroke={accent} strokeWidth={STROKE} strokeLinecap="round" opacity="0.6" />
    </>
  );
}

/** The marks, keyed by game id. Falls back to a category mark. */
const MARKS: Record<string, (a: string) => JSX.Element> = {
  // ---- Cards -------------------------------------------------------------
  whot: (a) => (
    <>
      <rect x="13" y="8" width="22" height="32" rx="4" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 16l5 6-5 6-5-6z" fill={a} />
    </>
  ),
  blackjack: (a) => (
    <>
      {cardFrame(a)}
      <text x="24" y="30" textAnchor="middle" fontSize="12" fontWeight="800" fill={a}>21</text>
    </>
  ),
  poker: (a) => (
    <>
      <path d="M24 10c4 5 8 7.5 8 12a8 8 0 1 1-16 0c0-4.5 4-7 8-12z" fill={a} />
      <path d="M24 30v6" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  war: (a) => (
    <>
      <path d="M16 12l16 20M32 12L16 32" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M13 10l3 2-3 2zM35 10l-3 2 3 2z" fill={a} />
    </>
  ),
  gofish: (a) => (
    <>
      <path d="M12 24c6-7 16-7 22 0-6 7-16 7-22 0z" stroke={a} strokeWidth={STROKE} fill="none" />
      <circle cx="18" cy="24" r="1.6" fill={a} />
      <path d="M34 20l4-3v14l-4-3z" fill={a} />
    </>
  ),
  crazyeights: (a) => (
    <>
      <rect x="12" y="12" width="16" height="22" rx="3" stroke={a} strokeWidth={STROKE} fill="none" transform="rotate(-12 20 23)" />
      <rect x="20" y="14" width="16" height="22" rx="3" stroke={a} strokeWidth={STROKE} fill="none" transform="rotate(10 28 25)" />
    </>
  ),

  // ---- Board -------------------------------------------------------------
  tictactoe: (a) => (
    <>
      <path d="M19 10v28M29 10v28M10 19h28M10 29h28" stroke={a} strokeWidth={STROKE} strokeLinecap="round" opacity="0.5" />
      <path d="M14 14l6 6M20 14l-6 6" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="30" cy="30" r="3.4" stroke={a} strokeWidth={STROKE} fill="none" />
    </>
  ),
  connect4: (a) => (
    <>
      <rect x="11" y="12" width="26" height="24" rx="4" stroke={a} strokeWidth={STROKE} fill="none" />
      <circle cx="18" cy="20" r="2.6" fill={a} />
      <circle cx="30" cy="20" r="2.6" fill={a} opacity="0.5" />
      <circle cx="24" cy="29" r="2.6" fill={a} />
    </>
  ),
  gomoku: (a) => (
    <>
      <path d="M12 12h24v24H12z" stroke={a} strokeWidth={STROKE} fill="none" opacity="0.45" />
      <path d="M20 12v24M28 12v24M12 20h24M12 28h24" stroke={a} strokeWidth="1.2" opacity="0.35" />
      <circle cx="24" cy="24" r="3.4" fill={a} />
    </>
  ),
  checkers: (a) => (
    <>
      <rect x="11" y="11" width="26" height="26" rx="3" stroke={a} strokeWidth={STROKE} fill="none" />
      <circle cx="18" cy="18" r="3.2" fill={a} />
      <circle cx="30" cy="30" r="3.2" fill={a} />
      <circle cx="30" cy="18" r="3.2" stroke={a} strokeWidth="1.6" fill="none" />
    </>
  ),
  reversi: (a) => (
    <>
      <circle cx="24" cy="24" r="11" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 13a11 11 0 0 1 0 22z" fill={a} />
    </>
  ),
  battleship: (a) => (
    <>
      <path d="M11 27h26l-4 6H15z" fill={a} opacity="0.85" />
      <path d="M24 27V16" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M24 16h8" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M11 20h7M11 24h5" stroke={a} strokeWidth="1.4" opacity="0.5" />
    </>
  ),
  dots: (a) => (
    <>
      <path d="M14 14h20v20H14z" stroke={a} strokeWidth="1.3" opacity="0.4" fill="none" />
      <circle cx="14" cy="14" r="2.4" fill={a} />
      <circle cx="24" cy="14" r="2.4" fill={a} />
      <circle cx="34" cy="14" r="2.4" fill={a} />
      <circle cx="14" cy="24" r="2.4" fill={a} />
      <circle cx="24" cy="24" r="2.4" fill={a} />
      <circle cx="14" cy="34" r="2.4" fill={a} />
      <path d="M14 14h20" stroke={a} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M14 14v20" stroke={a} strokeWidth="2.4" strokeLinecap="round" />
    </>
  ),
  snakes: (a) => (
    <>
      <path d="M12 34h10a5 5 0 0 0 0-10H18a5 5 0 0 1 0-10h12" stroke={a} strokeWidth={STROKE} fill="none" strokeLinecap="round" />
      <circle cx="31" cy="14" r="2.6" fill={a} />
    </>
  ),

  // ---- Mind --------------------------------------------------------------
  memory: (a) => (
    <>
      <rect x="11" y="14" width="16" height="20" rx="3" stroke={a} strokeWidth={STROKE} fill="none" />
      <rect x="21" y="14" width="16" height="20" rx="3" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M27 22l3 3 5-6" stroke={a} strokeWidth={STROKE} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  hangman: (a) => (
    <>
      <path d="M13 37h22M17 37V12h14v6" stroke={a} strokeWidth={STROKE} strokeLinecap="round" fill="none" />
      <circle cx="31" cy="22" r="3.4" stroke={a} strokeWidth="1.8" fill="none" />
      <path d="M31 25.4V32M31 32l-3 4M31 32l3 4" stroke={a} strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  wordchain: (a) => (
    <>
      <circle cx="16" cy="24" r="5" stroke={a} strokeWidth={STROKE} fill="none" />
      <circle cx="32" cy="24" r="5" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M21 24h6" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  scramble: (a) => (
    <>
      <rect x="11" y="14" width="9" height="9" rx="2" fill={a} opacity="0.5" />
      <rect x="22" y="14" width="9" height="9" rx="2" fill={a} />
      <rect x="11" y="25" width="9" height="9" rx="2" fill={a} />
      <rect x="22" y="25" width="9" height="9" rx="2" fill={a} opacity="0.5" />
      <path d="M34 18h3M34 29h3" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  trivia: (a) => (
    <>
      <path d="M20 30c0-5 5-6 5-11a5 5 0 1 1 8 3c-2 2-4 3-4 6" stroke={a} strokeWidth={STROKE} fill="none" strokeLinecap="round" />
      <circle cx="25" cy="36" r="1.8" fill={a} />
    </>
  ),
  sudoku: (a) => (
    <>
      <rect x="11" y="11" width="26" height="26" rx="3" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M19.7 11v26M28.3 11v26M11 19.7h26M11 28.3h26" stroke={a} strokeWidth="1.2" opacity="0.45" />
      <rect x="20" y="20" width="8" height="8" fill={a} opacity="0.75" />
    </>
  ),

  // ---- Action ------------------------------------------------------------
  reaction: (a) => (
    <>
      <path d="M26 9L15 27h8l-3 12 13-19h-8z" fill={a} />
    </>
  ),
  penalty: (a) => (
    <>
      <circle cx="24" cy="24" r="11" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 13v5M24 30v5M13 24h5M30 24h5" stroke={a} strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
      <path d="M24 20l3 3-3 5-3-5z" fill={a} />
    </>
  ),
  simon: (a) => (
    <>
      <path d="M24 11a13 13 0 0 1 13 13H24z" fill={a} />
      <path d="M24 24h13a13 13 0 0 1-13 13z" fill={a} opacity="0.45" />
      <path d="M24 24v13A13 13 0 0 1 11 24z" fill={a} opacity="0.25" />
      <circle cx="24" cy="24" r="3" fill="var(--surface-0)" />
    </>
  ),
  rps: (a) => (
    <>
      <path d="M18 30V18a2.5 2.5 0 0 1 5 0v-2a2.5 2.5 0 0 1 5 0v2a2.5 2.5 0 0 1 5 0v10a6 6 0 0 1-6 6h-4a6 6 0 0 1-5-6z" stroke={a} strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      <path d="M14 22l3 2-3 2z" fill={a} opacity="0.6" />
    </>
  ),

  // ---- Casino ------------------------------------------------------------
  dice: (a) => (
    <>
      <rect x="12" y="12" width="24" height="24" rx="5" stroke={a} strokeWidth={STROKE} fill="none" />
      <circle cx="19" cy="19" r="2.2" fill={a} />
      <circle cx="29" cy="29" r="2.2" fill={a} />
      <circle cx="24" cy="24" r="2.2" fill={a} />
    </>
  ),
  roulette: (a) => (
    <>
      <circle cx="24" cy="24" r="12" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 12v6M24 30v6M12 24h6M30 24h6" stroke={a} strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      <circle cx="24" cy="24" r="3.4" fill={a} />
    </>
  ),
  slots: (a) => (
    <>
      <rect x="11" y="14" width="26" height="20" rx="4" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M19.5 14v20M28.5 14v20" stroke={a} strokeWidth="1.2" opacity="0.5" />
      <text x="15.5" y="29" fontSize="9" fontWeight="800" fill={a}>7</text>
      <text x="24" y="29" fontSize="9" fontWeight="800" fill={a}>7</text>
      <text x="32.5" y="29" fontSize="9" fontWeight="800" fill={a}>7</text>
    </>
  ),
  crash: (a) => (
    <>
      <path d="M11 35c6 0 8-4 11-9s5-9 11-9" stroke={a} strokeWidth={STROKE} fill="none" strokeLinecap="round" />
      <path d="M29 15h5v5" stroke={a} strokeWidth={STROKE} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  plinko: (a) => (
    <>
      <path d="M24 11v4" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="24" cy="17" r="2.4" fill={a} />
      <circle cx="18" cy="26" r="1.6" fill={a} opacity="0.7" />
      <circle cx="30" cy="26" r="1.6" fill={a} opacity="0.7" />
      <circle cx="24" cy="31" r="1.6" fill={a} opacity="0.7" />
      <path d="M13 38h22" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),

  // ---- Party -------------------------------------------------------------
  wyr: (a) => (
    <>
      <path d="M24 12v24" stroke={a} strokeWidth={STROKE} strokeLinecap="round" opacity="0.5" />
      <path d="M13 20l8-5v18l-8-5z" fill={a} opacity="0.7" />
      <path d="M35 20l-8-5v18l8-5z" fill={a} />
    </>
  ),
  neverhave: (a) => (
    <>
      <path d="M12 24c6-7 18-7 24 0-6 7-18 7-24 0z" stroke={a} strokeWidth={STROKE} fill="none" />
      <circle cx="24" cy="24" r="3.4" fill={a} />
      <path d="M14 15l20 18" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  truthdare: (a) => (
    <>
      <path d="M24 11l11 6v10c0 7-5 11-11 13-6-2-11-6-11-13V17z" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 20v7" stroke={a} strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="24" cy="31" r="1.7" fill={a} />
    </>
  ),
  charades: (a) => (
    <>
      <path d="M13 18h22v14H13z" stroke={a} strokeWidth={STROKE} fill="none" rx="3" />
      <circle cx="24" cy="25" r="3" fill={a} />
      <path d="M13 21h22" stroke={a} strokeWidth="1.4" opacity="0.5" />
    </>
  ),
  twentyq: (a) => (
    <>
      <circle cx="24" cy="24" r="12" stroke={a} strokeWidth={STROKE} fill="none" />
      <text x="24" y="29" textAnchor="middle" fontSize="13" fontWeight="800" fill={a}>20</text>
    </>
  ),

  // ---- Rooms / other -----------------------------------------------------
  match: (a) => (
    <>
      <circle cx="24" cy="24" r="12" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 12l4 8-4 8-4-8z" fill={a} />
    </>
  ),
};

/** Category fallbacks, so an unlisted game still gets a designed mark. */
const CATEGORY_MARKS: Record<string, (a: string) => JSX.Element> = {
  cards: (a) => (
    <>
      <rect x="15" y="10" width="18" height="28" rx="4" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 19l4 5-4 5-4-5z" fill={a} />
    </>
  ),
  board: (a) => (
    <>
      <rect x="11" y="11" width="26" height="26" rx="4" stroke={a} strokeWidth={STROKE} fill="none" />
      <path d="M24 11v26M11 24h26" stroke={a} strokeWidth="1.2" opacity="0.45" />
      <circle cx="17.5" cy="17.5" r="2.6" fill={a} />
      <circle cx="30.5" cy="30.5" r="2.6" fill={a} opacity="0.55" />
    </>
  ),
  casino: (a) => (
    <>
      <rect x="12" y="12" width="24" height="24" rx="5" stroke={a} strokeWidth={STROKE} fill="none" />
      <circle cx="24" cy="24" r="2.4" fill={a} />
      <circle cx="18" cy="18" r="2" fill={a} />
      <circle cx="30" cy="30" r="2" fill={a} />
    </>
  ),
  mind: (a) => (
    <>
      <path d="M20 30c0-5 5-6 5-11a5 5 0 1 1 8 3c-2 2-4 3-4 6" stroke={a} strokeWidth={STROKE} fill="none" strokeLinecap="round" />
      <circle cx="25" cy="36" r="1.8" fill={a} />
    </>
  ),
  action: (a) => <path d="M26 9L15 27h8l-3 12 13-19h-8z" fill={a} />,
  party: (a) => (
    <>
      <path d="M13 36l9-22 11 11z" fill={a} opacity="0.8" />
      <circle cx="33" cy="16" r="2" fill={a} />
      <circle cx="28" cy="11" r="1.6" fill={a} opacity="0.7" />
      <circle cx="37" cy="23" r="1.6" fill={a} opacity="0.7" />
    </>
  ),
};

/**
 * A game's mark. Pass the environment accent so the artwork sits inside the
 * room it belongs to.
 */
export function GameArt({
  gameId,
  category,
  size = 48,
  accent = "currentColor",
  className,
}: ArtProps & { gameId: string; category?: string }): JSX.Element {
  const draw = MARKS[gameId] ?? CATEGORY_MARKS[category ?? ""] ?? MARKS.dice!;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {draw(accent)}
    </svg>
  );
}

/**
 * The palette for each game world.
 *
 * One table drives the covers, the featured band and the category shelf, so the
 * arcade reads as a single lit place: a cards room is plum and neon pink, a
 * board room is cold blue steel, a casino floor is gold on lacquer. Each entry
 * carries the two plate colours, the accent its artwork is drawn in, and the
 * motif that textures the plate. Kept here rather than in the component so the
 * hero and the tile can never drift apart.
 */
export type WorldMotif = "grid" | "rays" | "chips" | "spark" | "circuit" | "confetti";
export interface World {
  label: string;
  from: string;
  to: string;
  accent: string;
  motif: WorldMotif;
  /** One line of atmosphere for the category header. */
  tagline: string;
}

export const GAME_WORLDS: Record<string, World> = {
  cards: { label: "Cards", from: "#2a1430", to: "#120a1c", accent: "#ff7ab8", motif: "spark", tagline: "Bluff, match and call it." },
  board: { label: "Board", from: "#0e2036", to: "#08111f", accent: "#5cc8ff", motif: "grid", tagline: "Slow hands, long evenings." },
  casino: { label: "Casino", from: "#2a1f0a", to: "#140f05", accent: "#ffc247", motif: "chips", tagline: "Fast rounds, real nerve." },
  mind: { label: "Mind", from: "#0f2a2c", to: "#07171a", accent: "#4fe0c6", motif: "circuit", tagline: "Words, memory, quick thinking." },
  action: { label: "Action", from: "#2c1408", to: "#160a04", accent: "#ff9d3c", motif: "rays", tagline: "Reflex and nerve." },
  party: { label: "Party", from: "#2a0f2c", to: "#160818", accent: "#e07aff", motif: "confetti", tagline: "Loud games for a group." },
};

/** The material a table's surface is made of, so Play is not one room. */
export type WorldFelt = "baize" | "felt" | "lacquer" | "slate" | "neon";

export const WORLD_FELT: Record<string, WorldFelt> = {
  cards: "baize",
  board: "slate",
  casino: "lacquer",
  mind: "neon",
  action: "felt",
  party: "neon",
};

export function feltFor(category?: string): WorldFelt {
  return (category && WORLD_FELT[category]) || "felt";
}

export const DEFAULT_WORLD: World = {
  label: "Arcade", from: "#1a1c2c", to: "#0c0d16", accent: "#8f9bff", motif: "spark", tagline: "Everything in the arcade.",
};

export function worldFor(category?: string): World {
  return (category && GAME_WORLDS[category]) || DEFAULT_WORLD;
}

/**
 * A world as CSS custom properties, so a table can wear its own environment.
 *
 * The game table is where "Play" should stop looking like a settings page. Each
 * game's world already has a plate palette for the catalogue; this hands the same
 * palette to the table surface, so a casino round sits on gold lacquer and a
 * board game sits on cold steel. Returns a plain style object — the felt itself
 * is CSS, keyed off these variables and `data-world`.
 */
export function worldVars(category?: string): Record<string, string> {
  const w = worldFor(category);
  return {
    "--felt-from": w.from,
    "--felt-to": w.to,
    "--felt-accent": w.accent,
  };
}

/** Every world, in the order the shelf should show them. */
export const WORLD_ORDER = ["cards", "board", "mind", "action", "casino", "party"];

/**
 * A game's cover: the mark on a lit, textured plate. This is the artwork for a
 * card in a grid — composed from the game's own environment colours rather than
 * a single repeated template, so a casino game and a board game read differently
 * at a glance.
 */
export function GameCover({
  gameId,
  category,
  name,
  size = 48,
  className,
}: {
  gameId: string;
  category?: string;
  name?: string;
  size?: number;
  className?: string;
}): JSX.Element {
  const l = worldFor(category);
  const gid = `gc-${gameId}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      /* A poster crops the square tile to a wide frame by narrowing the viewBox
         to the middle band, so the drawing fills a 16:10 panel without a CSS
         transform. Scaling the element instead enlarged its layout box past the
         container and every cover reported as page overflow. */
      preserveAspectRatio={className?.includes("is-fill") ? "xMidYMid slice" : undefined}
      fill="none"
      className={className}
      role={name ? "img" : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={l.from} />
          <stop offset="1" stopColor={l.to} />
        </linearGradient>
        <radialGradient id={`${gid}-lit`} cx="0.8" cy="0.1" r="0.9">
          <stop offset="0" stopColor={l.accent} stopOpacity="0.5" />
          <stop offset="1" stopColor={l.accent} stopOpacity="0" />
        </radialGradient>
        {/* A soft floor light under the mark, so the plate reads as lit from
            above rather than flatly filled. */}
        <radialGradient id={`${gid}-floor`} cx="0.5" cy="1" r="0.7">
          <stop offset="0" stopColor={l.accent} stopOpacity="0.34" />
          <stop offset="1" stopColor={l.accent} stopOpacity="0" />
        </radialGradient>
        {/* The mark itself is filled with a slight vertical sheen so it has a
            surface, not just a silhouette. */}
        <linearGradient id={`${gid}-mark`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={l.accent} />
          <stop offset="1" stopColor={l.accent} stopOpacity="0.72" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="18" fill={`url(#${gid})`} />
      {l.motif === "grid" && (
        <g opacity="0.16" stroke={l.accent} strokeWidth="1">
          <path d="M0 24h96M0 48h96M0 72h96M24 0v96M48 0v96M72 0v96" />
        </g>
      )}
      {l.motif === "rays" && (
        <g opacity="0.18" stroke={l.accent} strokeWidth="1.4">
          <path d="M48 48L0 20M48 48L96 20M48 48L0 76M48 48L96 76" />
        </g>
      )}
      {l.motif === "chips" && (
        <g opacity="0.2" fill="none" stroke={l.accent} strokeWidth="1.4">
          <circle cx="20" cy="76" r="9" />
          <circle cx="78" cy="20" r="7" />
        </g>
      )}
      {l.motif === "circuit" && (
        <g opacity="0.16" stroke={l.accent} strokeWidth="1.1" fill="none">
          <path d="M0 30h30V0M66 96V66h30M96 34H70V0M0 70h26v26" />
          <circle cx="30" cy="30" r="2.4" fill={l.accent} stroke="none" />
          <circle cx="70" cy="66" r="2.4" fill={l.accent} stroke="none" />
        </g>
      )}
      {l.motif === "confetti" && (
        <g opacity="0.26" fill={l.accent}>
          <rect x="14" y="18" width="6" height="3" rx="1.5" transform="rotate(24 14 18)" />
          <rect x="76" y="26" width="6" height="3" rx="1.5" transform="rotate(-32 76 26)" />
          <rect x="22" y="74" width="6" height="3" rx="1.5" transform="rotate(-14 22 74)" />
          <rect x="70" y="72" width="6" height="3" rx="1.5" transform="rotate(38 70 72)" />
          <circle cx="48" cy="14" r="2" />
        </g>
      )}
      {l.motif === "spark" && (
        <g opacity="0.2" fill={l.accent}>
          <path d="M18 70l1.6 4.4L24 76l-4.4 1.6L18 82l-1.6-4.4L12 76l4.4-1.6z" />
          <path d="M78 22l1.3 3.4L83 27l-3.7 1.3L78 32l-1.3-3.7L73 27l3.7-1.6z" />
        </g>
      )}
      <rect width="96" height="96" rx="18" fill={`url(#${gid}-lit)`} />
      <rect width="96" height="96" rx="18" fill={`url(#${gid}-floor)`} />
      {/* The mark is drawn on the shared 48×48 grid and centred on the plate. */}
      <g transform="translate(24 24)">
        {(MARKS[gameId] ?? CATEGORY_MARKS[category ?? ""] ?? MARKS.dice!)(`url(#${gid}-mark)`)}
      </g>
      {/* An inner rim: the plate's edge catching the room light. */}
      <rect x="0.75" y="0.75" width="94.5" height="94.5" rx="17.25" fill="none" stroke="rgba(255,255,255,0.14)" />
      <rect width="96" height="96" rx="18" fill="none" stroke="rgba(0,0,0,0.35)" />
    </svg>
  );
}
