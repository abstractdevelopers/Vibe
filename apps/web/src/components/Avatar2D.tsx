import type { JSX } from "react";
import { traitsFor, shade, faceWidth, faceHeight } from "../avatar";

/**
 * A drawn 2D avatar.
 *
 * Every user gets a face built from their id, so nobody is a grey initial.
 * The drawing reads the shared trait model, which means the 2D face and the 3D
 * head (see Avatar3D) are the same character: same skin, same hair, same
 * clothes. This one is the cheap path — it is a single inline SVG with no
 * runtime cost, so it can appear in a feed of a hundred of them.
 */

const STROKE = 1.6;

function hair(style: number, color: string, dark: string): JSX.Element {
  switch (style) {
    case 1: // afro
      return (
        <>
          <circle cx="50" cy="34" r="27" fill={color} />
          <circle cx="50" cy="40" r="24" fill={dark} opacity="0.25" />
        </>
      );
    case 2: // bob
      return (
        <>
          <path d="M23 44c0-17 12-27 27-27s27 10 27 27v16c0 3-5 3-5 0V46c-6 4-14 6-22 6s-16-2-22-6v14c0 3-5 3-5 0z" fill={color} />
        </>
      );
    case 3: // long
      return (
        <>
          <path d="M22 46c0-18 13-29 28-29s28 11 28 29v30c0 3-5 3-5 0V50c-5 5-14 8-23 8s-18-3-23-8v26c0 3-5 3-5 0z" fill={color} />
        </>
      );
    case 4: // bun
      return (
        <>
          <circle cx="50" cy="14" r="9" fill={color} />
          <path d="M24 44c0-16 12-26 26-26s26 10 26 26c0 4-3 6-6 6H30c-3 0-6-2-6-6z" fill={color} />
        </>
      );
    case 5: // wrap
      return (
        <>
          <path d="M21 42c0-18 13-28 29-28s29 10 29 28c0 3-2 5-5 5H26c-3 0-5-2-5-5z" fill={color} />
          <path d="M21 40c8 4 18 6 29 6s21-2 29-6" stroke={dark} strokeWidth={STROKE} fill="none" opacity="0.5" />
        </>
      );
    default: // crop
      return <path d="M25 42c0-15 11-25 25-25s25 10 25 25c0 4-4 5-7 3-6-4-12-6-18-6s-12 2-18 6c-3 2-7 1-7-3z" fill={color} />;
  }
}

function mouth(expression: number): JSX.Element {
  switch (expression) {
    case 1:
      return <path d="M42 66c3 5 13 5 16 0z" fill="#8a3b34" />;
    case 2:
      return <path d="M43 67h14" stroke="#8a3b34" strokeWidth={STROKE} strokeLinecap="round" />;
    case 3:
      return <circle cx="50" cy="67" r="3.4" fill="#8a3b34" />;
    default:
      return <path d="M42 64c3 4 13 4 16 0" stroke="#8a3b34" strokeWidth={STROKE} strokeLinecap="round" fill="none" />;
  }
}

function accessory(kind: number, clothes: string): JSX.Element | null {
  switch (kind) {
    case 1: // glasses
      return (
        <g stroke="#2b2b2b" strokeWidth={STROKE} fill="none">
          <rect x="33" y="50" width="14" height="10" rx="3" />
          <rect x="53" y="50" width="14" height="10" rx="3" />
          <path d="M47 55h6" />
        </g>
      );
    case 2: // earrings
      return (
        <g fill="#e0b23f">
          <circle cx="24" cy="58" r="2.6" />
          <circle cx="76" cy="58" r="2.6" />
        </g>
      );
    case 3: // cap
      return (
        <g>
          <path d="M24 40c0-15 12-24 26-24s26 9 26 24z" fill={clothes} />
          <path d="M20 40h60c2 0 2 4 0 4H20c-2 0-2-4 0-4z" fill={shade(clothes, -0.2)} />
        </g>
      );
    default:
      return null;
  }
}

export function Avatar2D({
  seed,
  size = 48,
  className,
  title,
  fluid = false,
}: {
  seed: string;
  size?: number;
  className?: string;
  title?: string;
  /** Fill the parent box instead of a fixed size, so CSS controls it. */
  fluid?: boolean;
}): JSX.Element {
  const t = traitsFor(seed);
  const fw = faceWidth(t.face);
  const fh = faceHeight(t.face);
  const uid = `a2d-${seed.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={fluid ? { display: "block", width: "100%", height: "100%", borderRadius: "50%" } : { display: "block", borderRadius: "50%" }}
    >
      <defs>
        <clipPath id={`${uid}-clip`}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${uid}-clip)`}>
        <rect width="100" height="100" fill={t.background} />
        {/* Shoulders and neck, then the head over them. */}
        <path d="M18 100c0-16 14-24 32-24s32 8 32 24z" fill={t.clothes} />
        <path d="M43 66h14v14c0 3-14 3-14 0z" fill={t.skinShade} />
        <ellipse cx="50" cy={48} rx={fw} ry={fh} fill={t.skin} />
        {/* Ears sit under the hair so a long style covers them. */}
        <ellipse cx={50 - fw} cy="52" rx="4.5" ry="6.5" fill={t.skin} />
        <ellipse cx={50 + fw} cy="52" rx="4.5" ry="6.5" fill={t.skin} />
        {hair(t.hairStyle, t.hairColor, shade(t.hairColor, 0.3))}
        {/* Eyes: whites, pupils, and a brow for the non-neutral faces. */}
        <ellipse cx="41" cy="53" rx="4.2" ry="4.6" fill="#fff" />
        <ellipse cx="59" cy="53" rx="4.2" ry="4.6" fill="#fff" />
        <circle cx="41.5" cy="53.5" r="2.1" fill="#241c17" />
        <circle cx="58.5" cy="53.5" r="2.1" fill="#241c17" />
        {t.expression !== 2 && (
          <g stroke={shade(t.hairColor, 0.15)} strokeWidth={STROKE} strokeLinecap="round" fill="none">
            <path d="M37 46c2-2 6-2 8 0" />
            <path d="M55 46c2-2 6-2 8 0" />
          </g>
        )}
        {mouth(t.expression)}
        {accessory(t.accessory, t.clothes)}
      </g>
    </svg>
  );
}
