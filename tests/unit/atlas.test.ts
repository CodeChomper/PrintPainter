import { describe, expect, it } from 'vitest';
import { buildAtlas, chooseTexelMm, RASTER_REACH, surfaceArea, type PaintAtlas } from '@/core/atlas';
import type { IndexedMesh } from '@/core/mesh';
import { box, plane, spiralRamp, uvSphere } from './meshes';

/** Charts = connected components of the paint mesh (vertices are split along chart seams). */
function chartIds(a: PaintAtlas): Int32Array {
  const T = a.indices.length / 3;
  const parent = Int32Array.from({ length: a.positions.length / 3 }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (let t = 0; t < T; t++) {
    const r0 = find(a.indices[t * 3]!);
    parent[find(a.indices[t * 3 + 1]!)] = r0;
    parent[find(a.indices[t * 3 + 2]!)] = r0;
  }
  return Int32Array.from({ length: T }, (_, t) => find(a.indices[t * 3]!));
}

function pageOfTri(a: PaintAtlas, t: number): number {
  return a.pages.findIndex((p) => t >= p.triStart && t < p.triStart + p.triCount);
}

/**
 * Checks the atlas invariants: triangles don't overlap (strict texel-centre coverage)
 * and no texel is within paint reach of two different charts.
 */
function checkNoOverlap(a: PaintAtlas): void {
  const charts = chartIds(a);
  const owner = a.pages.map((p) => new Int32Array(p.width * p.height).fill(-1));
  const strict = a.pages.map((p) => new Uint8Array(p.width * p.height));
  const U = a.uvs, I = a.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const pg = pageOfTri(a, t);
    const { width: W, height: H } = a.pages[pg]!;
    const xs = [0, 1, 2].map((k) => U[I[t * 3 + k]! * 2]!);
    const ys = [0, 1, 2].map((k) => U[I[t * 3 + k]! * 2 + 1]!);
    for (const x of xs) expect(x >= 0 && x <= W).toBe(true);
    for (const y of ys) expect(y >= 0 && y <= H).toBe(true);
    const [x0, x1, x2] = xs as [number, number, number];
    const [y0, y1, y2] = ys as [number, number, number];
    const e = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    for (let ty = Math.max(0, Math.floor(Math.min(...ys)) - 1); ty <= Math.min(H - 1, Math.ceil(Math.max(...ys)) + 1); ty++) {
      for (let tx = Math.max(0, Math.floor(Math.min(...xs)) - 1); tx <= Math.min(W - 1, Math.ceil(Math.max(...xs)) + 1); tx++) {
        const cx = tx + 0.5, cy = ty + 0.5;
        const inside = e(x0, y0, x1, y1, cx, cy) > 0 && e(x1, y1, x2, y2, cx, cy) > 0 && e(x2, y2, x0, y0, cx, cy) > 0;
        if (inside) {
          expect(strict[pg]![ty * W + tx]).toBe(0);
          strict[pg]![ty * W + tx] = 1;
        }
        // Distance from the texel centre to the triangle.
        const d = inside ? 0 : Math.min(segDist(cx, cy, x0, y0, x1, y1), segDist(cx, cy, x1, y1, x2, y2), segDist(cx, cy, x2, y2, x0, y0));
        if (d <= RASTER_REACH) {
          const o = owner[pg]!;
          if (o[ty * W + tx] === -1) o[ty * W + tx] = charts[t]!;
          else expect(o[ty * W + tx]).toBe(charts[t]!);
        }
      }
    }
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay;
  const l2 = ex * ex + ey * ey;
  const s = l2 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
  return Math.hypot(ax + s * ex - px, ay + s * ey - py);
}

/** UV area / (3D area / texel²) for every triangle. */
function densities(a: PaintAtlas): number[] {
  const out: number[] = [];
  const P = a.positions, U = a.uvs, I = a.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const [i, j, k] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
    const uvArea = ((U[j * 2]! - U[i * 2]!) * (U[k * 2 + 1]! - U[i * 2 + 1]!) - (U[k * 2]! - U[i * 2]!) * (U[j * 2 + 1]! - U[i * 2 + 1]!)) / 2;
    const ex = [0, 1, 2].map((c) => P[j * 3 + c]! - P[i * 3 + c]!);
    const fx = [0, 1, 2].map((c) => P[k * 3 + c]! - P[i * 3 + c]!);
    const cr = [ex[1]! * fx[2]! - ex[2]! * fx[1]!, ex[2]! * fx[0]! - ex[0]! * fx[2]!, ex[0]! * fx[1]! - ex[1]! * fx[0]!];
    const area = Math.hypot(...cr) / 2 / (a.texelSize * a.texelSize);
    if (area > 1e-6) out.push(uvArea / area);
  }
  return out;
}

function checkMapping(mesh: IndexedMesh, a: PaintAtlas): void {
  const T = mesh.indices.length / 3;
  expect(a.indices.length).toBe(mesh.indices.length);
  expect([...a.triSource].sort((x, y) => x - y)).toEqual(Array.from({ length: T }, (_, i) => i));
  // Corner k of a paint triangle is corner k of its source triangle.
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      expect(a.xref[a.indices[t * 3 + k]!]).toBe(mesh.indices[a.triSource[t]! * 3 + k]);
    }
  }
  for (let v = 0; v < a.xref.length; v++) {
    for (let c = 0; c < 3; c++) expect(a.positions[v * 3 + c]).toBe(mesh.positions[a.xref[v]! * 3 + c]);
  }
  expect(a.pages.reduce((n, p) => n + p.triCount, 0)).toBe(T);
}

describe('buildAtlas', () => {
  it('gives a cube one chart per face at full density', () => {
    const mesh = box(20);
    const a = buildAtlas(mesh, { texelSize: 0.1 });
    expect(a.charts).toBe(6);
    expect(a.pages).toHaveLength(1);
    checkMapping(mesh, a);
    checkNoOverlap(a);
    for (const d of densities(a)) expect(d).toBeCloseTo(1, 5);
    // Six 200 × 200 texel faces plus padding fit a page well under 8192.
    expect(a.pages[0]!.width * a.pages[0]!.height).toBeLessThan(6 * 204 * 204 * 1.6);
  });

  it('keeps sphere charts within the angle limit (density ≥ cos 45°)', () => {
    const mesh = uvSphere(10, 48, 24);
    const a = buildAtlas(mesh, { texelSize: 0.1 });
    checkMapping(mesh, a);
    checkNoOverlap(a);
    expect(a.charts).toBeGreaterThan(6);
    for (const d of densities(a)) {
      expect(d).toBeGreaterThan(Math.cos(Math.PI / 4) - 1e-3);
      expect(d).toBeLessThan(1 + 1e-4);
    }
  });

  it('splits a chart that folds over itself (spiral ramp)', () => {
    const mesh = spiralRamp(2.5);
    const a = buildAtlas(mesh, { texelSize: 0.1 });
    expect(a.charts).toBeGreaterThan(1);
    checkMapping(mesh, a);
    checkNoOverlap(a);
  });

  it('spreads over several pages when one is too small, grouped by page', () => {
    const mesh = plane(30, 30, 6);
    // 300 × 300 texels of surface, pages of 128.
    const a = buildAtlas(mesh, { texelSize: 0.1, maxPageSize: 128 });
    expect(a.pages.length).toBeGreaterThan(1);
    for (const p of a.pages) {
      expect(p.width).toBeLessThanOrEqual(128);
      expect(p.height).toBeLessThanOrEqual(128);
    }
    let next = 0;
    for (const p of a.pages) {
      expect(p.triStart).toBe(next);
      next += p.triCount;
    }
    checkMapping(mesh, a);
    checkNoOverlap(a);
  });

  it('keeps STEP face IDs with their triangles', () => {
    const mesh = box(10);
    mesh.faceIds = Int32Array.from({ length: 12 }, (_, t) => Math.floor(t / 2));
    const a = buildAtlas(mesh, { texelSize: 0.5 });
    for (let t = 0; t < 12; t++) expect(a.faceIds![t]).toBe(Math.floor(a.triSource[t]! / 2));
  });

  it('throws if a single triangle cannot fit a page', () => {
    expect(() => buildAtlas(plane(100, 100), { texelSize: 0.1, maxPageSize: 256 })).toThrow(/coarser/);
  });
});

describe('chooseTexelMm', () => {
  it('keeps 0.1 mm for printable sizes and coarsens huge surfaces', () => {
    expect(chooseTexelMm(surfaceArea(box(200)))).toBe(0.1);
    expect(chooseTexelMm(surfaceArea(box(2000)))).toBeGreaterThan(0.1);
  });
});
