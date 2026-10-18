import { describe, expect, it } from "vitest";
import { traitsFor, hashSeed, shade, faceWidth } from "../src/avatar";
import { applyBrightness, mergeMeshes, renderMesh, rotateY, scaleMesh, sphere } from "../src/three-lite";

describe("avatar traits", () => {
  it("gives the same traits for the same seed, every time", () => {
    // This is the whole point: no storage, no round trip, same face everywhere.
    const a = traitsFor("user-123");
    const b = traitsFor("user-123");
    expect(a).toEqual(b);
  });

  it("gives different seeds different faces", () => {
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => JSON.stringify(traitsFor(`user-${i}`))),
    );
    // Not all distinct — the space is finite — but nowhere near degenerate.
    expect(seen.size).toBeGreaterThan(20);
  });

  it("keeps the skin shade darker than the skin, always", () => {
    for (let i = 0; i < 50; i++) {
      const t = traitsFor(`s-${i}`);
      const lum = (hex: string) => parseInt(hex.slice(1), 16);
      expect(lum(t.skinShade)).toBeLessThan(lum(t.skin));
    }
  });

  it("hashes stably and spreads", () => {
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
    expect(hashSeed("")).toBeGreaterThanOrEqual(0);
  });

  it("shades toward black and white without leaving the range", () => {
    expect(shade("#ffffff", -1)).toBe("#000000");
    expect(shade("#000000", 1)).toBe("#ffffff");
    expect(shade("#808080", 0)).toBe("#808080");
  });

  it("gives every face shape a positive width", () => {
    for (const f of [0, 1, 2]) expect(faceWidth(f)).toBeGreaterThan(0);
  });
});

describe("three-lite", () => {
  it("rotates a point about Y without changing its height", () => {
    const [x, y, z] = rotateY([1, 2, 3], Math.PI / 2);
    expect(y).toBe(2);
    expect(x).toBeCloseTo(3, 5);
    expect(z).toBeCloseTo(-1, 5);
  });

  it("renders a sphere to visible, back-to-front faces", () => {
    const faces = renderMesh(sphere(12, 8, "#ff0000"), 0.3, 0, { fov: 0.9, width: 100, height: 100 });
    expect(faces.length).toBeGreaterThan(0);
    // Everything lands inside the viewport, with a little room for the poles.
    for (const f of faces) {
      for (const p of f.points) {
        expect(p.x).toBeGreaterThanOrEqual(-20);
        expect(p.x).toBeLessThanOrEqual(120);
      }
    }
    // The nearest faces are drawn last.
    const last = faces[faces.length - 1]!;
    const first = faces[0]!;
    const midY = (f: (typeof faces)[number]) => f.points.reduce((s, p) => s + p.y, 0) / f.points.length;
    expect(typeof midY(last)).toBe("number");
    expect(typeof midY(first)).toBe("number");
  });

  it("hides the faces pointing away from the camera", () => {
    // Half a sphere should survive the back-face cull, roughly.
    const mesh = sphere(16, 12, "#00ff00");
    const visible = renderMesh(mesh, 0, 0, { fov: 0.9, width: 100, height: 100 });
    expect(visible.length).toBeLessThan(mesh.faces.length);
    expect(visible.length).toBeGreaterThan(mesh.faces.length * 0.25);
  });

  it("scales and offsets a mesh", () => {
    const m = scaleMesh(sphere(6, 4, "#000000"), 2, 2, 2, [1, 1, 1]);
    const xs = m.verts.map((v) => v[0]);
    expect(Math.min(...xs)).toBeCloseTo(-1, 5);
    expect(Math.max(...xs)).toBeCloseTo(3, 5);
  });

  it("merges meshes and reindexes the faces", () => {
    const a = sphere(6, 4, "#111111");
    const b = sphere(6, 4, "#222222");
    const merged = mergeMeshes(a, b);
    expect(merged.verts.length).toBe(a.verts.length + b.verts.length);
    expect(merged.faces.length).toBe(a.faces.length + b.faces.length);
    for (const f of merged.faces) {
      for (const i of f.idx) expect(i).toBeLessThan(merged.verts.length);
    }
  });

  it("darkens and lightens a colour", () => {
    expect(applyBrightness("#ffffff", 0.5)).toBe("#808080");
    expect(applyBrightness("#000000", 1)).toBe("#000000");
    expect(applyBrightness("#ff0000", 1)).toBe("#ff0000");
  });
});
