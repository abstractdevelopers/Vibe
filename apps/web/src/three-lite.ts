/**
 * three-lite — a very small software 3D renderer.
 *
 * The app has a hard bundle budget (120 kB gzipped for the main chunk), and a
 * full 3D library is several times that on its own. Avatars need rotation and
 * shading, not a scene graph, so this does the minimum: a mesh of triangles and
 * quads, a rotation, a perspective projection, a painter's-algorithm sort, and
 * flat shading from one light. That is a couple of kilobytes and it is pure
 * arithmetic, which means the interesting parts are testable without a canvas.
 *
 * It is not a general renderer and should not grow into one. If the app ever
 * needs real 3D scenes, replace this with a library and drop it into its own
 * lazy chunk.
 */

export type Vec3 = [number, number, number];

export interface Face {
  /** Indices into the mesh's vertex list, in winding order. */
  idx: number[];
  /** Base colour, as #rrggbb. */
  color: string;
}

export interface Mesh {
  verts: Vec3[];
  faces: Face[];
}

export interface Camera {
  /** Field of view in radians. */
  fov: number;
  width: number;
  height: number;
}

export interface RenderedFace {
  /** Projected polygon points, in draw order. */
  points: Array<{ x: number; y: number }>;
  fill: string;
}

const LIGHT: Vec3 = [-0.4, -0.6, 0.7];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function rotateY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

export function rotateX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

/**
 * Rotate a mesh, project it, and return the faces back-to-front.
 *
 * Depth is the average of a face's vertices after rotation; sorting on it and
 * drawing in order is the painter's algorithm. It is not correct for
 * self-intersecting geometry, which an avatar is not, and it needs no z-buffer.
 */
export function renderMesh(mesh: Mesh, yaw: number, pitch: number, cam: Camera): RenderedFace[] {
  const f = cam.height / (2 * Math.tan(cam.fov / 2));
  const light = normalize(LIGHT);
  const cx = cam.width / 2;
  const cy = cam.height / 2;
  // Pull the model back so it sits inside the frustum.
  const dist = 3.4;

  const rotated = mesh.verts.map((v) => rotateX(rotateY(v, yaw), pitch));

  const out: Array<RenderedFace & { depth: number }> = [];
  for (const face of mesh.faces) {
    const pts = face.idx.map((i) => rotated[i]!);
    const z = pts.reduce((s, p) => s + p[2], 0) / pts.length;
    const depth = dist + z;
    if (depth <= 0.1) continue;

    // A face pointing away from the camera cannot be seen. The winding tells
    // us: if the normal faces backwards, skip it.
    const a = pts[0]!, b = pts[1]!, c = pts[2]!;
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = normalize([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
    // The camera looks down -z, so a visible face has its normal pointing +z.
    const facing = n[2];
    if (facing <= 0.02) continue;

    const lambert = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    const brightness = 0.55 + 0.45 * lambert;

    out.push({
      depth,
      points: pts.map((p) => ({ x: cx + (p[0] * f) / depth, y: cy + (p[1] * f) / depth })),
      fill: applyBrightness(face.color, brightness),
    });
  }

  // Painter's algorithm: far faces first.
  out.sort((x, y) => y.depth - x.depth);
  return out.map(({ points, fill }) => ({ points, fill }));
}

/** Multiply a hex colour by a brightness in [0,1]. */
export function applyBrightness(hex: string, brightness: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(c * brightness))),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** A UV sphere, radius 1, centred at the origin. */
export function sphere(segments: number, rings: number, color: string): Mesh {
  const verts: Vec3[] = [];
  const faces: Face[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      verts.push([
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ]);
    }
  }
  const at = (r: number, s: number) => r * (segments + 1) + s;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      faces.push({ idx: [at(r, s), at(r + 1, s), at(r + 1, s + 1), at(r, s + 1)], color });
    }
  }
  return { verts, faces };
}

/** Scale a mesh in place-safe fashion (returns a new mesh). */
export function scaleMesh(mesh: Mesh, sx: number, sy: number, sz: number, offset: Vec3 = [0, 0, 0]): Mesh {
  return {
    verts: mesh.verts.map((v) => [v[0] * sx + offset[0], v[1] * sy + offset[1], v[2] * sz + offset[2]] as Vec3),
    faces: mesh.faces,
  };
}

export function mergeMeshes(...meshes: Mesh[]): Mesh {
  const verts: Vec3[] = [];
  const faces: Face[] = [];
  for (const m of meshes) {
    const base = verts.length;
    verts.push(...m.verts);
    for (const f of m.faces) faces.push({ idx: f.idx.map((i) => i + base), color: f.color });
  }
  return { verts, faces };
}
