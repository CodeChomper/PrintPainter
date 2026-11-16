import { describe, expect, it } from 'vitest';
import { buildAtlas, type PaintAtlas } from '@/core/atlas';
import { buildTopology, fillTriangles, growRegion, paintWhere } from '@/core/fill';
import { createMaps, PaintRecorder, triPages } from '@/core/paint';
import { box, uvSphere } from './meshes';

/** Paint triangles whose face normal is closest to `axis`. */
function facing(atlas: PaintAtlas, axis: [number, number, number]): number[] {
  const topo = buildTopology(atlas);
  const out: number[] = [];
  for (let t = 0; t < atlas.indices.length / 3; t++) {
    const d = topo.normals[t * 3]! * axis[0] + topo.normals[t * 3 + 1]! * axis[1] + topo.normals[t * 3 + 2]! * axis[2];
    if (d > 0.99) out.push(t);
  }
  return out;
}

/** For each texel whose centre is inside a triangle: that triangle (else -1). */
function owners(atlas: PaintAtlas, page: number): Int32Array {
  const { width: W, height: H, triStart, triCount } = atlas.pages[page]!;
  const own = new Int32Array(W * H).fill(-1);
  const I = atlas.indices, U = atlas.uvs;
  for (let t = triStart; t < triStart + triCount; t++) {
    const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
    const [ua, va, ub, vb, uc, vc] = [U[a * 2]!, U[a * 2 + 1]!, U[b * 2]!, U[b * 2 + 1]!, U[c * 2]!, U[c * 2 + 1]!];
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const lb = ((x + 0.5 - ua) * (vc - va) - (uc - ua) * (y + 0.5 - va)) / det;
        const lc = ((ub - ua) * (y + 0.5 - va) - (x + 0.5 - ua) * (vb - va)) / det;
        if (lb > 1e-6 && lc > 1e-6 && lb + lc < 1 - 1e-6) own[y * W + x] = t;
      }
    }
  }
  return own;
}

describe('growRegion', () => {
  const atlas = buildAtlas(box(10), { texelSize: 0.5 });
  const topo = buildTopology(atlas);

  it('joins every edge of a closed box, across chart seams', () => {
    expect(Array.from(topo.adjacent).every((a) => a >= 0)).toBe(true);
  });

  it('stops at the box edges in angle mode and takes everything as a whole piece', () => {
    const top = facing(atlas, [0, 0, 1]);
    expect(top).toHaveLength(2);
    const r = Array.from(growRegion(atlas, topo, top[0]!, { mode: 'angle', maxAngleDeg: 30 })).sort();
    expect(r).toEqual([...top].sort());
    expect(growRegion(atlas, topo, top[0]!, { mode: 'angle', maxAngleDeg: 90 })).toHaveLength(12);
    expect(growRegion(atlas, topo, top[0]!, { mode: 'island', maxAngleDeg: 0 })).toHaveLength(12);
  });

  it('follows STEP face ids, and falls back to angle without them', () => {
    const withFaces: PaintAtlas = { ...atlas, faceIds: Int32Array.from(atlas.triSource, (s) => (s < 6 ? 0 : 1)) };
    const r = growRegion(withFaces, topo, 0, { mode: 'face', maxAngleDeg: 30 });
    const want = withFaces.faceIds!.filter((f) => f === withFaces.faceIds![0]).length;
    expect(r).toHaveLength(want);
    expect(growRegion(atlas, topo, 0, { mode: 'face', maxAngleDeg: 30 })).toHaveLength(2);
  });

  it('spreads over a smooth sphere but not past a tight angle', () => {
    const s = buildAtlas(uvSphere(10, 32, 16), { texelSize: 0.5 });
    const st = buildTopology(s);
    const T = s.indices.length / 3;
    expect(growRegion(s, st, 0, { mode: 'angle', maxAngleDeg: 30 })).toHaveLength(T);
    expect(growRegion(s, st, 0, { mode: 'angle', maxAngleDeg: 1 }).length).toBeLessThan(T);
  });
});

describe('fillTriangles', () => {
  it('paints exactly the chosen triangles, with no spill into neighbours', () => {
    const atlas = buildAtlas(box(10), { texelSize: 0.25 });
    const maps = createMaps(atlas);
    const pageOf = triPages(atlas);
    const top = facing(atlas, [0, 0, 1]);
    const rec = new PaintRecorder(atlas, maps);
    const n = fillTriangles(atlas, maps, pageOf, rec, top, 3);
    expect(n).toBeGreaterThan(0);
    const chosen = new Set(top);
    for (let p = 0; p < atlas.pages.length; p++) {
      const own = owners(atlas, p);
      const m = maps[p]!;
      for (let i = 0; i < m.length; i++) {
        if (own[i]! < 0) continue;
        expect(m[i], `texel ${i} of triangle ${own[i]}`).toBe(chosen.has(own[i]!) ? 3 : 0);
      }
    }
    // Undo data covers it.
    const edit = rec.finish()!;
    expect(edit.tiles.length).toBeGreaterThan(0);
  });

  it('erases with value 0 and reports nothing when nothing changes', () => {
    const atlas = buildAtlas(box(10), { texelSize: 0.5 });
    const maps = createMaps(atlas);
    const pageOf = triPages(atlas);
    const all = Array.from({ length: 12 }, (_, i) => i);
    fillTriangles(atlas, maps, pageOf, new PaintRecorder(atlas, maps), all, 2);
    expect(fillTriangles(atlas, maps, pageOf, new PaintRecorder(atlas, maps), all, 2)).toBe(0);
    fillTriangles(atlas, maps, pageOf, new PaintRecorder(atlas, maps), all, 0);
    expect(maps.every((m) => m.every((v) => v === 0))).toBe(true);
  });
});

describe('paintWhere', () => {
  it('paints texels that pass the test on faces turned towards the eye', () => {
    const atlas = buildAtlas(box(10), { texelSize: 0.25 });
    const maps = createMaps(atlas);
    const pageOf = triPages(atlas);
    const all = Uint32Array.from({ length: 12 }, (_, i) => i);
    // Eye above: only the top faces; keep the half with x < 5.
    paintWhere(atlas, maps, pageOf, new PaintRecorder(atlas, maps), all, 12, 4, [5, 5, 100], (x) => x < 5);
    const top = new Set(facing(atlas, [0, 0, 1]));
    for (let p = 0; p < atlas.pages.length; p++) {
      const own = owners(atlas, p);
      const m = maps[p]!;
      const { width: W } = atlas.pages[p]!;
      for (let i = 0; i < m.length; i++) {
        const t = own[i]!;
        if (t < 0) continue;
        if (!top.has(t)) expect(m[i]).toBe(0);
        else {
          // Texel centre → surface x: interpolate from the triangle.
          const I = atlas.indices, U = atlas.uvs, P = atlas.positions;
          const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
          const cx = (i % W) + 0.5, cy = Math.floor(i / W) + 0.5;
          const [ua, va, ub, vb, uc, vc] = [U[a * 2]!, U[a * 2 + 1]!, U[b * 2]!, U[b * 2 + 1]!, U[c * 2]!, U[c * 2 + 1]!];
          const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
          const lb = ((cx - ua) * (vc - va) - (uc - ua) * (cy - va)) / det;
          const lc = ((ub - ua) * (cy - va) - (cx - ua) * (vb - va)) / det;
          const x = P[a * 3]! + lb * (P[b * 3]! - P[a * 3]!) + lc * (P[c * 3]! - P[a * 3]!);
          expect(m[i]).toBe(x < 5 ? 4 : 0);
        }
      }
    }
  });
});
