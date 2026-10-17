import { useEffect, useMemo } from "react";
import { GiftArt, giftGlow, type GiftTier } from "./GiftArt";

/**
 * The animation played when a gift is sent.
 *
 * A staged sequence rather than a single pop: the gift punches in and holds, a
 * shock ring expands behind it, sparks fly, and a stream of the same gift drifts
 * up the screen. It is CSS-only — no canvas, no animation library — so it costs
 * nothing in the bundle and cannot fail to load.
 *
 * It is decoration over an action that has already happened. The gift is
 * recorded before this mounts, and this removes itself when the sequence ends,
 * so a dropped frame never affects whether a gift was sent. Under
 * prefers-reduced-motion the whole thing collapses to a static confirmation.
 *
 * `count` only changes how many marks float; it never changes what was sent.
 * `tier` adds intensity for the larger paid gifts; it never changes the price.
 */
export interface GiftBurstSpec {
  /** A new id each time, so a repeat gift replays the animation. */
  id: number;
  /** The gift id, so the burst draws the same mark that was sent. */
  giftId: string;
  label: string;
  count: number;
  tier?: GiftTier;
}

/** How many floating marks to render, capped so a 100x gift cannot flood the DOM. */
const MAX_FLOATING = 16;
const DURATION_MS = 2600;

export function GiftBurst({ spec, onDone }: { spec: GiftBurstSpec; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, DURATION_MS);
    return () => window.clearTimeout(t);
  }, [spec.id, onDone]);

  const tier = spec.tier ?? 1;

  // Precompute the floaters so their randomised positions are stable across
  // re-renders (a re-render must not make them jump).
  const floaters = useMemo(() => {
    const n = Math.max(1, Math.min(spec.count, MAX_FLOATING));
    return Array.from({ length: n }, (_, i) => ({
      key: `${spec.id}-${i}`,
      left: 10 + ((i * 37) % 80),
      delay: (i % 6) * 80,
      drift: ((i % 3) - 1) * 26,
      size: 24 + ((i * 7) % 22),
    }));
  }, [spec.id, spec.count]);

  return (
    <div
      className={`gift-burst tier-${tier}`}
      aria-hidden="true"
      style={{ ["--gift-glow" as string]: giftGlow(spec.giftId) }}
    >
      <span className="gift-burst-ring" />
      <span className="gift-burst-ring delay" />
      <div className="gift-burst-hero">
        <GiftArt id={spec.giftId} size={tier === 3 ? 176 : tier === 2 ? 140 : 112} tier={tier} />
        {spec.count > 1 && <span className="gift-burst-count">×{spec.count}</span>}
      </div>
      {floaters.map((f) => (
        <span
          key={f.key}
          className="gift-burst-float"
          style={{
            left: `${f.left}%`,
            animationDelay: `${f.delay}ms`,
            ["--drift" as string]: `${f.drift}px`,
          }}
        >
          <GiftArt id={spec.giftId} size={f.size} tier={1} />
        </span>
      ))}
      <span className="gift-burst-label">Sent {spec.label}</span>
    </div>
  );
}
