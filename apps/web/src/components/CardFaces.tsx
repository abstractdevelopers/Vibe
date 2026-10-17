import type { JSX } from "react";

/**
 * Card faces.
 *
 * Drawn marks for the shapes and suits a game engine can deal, so a hand of
 * cards is drawn rather than typed. Whot's shapes and a standard deck's suits
 * are both covered; anything unknown falls back to a neutral pip.
 *
 * Colour is inherited (`currentColor`), so a red suit is red by CSS, and the
 * whole card recolours with the environment.
 */

const S = 2.2;

function shape(shape: string, size: number): JSX.Element {
  switch (shape) {
    case "circle":
      return <circle cx="12" cy="12" r="7.5" fill="currentColor" />;
    case "triangle":
      return <path d="M12 4.5l8 15H4z" fill="currentColor" />;
    case "cross":
      return <path d="M12 4l3 5h5l-3.5 4 3.5 4h-5l-3 5-3-5H4l3.5-4L4 9h5z" fill="currentColor" />;
    case "square":
      return <rect x="5" y="5" width="14" height="14" rx="2.4" fill="currentColor" />;
    case "star":
      return <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z" fill="currentColor" />;
    case "whot":
      // Whot 20 — a star in a ring, the game's own mark.
      return (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.6" />
          <path d="M12 4.5l2.4 5 5.5.7-4 3.8.9 5.5L12 16.9 7.2 19.5l.9-5.5-4-3.8 5.5-.7z" fill="currentColor" />
        </>
      );
    default:
      return <circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.6" />;
  }
}

function suit(s: string): JSX.Element {
  switch (s) {
    case "S":
      return <path d="M12 3c4 5 7 7 7 10.5A5 5 0 0 1 12 16a5 5 0 0 1-7-2.5C5 10 8 8 12 3zM10 18h4l1 3h-6z" fill="currentColor" />;
    case "H":
      return <path d="M12 20S4 14.5 4 9.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 8 3.5C20 14.5 12 20 12 20z" fill="currentColor" />;
    case "D":
      return <path d="M12 3l7 9-7 9-7-9z" fill="currentColor" />;
    case "C":
      return (
        <>
          <circle cx="12" cy="8" r="3.6" fill="currentColor" />
          <circle cx="7.5" cy="14" r="3.6" fill="currentColor" />
          <circle cx="16.5" cy="14" r="3.6" fill="currentColor" />
          <path d="M11 12h2l1.4 9h-4.8z" fill="currentColor" />
        </>
      );
    default:
      return <circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.6" />;
  }
}

export function ShapeMark({ shape: sh, size = 24 }: { shape: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
      {shape(sh, size)}
    </svg>
  );
}

export function SuitMark({ suit: su, size = 24 }: { suit: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
      {suit(su)}
    </svg>
  );
}

/** The five Whot shapes, in the order the game deals them. */
export const WHOT_SHAPES = ["circle", "triangle", "cross", "square", "star"] as const;
export const SHAPE_NAME: Record<string, string> = {
  circle: "Circle", triangle: "Triangle", cross: "Cross", square: "Square", star: "Star",
};

/**
 * A board piece — a drawn disc rather than a text glyph, so a checkers board and
 * a Reversi board look like boards. `tone` picks the material, `king` adds the
 * crown for a crowned checker.
 */
export function Piece({ tone, king = false }: { tone: "light" | "dark"; king?: boolean }): JSX.Element {
  return (
    <span className={`piece ${tone}${king ? " king" : ""}`} aria-hidden="true">
      {king && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 8l3 3 3-5 2 4 2-4 3 5 3-3-2 11H6z" />
        </svg>
      )}
    </span>
  );
}
