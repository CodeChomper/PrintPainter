import { describe, expect, it } from 'vitest';
import { buildAtlas, RASTER_REACH, type PaintAtlas } from '@/core/atlas';
import { cutMesh, type CutMesh } from '@/core/export/cut';
import type { IndexedMesh } from '@/core/mesh';
import { closestOnTriangle, createMaps, triPages } from '@/core/paint';
import { readFileSync } from 'node:fs';
import { readProject } from '@/io/project/ppaint';
import { box, plane, uvSphere } from './meshes';

type Fn = (x: number, y: number, z: number) => number;

/** Paints every covered texel with fn(surface point), like a perfect brush. */
function paintBy(atlas: PaintAtlas, fn: Fn): Uint8Array[] {
  const maps = createMaps(atlas);
  const pageOf = triPages(atlas);
  const I = atlas.indices, U = atlas.uvs, X = atlas.positions;
  for (let t = 0; t < I.length / 3; t++) {
    const ia = I[t * 3]!, ib = I[t * 3 + 1]!, ic = I[t * 3 + 2]!;
    const ua = U[ia * 2]!, va = U[ia * 2 + 1]!, ub = U[ib * 2]!, vb = U[ib * 2 + 1]!, uc = U[ic * 2]!, vc = U[ic * 2 + 1]!;
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    if (Math.abs(det) < 1e-12) continue;
    const page = atlas.pages[pageOf[t]!]!;
    const map = maps[pageOf[t]!]!;
    const x0 = Math.max(0, Math.ceil(Math.min(ua, ub, uc) - RASTER_REACH - 0.5));
    const x1 = Math.min(page.width - 1, Math.floor(Math.max(ua, ub, uc) + RASTER_REACH - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(va, vb, vc) - RASTER_REACH - 0.5));
    const y1 = Math.min(page.height - 1, Math.floor(Math.max(va, vb, vc) + RASTER_REACH - 0.5));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let su = x + 0.5, sv = y + 0.5;
        let lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) / det;
        let lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) / det;
        if (lb < 0 || lc < 0 || lb + lc > 1) {
          const q = closestOnTriangle(su, sv, ua, va, ub, vb, uc, vc);
          if ((q[0] - su) ** 2 + (q[1] - sv) ** 2 > RASTER_REACH ** 2) continue;
          su = q[0];
          sv = q[1];
          lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) / det;
          lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) / det;
        }
        const p = (k: number) => X[ia * 3 + k]! + lb * (X[ib * 3 + k]! - X[ia * 3 + k]!) + lc * (X[ic * 3 + k]! - X[ia * 3 + k]!);
        map[y * page.width + x] = fn(p(0), p(1), p(2));
      }
    }
  }
  return maps;
}

/** Area per slot of the cut mesh. */
function slotAreas(c: CutMesh): number[] {
  const out = new Array<number>(17).fill(0);
  const P = c.positions, I = c.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, d = I[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[d]! - P[a]!, vy = P[d + 1]! - P[a + 1]!, vz = P[d + 2]! - P[a + 2]!;
    out[c.slots[t]!]! += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return out;
}

/** Reference area per slot: each source triangle split into n² pieces, sampled at their centroids. */
function referenceAreas(mesh: IndexedMesh, fn: Fn, n = 200): number[] {
  const out = new Array<number>(17).fill(0);
  const P = mesh.positions, I = mesh.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const A = [0, 1, 2].map((k) => P[I[t * 3]! * 3 + k]!);
    const B = [0, 1, 2].map((k) => P[I[t * 3 + 1]! * 3 + k]!);
    const C = [0, 1, 2].map((k) => P[I[t * 3 + 2]! * 3 + k]!);
    const u = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!], v = [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!];
    const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    const piece = area / (n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        // Upward piece, and the downward one beside it.
        for (const [a, b] of [[i + 1 / 3, j + 1 / 3], [i + 2 / 3, j + 2 / 3]] as const) {
          if (a + b > n) continue;
          const s = a / n, r = b / n;
          out[fn(A[0]! + s * u[0]! + r * v[0]!, A[1]! + s * u[1]! + r * v[1]!, A[2]! + s * u[2]! + r * v[2]!)]! += piece;
        }
      }
    }
  }
  return out;
}

function run(mesh: IndexedMesh, fn: Fn, smoothMm = 0.05, texel = 0.1) {
  const atlas = buildAtlas(mesh, { texelSize: texel });
  const maps = paintBy(atlas, fn);
  const c = cutMesh(mesh, atlas, maps, { smoothMm, texelMm: texel });
  return { c, areas: slotAreas(c), ref: referenceAreas(mesh, fn) };
}

describe('cutMesh', () => {
  it('cuts long sliver triangles without falling back (coincident curve points)', () => {
    // Painted in the app: a cylinder with a line and a spiky lasso shape on its side.
    // Its 30 mm tall side triangles used to collect duplicate curve points.
    const p = readProject(new Uint8Array(readFileSync(new URL('../fixtures/cylinder-line-lasso.ppaint', import.meta.url))));
    const o = p.objects[0]!;
    const c = cutMesh(o.mesh, o.paint!.atlas, o.paint!.maps, { smoothMm: 0.05, texelMm: o.paint!.texelMm });
    expect(c.stats.fallbacks).toBe(0);
    expect(c.stats.degenerate).toBe(0);
    expect(c.stats.watertight).toBe(true);
  });

  it('leaves an unpainted mesh as it is', () => {
    const m = box(20);
    const { c } = run(m, () => 0);
    expect(c.stats.triangles).toBe(12);
    expect(c.stats.cutTriangles).toBe(0);
    expect(c.stats.watertight).toBe(true);
    expect([...c.slots].every((s) => s === 1)).toBe(true);
  });

  it('cuts a painted disc out of a plane with the right area', () => {
    const m = plane(20, 20, 1);
    const fn: Fn = (x, y) => ((x - 10) ** 2 + (y - 10) ** 2 < 25 ? 2 : 1);
    const { c, areas } = run(m, fn);
    expect(c.stats.fallbacks).toBe(0);
    expect(c.stats.degenerate).toBe(0);
    expect(areas[2]).toBeCloseTo(Math.PI * 25, 0);
    expect(areas[1]! + areas[2]!).toBeCloseTo(400, 6);
  });

  it('stays watertight when boundaries cross chart seams (box corner)', () => {
    const m = box(20);
    const fn: Fn = (x, y, z) => ((x - 20) ** 2 + (y - 20) ** 2 + (z - 20) ** 2 < 64 ? 3 : 1);
    const { c, areas } = run(m, fn);
    expect(c.stats.sourceWatertight).toBe(true);
    expect(c.stats.watertight).toBe(true);
    expect(c.stats.fallbacks).toBe(0);
    expect(c.stats.degenerate).toBe(0);
    // Three quarter discs of radius 8.
    expect(Math.abs(areas[3]! - 48 * Math.PI) / (48 * Math.PI)).toBeLessThan(0.01);
  });

  it('handles three-slot junctions on a curved mesh', () => {
    const m = uvSphere(10, 32, 16);
    const fn: Fn = (x, _y, z) => (z > 3 ? (x > 2 ? 4 : 2) : x < -4 ? 5 : 1);
    const { c, areas, ref } = run(m, fn);
    expect(c.stats.watertight).toBe(true);
    expect(c.stats.fallbacks).toBe(0);
    expect(c.stats.degenerate).toBe(0);
    for (const s of [1, 2, 4, 5]) expect(Math.abs(areas[s]! - ref[s]!) / ref[s]!).toBeLessThan(0.01);
  });

  it('cuts without smoothing too (texel outline)', () => {
    const m = box(20);
    const fn: Fn = (x, y) => ((x - 10) ** 2 + (y - 10) ** 2 < 36 ? 2 : 1);
    const { c, areas, ref } = run(m, fn, 0);
    expect(c.stats.watertight).toBe(true);
    expect(c.stats.fallbacks).toBe(0);
    expect(Math.abs(areas[2]! - ref[2]!) / ref[2]!).toBeLessThan(0.02);
  });

  it('smoothing straightens a texel staircase', () => {
    // A slanted straight boundary: with smoothing, every boundary vertex lies close to the true line.
    const m = plane(20, 20, 1);
    const line = (x: number, y: number) => y - 0.37 * x - 4.1;
    const fn: Fn = (x, y) => (line(x, y) > 0 ? 2 : 1);
    const { c } = run(m, fn, 0.05);
    const P = c.positions;
    let worst = 0;
    for (let v = 0; v < P.length / 3; v++) {
      const d = Math.abs(line(P[v * 3]!, P[v * 3 + 1]!)) / Math.hypot(1, 0.37);
      if (d < 1) worst = Math.max(worst, d); // boundary vertices (corners are far away)
    }
    expect(worst).toBeLessThan(0.07);
  });
});
