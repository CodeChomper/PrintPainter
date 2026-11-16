// Fill tools: grow a region of triangles from a clicked one (bucket fill), and paint
// texels by an arbitrary surface test (lasso).
//
// Regions are grown on the paint mesh's triangles, joined across edges through the
// source vertices (atlas.xref), so chart seams don't stop a fill. Region fills follow
// the triangle edges exactly: a texel is painted when its centre lies inside a chosen
// triangle; texels whose centre is inside a triangle that wasn't chosen are left alone,
// even near the border. Only gutter texels (centre inside no triangle) take the paint
// conservatively, so the GPU and the export tracer see clean chart edges.
//
// Pure TS, no DOM.

import { RASTER_REACH, type PaintAtlas } from './atlas';
import { closestOnTriangle, type PaintRecorder } from './paint';

export type FillMode = 'angle' | 'face' | 'island';

export interface FillTopology {
  /** Per paint triangle and edge (ab, bc, ca): the triangle across it, or -1 (open or non-manifold). */
  adjacent: Int32Array;
  /** Unit face normal per paint triangle (zero for degenerate ones). */
  normals: Float32Array;
}

/** Triangle adjacency across the whole surface, ignoring chart seams. */
export function buildTopology(atlas: PaintAtlas): FillTopology {
  const I = atlas.indices, X = atlas.xref, P = atlas.positions;
  const T = I.length / 3;
  const adjacent = new Int32Array(T * 3).fill(-1);
  // Sort half-edges by their (source) vertex pair; equal neighbours share an edge.
  const E = T * 3;
  const lo = new Uint32Array(E), hi = new Uint32Array(E);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = X[I[t * 3 + k]!]!, b = X[I[t * 3 + ((k + 1) % 3)]!]!;
      lo[t * 3 + k] = a < b ? a : b;
      hi[t * 3 + k] = a < b ? b : a;
    }
  }
  const order = new Uint32Array(E);
  for (let i = 0; i < E; i++) order[i] = i;
  order.sort((p, q) => lo[p]! - lo[q]! || hi[p]! - hi[q]!);
  for (let i = 0; i < E; ) {
    let j = i + 1;
    while (j < E && lo[order[j]!] === lo[order[i]!] && hi[order[j]!] === hi[order[i]!]) j++;
    if (j - i === 2) {
      const e0 = order[i]!, e1 = order[i + 1]!;
      adjacent[e0] = (e1 / 3) | 0;
      adjacent[e1] = (e0 / 3) | 0;
    }
    i = j;
  }

  const normals = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      normals[t * 3] = nx / len;
      normals[t * 3 + 1] = ny / len;
      normals[t * 3 + 2] = nz / len;
    }
  }
  return { adjacent, normals };
}

export interface RegionOptions {
  mode: FillMode;
  /** Angle mode: the largest bend between neighbouring triangles that a fill crosses. */
  maxAngleDeg: number;
}

/**
 * Triangles reachable from `seed` (paint triangle indices, in fill order). `seen` is
 * scratch space of one byte per triangle; pass the same one to reuse it.
 */
export function growRegion(
  atlas: PaintAtlas,
  topo: FillTopology,
  seed: number,
  opts: RegionOptions,
  seen: Uint8Array = new Uint8Array(atlas.indices.length / 3),
): Uint32Array {
  const T = atlas.indices.length / 3;
  if (seed < 0 || seed >= T) return new Uint32Array(0);
  seen.fill(0);
  const A = topo.adjacent, N = topo.normals, F = atlas.faceIds;
  const mode = opts.mode === 'face' && !F ? 'angle' : opts.mode;
  const cosMax = Math.cos((Math.min(180, Math.max(0, opts.maxAngleDeg)) * Math.PI) / 180) - 1e-6;
  const out = new Uint32Array(T);
  let n = 0;
  out[n++] = seed;
  seen[seed] = 1;
  for (let i = 0; i < n; i++) {
    const t = out[i]!;
    for (let k = 0; k < 3; k++) {
      const u = A[t * 3 + k]!;
      if (u < 0 || seen[u]) continue;
      if (mode === 'angle') {
        const d = N[t * 3]! * N[u * 3]! + N[t * 3 + 1]! * N[u * 3 + 1]! + N[t * 3 + 2]! * N[u * 3 + 2]!;
        if (d < cosMax) continue;
      } else if (mode === 'face' && F![u] !== F![t]) continue;
      seen[u] = 1;
      out[n++] = u;
    }
  }
  return out.slice(0, n);
}

/**
 * Paints whole triangles (paint triangle indices) with `value`, following their edges
 * exactly (see the file comment). Returns the number of texels changed.
 */
export function fillTriangles(
  atlas: PaintAtlas,
  maps: Uint8Array[],
  pageOf: Uint8Array,
  rec: PaintRecorder,
  tris: ArrayLike<number>,
  value: number,
): number {
  const I = atlas.indices, U = atlas.uvs;
  const T = I.length / 3;
  const chosen = new Uint8Array(T);
  for (let i = 0; i < tris.length; i++) chosen[tris[i]!] = 1;
  let changed = 0;

  atlas.pages.forEach((page, p) => {
    // Bounds of the chosen triangles on this page, with room for the gutter.
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i]!;
      if (pageOf[t] !== p) continue;
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k]!;
        const u = U[v * 2]!, w = U[v * 2 + 1]!;
        if (u < bx0) bx0 = u;
        if (u > bx1) bx1 = u;
        if (w < by0) by0 = w;
        if (w > by1) by1 = w;
      }
    }
    if (bx0 > bx1) return;
    const W = page.width, H = page.height;
    const x0 = Math.max(0, Math.floor(bx0 - RASTER_REACH - 1));
    const y0 = Math.max(0, Math.floor(by0 - RASTER_REACH - 1));
    const x1 = Math.min(W, Math.ceil(bx1 + RASTER_REACH + 1));
    const y1 = Math.min(H, Math.ceil(by1 + RASTER_REACH + 1));
    const w = x1 - x0, h = y1 - y0;
    // 0 = no triangle's centre test, 1 = inside a chosen one, 2 = inside another, 3 = chosen gutter.
    const state = new Uint8Array(w * h);

    const end = page.triStart + page.triCount;
    for (let t = page.triStart; t < end; t++) {
      const ia = I[t * 3]!, ib = I[t * 3 + 1]!, ic = I[t * 3 + 2]!;
      const ua = U[ia * 2]!, va = U[ia * 2 + 1]!, ub = U[ib * 2]!, vb = U[ib * 2 + 1]!, uc = U[ic * 2]!, vc = U[ic * 2 + 1]!;
      const tx0 = Math.max(x0, Math.ceil(Math.min(ua, ub, uc) - 0.5));
      const tx1 = Math.min(x1 - 1, Math.floor(Math.max(ua, ub, uc) - 0.5));
      const ty0 = Math.max(y0, Math.ceil(Math.min(va, vb, vc) - 0.5));
      const ty1 = Math.min(y1 - 1, Math.floor(Math.max(va, vb, vc) - 0.5));
      if (tx0 > tx1 || ty0 > ty1) continue;
      const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const mark = chosen[t] ? 1 : 2;
      for (let y = ty0; y <= ty1; y++) {
        const cy = y + 0.5;
        for (let x = tx0; x <= tx1; x++) {
          const cx = x + 0.5;
          const lb = ((cx - ua) * (vc - va) - (uc - ua) * (cy - va)) * inv;
          const lc = ((ub - ua) * (cy - va) - (cx - ua) * (vb - va)) * inv;
          if (lb < -1e-9 || lc < -1e-9 || lb + lc > 1 + 1e-9) continue;
          const s = (y - y0) * w + (x - x0);
          // A centre exactly on an edge between a chosen and another triangle goes to the chosen one.
          if (mark === 1 || state[s] === 0) state[s] = mark;
        }
      }
    }

    // Gutter texels near chosen triangles.
    const reach2 = RASTER_REACH * RASTER_REACH;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i]!;
      if (pageOf[t] !== p) continue;
      const ia = I[t * 3]!, ib = I[t * 3 + 1]!, ic = I[t * 3 + 2]!;
      const ua = U[ia * 2]!, va = U[ia * 2 + 1]!, ub = U[ib * 2]!, vb = U[ib * 2 + 1]!, uc = U[ic * 2]!, vc = U[ic * 2 + 1]!;
      const tx0 = Math.max(x0, Math.ceil(Math.min(ua, ub, uc) - RASTER_REACH - 0.5));
      const tx1 = Math.min(x1 - 1, Math.floor(Math.max(ua, ub, uc) + RASTER_REACH - 0.5));
      const ty0 = Math.max(y0, Math.ceil(Math.min(va, vb, vc) - RASTER_REACH - 0.5));
      const ty1 = Math.min(y1 - 1, Math.floor(Math.max(va, vb, vc) + RASTER_REACH - 0.5));
      for (let y = ty0; y <= ty1; y++) {
        for (let x = tx0; x <= tx1; x++) {
          const s = (y - y0) * w + (x - x0);
          if (state[s] !== 0) continue;
          const q = closestOnTriangle(x + 0.5, y + 0.5, ua, va, ub, vb, uc, vc);
          if ((q[0] - x - 0.5) ** 2 + (q[1] - y - 0.5) ** 2 <= reach2) state[s] = 3;
        }
      }
    }

    const map = maps[p]!;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = state[y * w + x]!;
        if (s !== 1 && s !== 3) continue;
        const idx = (y + y0) * W + (x + x0);
        if (map[idx] === value) continue;
        rec.touch(p, x + x0, y + y0);
        map[idx] = value;
        changed++;
      }
    }
  });
  return changed;
}

/**
 * Paints every texel of the given triangles whose surface point passes `keep`
 * (lasso: inside the shape on screen and visible). With `eye`, only triangles facing it
 * are painted. Conservative like the brush. Returns the number of texels changed.
 */
export function paintWhere(
  atlas: PaintAtlas,
  maps: Uint8Array[],
  pageOf: Uint8Array,
  rec: PaintRecorder,
  tris: ArrayLike<number>,
  count: number,
  value: number,
  eye: [number, number, number] | null,
  keep: (x: number, y: number, z: number) => boolean,
): number {
  const I = atlas.indices, X = atlas.positions, U = atlas.uvs;
  const reach2 = RASTER_REACH * RASTER_REACH;
  let changed = 0;
  for (let n = 0; n < count; n++) {
    const t = tris[n]!;
    const ia = I[t * 3]!, ib = I[t * 3 + 1]!, ic = I[t * 3 + 2]!;
    const pax = X[ia * 3]!, pay = X[ia * 3 + 1]!, paz = X[ia * 3 + 2]!;
    const e1x = X[ib * 3]! - pax, e1y = X[ib * 3 + 1]! - pay, e1z = X[ib * 3 + 2]! - paz;
    const e2x = X[ic * 3]! - pax, e2y = X[ic * 3 + 1]! - pay, e2z = X[ic * 3 + 2]! - paz;
    if (eye) {
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (nx * (pax - eye[0]) + ny * (pay - eye[1]) + nz * (paz - eye[2]) >= 0) continue;
    }
    const ua = U[ia * 2]!, va = U[ia * 2 + 1]!, ub = U[ib * 2]!, vb = U[ib * 2 + 1]!, uc = U[ic * 2]!, vc = U[ic * 2 + 1]!;
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const page = pageOf[t]!;
    const W = atlas.pages[page]!.width, H = atlas.pages[page]!.height;
    const map = maps[page]!;
    const x0 = Math.max(0, Math.ceil(Math.min(ua, ub, uc) - RASTER_REACH - 0.5));
    const x1 = Math.min(W - 1, Math.floor(Math.max(ua, ub, uc) + RASTER_REACH - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(va, vb, vc) - RASTER_REACH - 0.5));
    const y1 = Math.min(H - 1, Math.floor(Math.max(va, vb, vc) + RASTER_REACH - 0.5));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const idx = y * W + x;
        if (map[idx] === value) continue;
        const cx = x + 0.5;
        let su = cx, sv = cy;
        let lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) * inv;
        let lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) * inv;
        if (lb < 0 || lc < 0 || lb + lc > 1) {
          const q = closestOnTriangle(cx, cy, ua, va, ub, vb, uc, vc);
          if ((q[0] - cx) ** 2 + (q[1] - cy) ** 2 > reach2) continue;
          su = q[0];
          sv = q[1];
          lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) * inv;
          lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) * inv;
        }
        if (!keep(pax + lb * e1x + lc * e2x, pay + lb * e1y + lc * e2y, paz + lb * e1z + lc * e2z)) continue;
        rec.touch(page, x, y);
        map[idx] = value;
        changed++;
      }
    }
  }
  return changed;
}
