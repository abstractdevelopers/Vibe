import { useEffect, useRef, useState } from "react";
import {
  buildArena,
  buildMap,
  fitCamera,
  IsoScene,
  stadium,
  type ArenaState,
  type MapPlot,
} from "../iso";

/**
 * A canvas that paints the isometric battle world.
 *
 * Two shapes, one renderer: `arena` is a single bowl you stand in front of,
 * `map` is the field of stadiums. A `thumb` is the arena drawn once, at a small
 * size, for a card — animating thirty of those is how a list starts dropping
 * frames on a phone, so it paints a single still frame instead.
 *
 * The scene is a pure function of `phase`, so the animation is just a counter
 * advancing on an interval. It pauses when the document is hidden.
 */

interface Props {
  kind: "arena" | "map" | "thumb";
  stadiumId?: string | null;
  arena?: ArenaState;
  plots?: MapPlot[];
  /** Card artwork, so a character shows in the bowl. */
  fighterAUrl?: string | null;
  fighterBUrl?: string | null;
  className?: string;
  /** Accessible description; the canvas is decorative otherwise. */
  label?: string;
}

/**
 * Load an image and hand it back *after* it has decoded. A synchronous
 * `img.src = …; return img` would give the renderer a permanently empty element
 * for the first frame and never a second one.
 */
function useImage(url: string | null | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!url) {
      setImg(null);
      return;
    }
    let live = true;
    const el = new Image();
    el.decoding = "async";
    el.crossOrigin = "anonymous";
    el.onload = () => { if (live) setImg(el); };
    el.onerror = () => { if (live) setImg(null); };
    el.src = url;
    return () => { live = false; };
  }, [url]);
  return img;
}

export function BattleCanvas({
  kind,
  stadiumId,
  arena,
  plots,
  fighterAUrl,
  fighterBUrl,
  className,
  label,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef(0);
  const imgA = useImage(fighterAUrl);
  const imgB = useImage(fighterBUrl);
  // The loop must read the *current* state each frame, not the state it was
  // created with: scores arrive over the socket while the crowds are bobbing.
  const latest = useRef({ arena, plots });
  latest.current = { arena, plots };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = 0;
    let width = 0;
    let height = 0;
    const spec = stadium(stadiumId);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);

    const paint = (phase: number) => {
      const { arena: liveArena, plots: livePlots } = latest.current;
      ctx.clearRect(0, 0, width, height);

      // Backdrop: two stops, flat bands rather than a decorative gradient.
      // Kept because it is the sky of an illustrated scene, not app chrome.
      const sky = ctx.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, spec.sky[0]);
      sky.addColorStop(1, spec.sky[1]);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);

      const scene = new IsoScene();

      if (kind === "map") {
        const cam = fitCamera(width, height, 7);
        buildMap(scene, livePlots ?? [], cam, phase);
      } else {
        const cam = fitCamera(width, height, kind === "thumb" ? 6.5 : 6);
        buildArena(scene, spec, {
          scoreA: liveArena?.scoreA ?? 0,
          scoreB: liveArena?.scoreB ?? 0,
          crowd: liveArena?.crowd ?? 0,
          phase,
          remaining: liveArena?.remaining ?? 1,
          status: liveArena?.status ?? "open",
          winner: liveArena?.winner ?? null,
          impacts: liveArena?.impacts ?? [],
          fighterA: imgA,
          fighterB: imgB,
        }, cam);
      }

      scene.draw(ctx);
    };

    if (kind === "thumb") {
      paint(frame.current * 0.6);
      return () => observer?.disconnect();
    }

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (t - last < 40) return; // ~25fps is enough for a bobbing crowd
      last = t;
      frame.current += (t % 1000) / 1000;
      paint(frame.current);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
    // `arena` is intentionally not a dependency: the animation reads it through
    // the closure each frame, and re-creating the loop on every score tick
    // would restart the crowd mid-wave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, stadiumId, plots, imgA, imgB]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
