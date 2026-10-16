import { useEffect, useMemo } from "react";

/**
 * The animation played when a gift is sent.
 *
 * This is the TikTok-live shape: a hero burst in the centre plus a stream of
 * emoji rising and drifting up the screen. It is deliberately CSS-only — no
 * canvas, no animation library — so it costs nothing in the bundle and cannot
 * fail to load.
 *
 * It is decoration over an action that has already happened. The gift is
 * recorded before this mounts, and this removes itself when the animation ends,
 * so a dropped frame never affects whether a gift was sent. Everything is
 * disabled under prefers-reduced-motion, and the component renders nothing
 * visual in that case beyond a brief static confirmation.
 *
 * `count` only changes how many emoji float; it never changes what was sent.
 */
export interface GiftBurstSpec {
  /** A new id each time, so a repeat gift replays the animation. */
  id: number;
  emoji: string;
  label: string;
  count: number;
}

/** How many floating emoji to render, capped so a 100x gift cannot flood the DOM. */
const MAX_FLOATING = 14;
const DURATION_MS = 2200;

export function GiftBurst({ spec, onDone }: { spec: GiftBurstSpec; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, DURATION_MS);
    return () => window.clearTimeout(t);
  }, [spec.id, onDone]);

  // Precompute the floaters so their randomised positions are stable across
  // re-renders (a re-render must not make them jump).
  const floaters = useMemo(() => {
    const n = Math.max(1, Math.min(spec.count, MAX_FLOATING));
    return Array.from({ length: n }, (_, i) => ({
      key: `${spec.id}-${i}`,
      left: 12 + ((i * 37) % 76), // spread across the width, deterministic
      delay: (i % 5) * 90,
      drift: ((i % 3) - 1) * 22,
      size: 28 + ((i * 7) % 18),
    }));
  }, [spec.id, spec.count]);

  return (
    <div className="gift-burst" aria-hidden="true">
      <div className="gift-burst-hero">
        <span className="gift-burst-hero-emoji">{spec.emoji}</span>
        {spec.count > 1 && <span className="gift-burst-count">×{spec.count}</span>}
      </div>
      {floaters.map((f) => (
        <span
          key={f.key}
          className="gift-burst-float"
          style={{
            left: `${f.left}%`,
            fontSize: `${f.size}px`,
            animationDelay: `${f.delay}ms`,
            ["--drift" as string]: `${f.drift}px`,
          }}
        >
          {spec.emoji}
        </span>
      ))}
      <span className="gift-burst-label">Sent {spec.label}</span>
    </div>
  );
}
