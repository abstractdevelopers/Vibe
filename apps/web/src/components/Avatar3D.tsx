import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { traitsFor, shade } from "../avatar";
import { mergeMeshes, renderMesh, scaleMesh, sphere, type Mesh, type Vec3 } from "../three-lite";

/**
 * A 3D avatar, rendered in software.
 *
 * The head is built from the same traits as the 2D avatar, so a person's face
 * is the same character in both. It is drawn with three-lite rather than a 3D
 * library: the main bundle is already near its budget, and a sphere plus a few
 * boxes is all a head needs.
 *
 * This component is lazy-loaded, and it degrades to the 2D avatar when the
 * browser cannot give it a canvas or the user asks for reduced motion. Nobody
 * is left without a face.
 */

function buildHead(seed: string): Mesh {
  const t = traitsFor(seed);
  const parts: Mesh[] = [];

  // Skull: an oval sphere, squashed on z so the face has a front.
  const head = scaleMesh(sphere(20, 14, t.skin), 0.86, 1.0, 0.82);
  parts.push(head);

  // Hair: a slightly larger cap, clipped to the top by only adding the upper
  // rings. Cheaper and cleaner than a boolean.
  if (t.hairStyle !== 0) {
    const hair = scaleMesh(sphere(20, 14, t.hairColor), 0.9, 1.04, 0.86, [0, 0.06, 0]);
    hair.faces = hair.faces.filter((f) => {
      const y = f.idx.reduce((s, i) => s + hair.verts[i]![1], 0) / f.idx.length;
      // A wrap or afro covers more; a crop sits higher.
      const cut = t.hairStyle === 1 ? -0.35 : t.hairStyle === 5 ? -0.25 : 0.12;
      return y > cut;
    });
    parts.push(hair);
  }

  // Neck and shoulders, so the head is not floating.
  const neck = scaleMesh(sphere(12, 8, t.skinShade), 0.34, 0.34, 0.34, [0, -0.95, 0]);
  const shoulders = scaleMesh(sphere(16, 10, t.clothes), 1.15, 0.62, 0.7, [0, -1.6, 0]);
  parts.push(neck, shoulders);

  // Eyes: two small spheres set into the face, which read from any angle.
  const eyeL = scaleMesh(sphere(10, 8, "#ffffff"), 0.13, 0.13, 0.1, [-0.3, 0.12, 0.72]);
  const eyeR = scaleMesh(sphere(10, 8, "#ffffff"), 0.13, 0.13, 0.1, [0.3, 0.12, 0.72]);
  const pupilL = scaleMesh(sphere(8, 6, "#241c17"), 0.06, 0.06, 0.05, [-0.3, 0.12, 0.82]);
  const pupilR = scaleMesh(sphere(8, 6, "#241c17"), 0.06, 0.06, 0.05, [0.3, 0.12, 0.82]);
  parts.push(eyeL, eyeR, pupilL, pupilR);

  // A mouth: a small dark wedge, placed by expression.
  const mouthY = t.expression === 3 ? -0.42 : -0.36;
  const mouth = scaleMesh(sphere(10, 6, "#8a3b34"), 0.16, t.expression === 1 ? 0.09 : 0.04, 0.08, [0, mouthY, 0.78]);
  parts.push(mouth);

  if (t.accessory === 1) {
    const glassL = scaleMesh(sphere(10, 8, "#2b2b2b"), 0.19, 0.19, 0.05, [-0.3, 0.12, 0.86]);
    const glassR = scaleMesh(sphere(10, 8, "#2b2b2b"), 0.19, 0.19, 0.05, [0.3, 0.12, 0.86]);
    glassL.faces = glassL.faces.filter((f) => f.idx.some((i) => glassL.verts[i]![2] < 0.9));
    glassR.faces = glassR.faces.filter((f) => f.idx.some((i) => glassR.verts[i]![2] < 0.9));
    parts.push(glassL, glassR);
  } else if (t.accessory === 3) {
    const cap = scaleMesh(sphere(20, 14, t.clothes), 0.92, 1.06, 0.88, [0, 0.1, 0]);
    cap.faces = cap.faces.filter((f) => {
      const y = f.idx.reduce((s, i) => s + cap.verts[i]![1], 0) / f.idx.length;
      return y > 0.2;
    });
    parts.push(cap);
  }

  return mergeMeshes(...parts);
}

export function Avatar3D({
  seed,
  size = 160,
  className,
  title,
}: {
  seed: string;
  size?: number;
  className?: string;
  title?: string;
}): JSX.Element {
  const mesh = useMemo(() => buildHead(seed), [seed]);
  const t = traitsFor(seed);
  const [yaw, setYaw] = useState(0.35);
  const [pitch, setPitch] = useState(-0.05);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
  }, []);

  // A slow idle turn, unless the user asked for reduced motion or is dragging.
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let lastT = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastT) / 1000;
      lastT = now;
      if (!dragging.current) setYaw((y) => y + dt * 0.5);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const faces = renderMesh(mesh, yaw, pitch, { fov: 0.9, width: size, height: size });

  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setYaw((y) => y + (e.clientX - last.current.x) * 0.01);
    setPitch((p) => Math.max(-0.6, Math.min(0.6, p + (e.clientY - last.current.y) * 0.006)));
    last.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = () => {
    dragging.current = false;
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: "block", touchAction: "none", cursor: "grab", borderRadius: "50%" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <defs>
        <radialGradient id={`a3d-bg-${seed.replace(/[^a-zA-Z0-9]/g, "")}`} cx="0.5" cy="0.35" r="0.75">
          <stop offset="0" stopColor={shade(t.background, 0.35)} />
          <stop offset="1" stopColor={t.background} />
        </radialGradient>
        <clipPath id={`a3d-clip-${seed.replace(/[^a-zA-Z0-9]/g, "")}`}>
          <circle cx={size / 2} cy={size / 2} r={size / 2} />
        </clipPath>
      </defs>
      <g clipPath={`url(#a3d-clip-${seed.replace(/[^a-zA-Z0-9]/g, "")})`}>
        <rect width={size} height={size} fill={`url(#a3d-bg-${seed.replace(/[^a-zA-Z0-9]/g, "")})`} />
        {faces.map((f, i) => (
          <polygon key={i} points={f.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} fill={f.fill} />
        ))}
      </g>
    </svg>
  );
}

/** Shared with the editor so a preview can reuse the exact mesh. */
export type { Mesh, Vec3 };
