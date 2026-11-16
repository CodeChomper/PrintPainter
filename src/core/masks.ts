// Procedural layer masks, evaluated once per texel of an object's paint atlas into
// 0/1 maps (one byte per texel, one array per atlas page).
//
// Every mask works on the true surface point of each texel. Texels whose centre lies
// inside a triangle take that triangle's value; gutter texels (centre inside no
// triangle) take the value at the nearest point of a nearby triangle, like the brush,
// so the GPU and the export tracer see clean chart edges. Masks that are constant over
// a whole triangle (facing angle) follow the triangle edges exactly, as fills do.
//
// Coordinates are the atlas's source units; `SurfaceInfo` converts to mm.
//
// Pure TS, no DOM.

import { RASTER_REACH, type PaintAtlas } from './atlas';
import type { FillTopology } from './fill';
import { closestOnTriangle } from './paint';

export type Vec3 = [number, number, number];

export interface SurfaceInfo {
  /** mm per source unit. */
  mmPerUnit: number;
  /** Lowest Z of the object, in source units (height masks measure from here). */
  minZ: number;
}

/** A grey image with alpha, for decals. */
export interface DecalBitmap {
  width: number;
  height: number;
  /** Per pixel: luminance, alpha (0..255). */
  la: Uint8Array;
}

/**
 * Evaluates a 0/1 value per texel. `triValue(t)` returns a whole triangle's value (0 or
 * 1), or -1 to ask `texelValue` at each texel's surface point.
 */
export function rasterSurface(
  atlas: PaintAtlas,
  triValue: (t: number) => number,
  texelValue: (t: number, x: number, y: number, z: number) => number,
): Uint8Array[] {
  const I = atlas.indices, U = atlas.uvs, X = atlas.positions;
  const T = I.length / 3;
  const tv = new Int8Array(T);
  for (let t = 0; t < T; t++) tv[t] = triValue(t);
  const reach2 = RASTER_REACH * RASTER_REACH;

  return atlas.pages.map((page) => {
    const W = page.width, H = page.height;
    const out = new Uint8Array(W * H);
    // 1 = centre inside a triangle, 2 = gutter texel already given a value.
    const owned = new Uint8Array(W * H);
    const end = page.triStart + page.triCount;

    for (let pass = 0; pass < 2; pass++) {
      for (let t = page.triStart; t < end; t++) {
        const ia = I[t * 3]!, ib = I[t * 3 + 1]!, ic = I[t * 3 + 2]!;
        const ua = U[ia * 2]!, va = U[ia * 2 + 1]!, ub = U[ib * 2]!, vb = U[ib * 2 + 1]!, uc = U[ic * 2]!, vc = U[ic * 2 + 1]!;
        const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const reach = pass ? RASTER_REACH : 0;
        const x0 = Math.max(0, Math.ceil(Math.min(ua, ub, uc) - reach - 0.5));
        const x1 = Math.min(W - 1, Math.floor(Math.max(ua, ub, uc) + reach - 0.5));
        const y0 = Math.max(0, Math.ceil(Math.min(va, vb, vc) - reach - 0.5));
        const y1 = Math.min(H - 1, Math.floor(Math.max(va, vb, vc) + reach - 0.5));
        if (x0 > x1 || y0 > y1) continue;
        const fixed = tv[t]!;
        const pax = X[ia * 3]!, pay = X[ia * 3 + 1]!, paz = X[ia * 3 + 2]!;
        const e1x = X[ib * 3]! - pax, e1y = X[ib * 3 + 1]! - pay, e1z = X[ib * 3 + 2]! - paz;
        const e2x = X[ic * 3]! - pax, e2y = X[ic * 3 + 1]! - pay, e2z = X[ic * 3 + 2]! - paz;
        for (let y = y0; y <= y1; y++) {
          const cy = y + 0.5;
          for (let x = x0; x <= x1; x++) {
            const idx = y * W + x;
            if (pass && owned[idx]) continue;
            const cx = x + 0.5;
            let lb = ((cx - ua) * (vc - va) - (uc - ua) * (cy - va)) * inv;
            let lc = ((ub - ua) * (cy - va) - (cx - ua) * (vb - va)) * inv;
            const inside = lb >= -1e-9 && lc >= -1e-9 && lb + lc <= 1 + 1e-9;
            if (!pass) {
              if (!inside) continue;
            } else {
              const q = closestOnTriangle(cx, cy, ua, va, ub, vb, uc, vc);
              if ((q[0] - cx) ** 2 + (q[1] - cy) ** 2 > reach2) continue;
              lb = ((q[0] - ua) * (vc - va) - (uc - ua) * (q[1] - va)) * inv;
              lc = ((ub - ua) * (q[1] - va) - (q[0] - ua) * (vb - va)) * inv;
            }
            owned[idx] = pass ? 2 : 1;
            out[idx] =
              fixed >= 0
                ? fixed
                : texelValue(t, pax + lb * e1x + lc * e2x, pay + lb * e1y + lc * e2y, paz + lb * e1z + lc * e2z) ? 1 : 0;
          }
        }
      }
    }
    return out;
  });
}

function normalize(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

/** Triangles whose normal is between `minDeg` and `maxDeg` from `dir` (e.g. up = top surfaces). */
export function angleMask(atlas: PaintAtlas, topo: FillTopology, dir: readonly number[], minDeg: number, maxDeg: number): Uint8Array[] {
  const [dx, dy, dz] = normalize(dir);
  const N = topo.normals;
  const lo = (Math.max(0, Math.min(180, minDeg)) * Math.PI) / 180;
  const hi = (Math.max(0, Math.min(180, maxDeg)) * Math.PI) / 180;
  const eps = 1e-6;
  return rasterSurface(
    atlas,
    (t) => {
      const d = N[t * 3]! * dx + N[t * 3 + 1]! * dy + N[t * 3 + 2]! * dz;
      const a = Math.acos(Math.max(-1, Math.min(1, d)));
      return a >= lo - eps && a <= hi + eps ? 1 : 0;
    },
    () => 0,
  );
}

/**
 * Height above the object's bottom between `fromMm` and `toMm`. With `repeatMm` > 0
 * the band repeats every `repeatMm` (stripes).
 */
export function heightMask(atlas: PaintAtlas, info: SurfaceInfo, fromMm: number, toMm: number, repeatMm: number): Uint8Array[] {
  const s = info.mmPerUnit, z0 = info.minZ;
  const band = toMm - fromMm;
  const inBand = (zmm: number): boolean => {
    if (repeatMm > 0) {
      if (band <= 0) return false;
      if (band >= repeatMm) return true;
      const ph = (((zmm - fromMm) % repeatMm) + repeatMm) % repeatMm;
      return ph < band;
    }
    return zmm >= fromMm && zmm <= toMm;
  };
  const I = atlas.indices, X = atlas.positions;
  return rasterSurface(
    atlas,
    (t) => {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        const z = (X[I[t * 3 + k]! * 3 + 2]! - z0) * s;
        if (z < lo) lo = z;
        if (z > hi) hi = z;
      }
      if (repeatMm > 0) {
        if (band <= 0) return 0;
        if (band >= repeatMm) return 1;
        return hi - lo < 1e-9 ? (inBand(lo) ? 1 : 0) : -1;
      }
      if (hi < fromMm || lo > toMm) return 0;
      if (lo >= fromMm && hi <= toMm) return 1;
      return -1;
    },
    (_t, _x, _y, z) => (inBand((z - z0) * s) ? 1 : 0),
  );
}

export type EdgeKind = 'both' | 'convex' | 'concave';

/** Sharp mesh edges (bend above `angleDeg`) as segments, 6 numbers each. */
export function sharpEdges(atlas: PaintAtlas, topo: FillTopology, angleDeg: number, which: EdgeKind): Float64Array {
  const I = atlas.indices, X = atlas.positions, A = topo.adjacent, N = topo.normals;
  const T = I.length / 3;
  const cosA = Math.cos((Math.max(0, Math.min(180, angleDeg)) * Math.PI) / 180);
  const out: number[] = [];
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const u = A[t * 3 + k]!;
      if (u < t) continue; // each shared edge once (and skip open edges)
      const d = N[t * 3]! * N[u * 3]! + N[t * 3 + 1]! * N[u * 3 + 1]! + N[t * 3 + 2]! * N[u * 3 + 2]!;
      if (d > cosA - 1e-9) continue;
      const a = I[t * 3 + k]!, b = I[t * 3 + ((k + 1) % 3)]!;
      if (which !== 'both') {
        // Convex when the neighbour's far corner lies below this triangle's plane.
        const xa = atlas.xref[a]!, xb = atlas.xref[b]!;
        let far = -1;
        for (let j = 0; j < 3; j++) {
          const v = I[u * 3 + j]!;
          const xv = atlas.xref[v]!;
          if (xv !== xa && xv !== xb) far = v;
        }
        if (far < 0) continue;
        const side =
          N[t * 3]! * (X[far * 3]! - X[a * 3]!) + N[t * 3 + 1]! * (X[far * 3 + 1]! - X[a * 3 + 1]!) + N[t * 3 + 2]! * (X[far * 3 + 2]! - X[a * 3 + 2]!);
        if ((side < 0) !== (which === 'convex')) continue;
      }
      out.push(X[a * 3]!, X[a * 3 + 1]!, X[a * 3 + 2]!, X[b * 3]!, X[b * 3 + 1]!, X[b * 3 + 2]!);
    }
  }
  return Float64Array.from(out);
}

/** Within `widthMm` of a sharp edge. */
export function edgeMask(atlas: PaintAtlas, info: SurfaceInfo, topo: FillTopology, angleDeg: number, widthMm: number, which: EdgeKind): Uint8Array[] {
  const seg = sharpEdges(atlas, topo, angleDeg, which);
  const S = seg.length / 6;
  const r = Math.max(1e-9, widthMm / info.mmPerUnit);
  if (!S) return atlas.pages.map((p) => new Uint8Array(p.width * p.height));
  const X = atlas.positions, I = atlas.indices;

  // Uniform grid over the mesh; cells are 2r so a point within r of a segment is within
  // one cell of a sample on it (samples every r).
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < X.length; i += 3) {
    mnx = Math.min(mnx, X[i]!);
    mxx = Math.max(mxx, X[i]!);
    mny = Math.min(mny, X[i + 1]!);
    mxy = Math.max(mxy, X[i + 1]!);
    mnz = Math.min(mnz, X[i + 2]!);
    mxz = Math.max(mxz, X[i + 2]!);
  }
  let cell = 2 * r;
  const ext = Math.max(mxx - mnx, mxy - mny, mxz - mnz);
  cell = Math.max(cell, ext / 2048); // keep the grid keys and sample counts sane
  const step = cell / 2;
  const nx = Math.floor((mxx - mnx) / cell) + 3, ny = Math.floor((mxy - mny) / cell) + 3;
  const key = (ix: number, iy: number, iz: number) => (iz * ny + iy) * nx + ix;
  const cellOf = (v: number, m: number) => Math.floor((v - m) / cell) + 1;
  const grid = new Map<number, number[]>();
  for (let s = 0; s < S; s++) {
    const ax = seg[s * 6]!, ay = seg[s * 6 + 1]!, az = seg[s * 6 + 2]!;
    const bx = seg[s * 6 + 3]!, by = seg[s * 6 + 4]!, bz = seg[s * 6 + 5]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / step));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const k = key(cellOf(ax + (bx - ax) * f, mnx), cellOf(ay + (by - ay) * f, mny), cellOf(az + (bz - az) * f, mnz));
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      if (list[list.length - 1] !== s) list.push(s);
    }
  }
  const r2 = r * r;
  const dist2 = (s: number, px: number, py: number, pz: number): number => {
    const ax = seg[s * 6]!, ay = seg[s * 6 + 1]!, az = seg[s * 6 + 2]!;
    const ex = seg[s * 6 + 3]! - ax, ey = seg[s * 6 + 4]! - ay, ez = seg[s * 6 + 5]! - az;
    const l2 = ex * ex + ey * ey + ez * ez;
    let f = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const qx = ax + f * ex - px, qy = ay + f * ey - py, qz = az + f * ez - pz;
    return qx * qx + qy * qy + qz * qz;
  };
  // The point's own cell first (the likeliest hit), then its neighbours.
  const OFFSETS: number[] = [0, 0, 0];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) OFFSETS.push(dx, dy, dz);
  /** Some segment for which `test` holds, near cell (cx, cy, cz). */
  const anySeg = (cx: number, cy: number, cz: number, test: (s: number) => boolean): boolean => {
    for (let o = 0; o < OFFSETS.length; o += 3) {
      const list = grid.get(key(cx + OFFSETS[o]!, cy + OFFSETS[o + 1]!, cz + OFFSETS[o + 2]!));
      if (!list) continue;
      for (const s of list) if (test(s)) return true;
    }
    return false;
  };
  const near = (px: number, py: number, pz: number): boolean =>
    anySeg(cellOf(px, mnx), cellOf(py, mny), cellOf(pz, mnz), (s) => dist2(s, px, py, pz) <= r2);
  return rasterSurface(
    atlas,
    (t) => {
      // Skip triangles with no segment anywhere near (when that is cheap to tell).
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k]! * 3;
        lx = Math.min(lx, X[v]!);
        hx = Math.max(hx, X[v]!);
        ly = Math.min(ly, X[v + 1]!);
        hy = Math.max(hy, X[v + 1]!);
        lz = Math.min(lz, X[v + 2]!);
        hz = Math.max(hz, X[v + 2]!);
      }
      const x0 = cellOf(lx, mnx) - 1, x1 = cellOf(hx, mnx) + 1;
      const y0 = cellOf(ly, mny) - 1, y1 = cellOf(hy, mny) + 1;
      const z0 = cellOf(lz, mnz) - 1, z1 = cellOf(hz, mnz) + 1;
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 512) return -1;
      let any = false;
      for (let z = z0; z <= z1 && !any; z++) for (let y = y0; y <= y1 && !any; y++) for (let x = x0; x <= x1; x++) if (grid.has(key(x, y, z))) {
        any = true;
        break;
      }
      if (!any) return 0;
      // Distance to a segment is convex, so if all three corners are within reach of
      // one segment, so is the whole triangle.
      const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
      const inside = anySeg(cellOf(X[a]!, mnx), cellOf(X[a + 1]!, mny), cellOf(X[a + 2]!, mnz), (s) =>
        dist2(s, X[a]!, X[a + 1]!, X[a + 2]!) <= r2 && dist2(s, X[b]!, X[b + 1]!, X[b + 2]!) <= r2 && dist2(s, X[c]!, X[c + 1]!, X[c + 2]!) <= r2,
      );
      return inside ? 1 : -1;
    },
    (_t, x, y, z) => (near(x, y, z) ? 1 : 0),
  );
}

export interface DecalPlacement {
  /** Centre of the image, source units. */
  centre: readonly number[];
  /** Projection direction (into the surface). */
  dir: readonly number[];
  /** Image up. */
  up: readonly number[];
  /** Image width, source units. */
  width: number;
  rotationDeg: number;
  /** Also stamp back faces and surfaces hidden behind others. */
  through: boolean;
}

export type DecalChannel = 'alpha' | 'dark' | 'light';

/** The decal's frame: right and up axes (unit), projection direction, half sizes. */
export function decalFrame(p: DecalPlacement, aspect: number) {
  const d = normalize(p.dir);
  let u = p.up.map(Number) as Vec3;
  const ud = u[0] * d[0] + u[1] * d[1] + u[2] * d[2];
  u = [u[0] - ud * d[0], u[1] - ud * d[1], u[2] - ud * d[2]];
  if (Math.hypot(...u) < 1e-9) u = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  u = normalize(u);
  // right = dir × up (a camera looking along dir with this up sees it as +x).
  const r: Vec3 = normalize([d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]);
  const a = (p.rotationDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const right: Vec3 = [r[0] * ca + u[0] * sa, r[1] * ca + u[1] * sa, r[2] * ca + u[2] * sa];
  const up: Vec3 = [u[0] * ca - r[0] * sa, u[1] * ca - r[1] * sa, u[2] * ca - r[2] * sa];
  return { right, up, dir: d, halfW: p.width / 2, halfH: (p.width * aspect) / 2 };
}

/** An image projected straight along `dir`, on where its ink passes `threshold` (0..1). */
export function decalMask(
  atlas: PaintAtlas,
  bmp: DecalBitmap,
  p: DecalPlacement,
  channel: DecalChannel,
  threshold: number,
): Uint8Array[] {
  const BW = bmp.width, BH = bmp.height, LA = bmp.la;
  const f = decalFrame(p, BH / BW);
  const [cx, cy, cz] = [p.centre[0]!, p.centre[1]!, p.centre[2]!];
  const { right: R, up: Up, dir: D, halfW, halfH } = f;
  const X = atlas.positions, I = atlas.indices;
  const T = I.length / 3;
  // Image-plane coordinates of each paint vertex: s, t in -1..1 inside, depth along dir.
  const V = X.length / 3;
  const ps = new Float64Array(V), pt = new Float64Array(V), pd = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    const x = X[v * 3]! - cx, y = X[v * 3 + 1]! - cy, z = X[v * 3 + 2]! - cz;
    ps[v] = (x * R[0] + y * R[1] + z * R[2]) / halfW;
    pt[v] = (x * Up[0] + y * Up[1] + z * Up[2]) / halfH;
    pd[v] = x * D[0] + y * D[1] + z * D[2];
  }
  const facing = (t: number): boolean => {
    // Facing the projector: its image-plane winding (a camera looking along dir) is CCW.
    const a = I[t * 3]!, b = I[t * 3 + 1]!, c = I[t * 3 + 2]!;
    return (ps[b]! - ps[a]!) * (pt[c]! - pt[a]!) - (ps[c]! - ps[a]!) * (pt[b]! - pt[a]!) > 0;
  };

  // Depth buffer seen from the projector, over the image rectangle.
  const G = 1024;
  const GW = BW >= BH ? G : Math.max(16, Math.round((G * BW) / BH));
  const GH = BW >= BH ? Math.max(16, Math.round((G * BH) / BW)) : G;
  let zbuf: Float32Array | null = null;
  if (!p.through) {
    zbuf = new Float32Array(GW * GH).fill(Infinity);
    const gx = (s: number) => ((s + 1) / 2) * GW, gy = (t: number) => ((1 - t) / 2) * GH;
    for (let t = 0; t < T; t++) {
      const a = I[t * 3]!, b = I[t * 3 + 1]!, c = I[t * 3 + 2]!;
      const xa = gx(ps[a]!), ya = gy(pt[a]!), xb = gx(ps[b]!), yb = gy(pt[b]!), xc = gx(ps[c]!), yc = gy(pt[c]!);
      const x0 = Math.max(0, Math.ceil(Math.min(xa, xb, xc) - 0.5)), x1 = Math.min(GW - 1, Math.floor(Math.max(xa, xb, xc) - 0.5));
      const y0 = Math.max(0, Math.ceil(Math.min(ya, yb, yc) - 0.5)), y1 = Math.min(GH - 1, Math.floor(Math.max(ya, yb, yc) - 0.5));
      if (x0 > x1 || y0 > y1) continue;
      const det = (xb - xa) * (yc - ya) - (xc - xa) * (yb - ya);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const da = pd[a]!, db = pd[b]!, dc = pd[c]!;
      for (let y = y0; y <= y1; y++) {
        const sy = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const sx = x + 0.5;
          const lb = ((sx - xa) * (yc - ya) - (xc - xa) * (sy - ya)) * inv;
          const lc = ((xb - xa) * (sy - ya) - (sx - xa) * (yb - ya)) * inv;
          if (lb < -1e-6 || lc < -1e-6 || lb + lc > 1 + 1e-6) continue;
          const dep = da + lb * (db - da) + lc * (dc - da);
          const i = y * GW + x;
          if (dep < zbuf[i]!) zbuf[i] = dep;
        }
      }
    }
  }
  const cellSize = Math.max((2 * halfW) / GW, (2 * halfH) / GH);
  const bias = 2 * atlas.texelSize + 3 * cellSize;
  const cut = Math.max(1, Math.round(Math.min(1, Math.max(0, threshold)) * 255));

  return rasterSurface(
    atlas,
    (t) => {
      if (!p.through && !facing(t)) return 0;
      const a = I[t * 3]!, b = I[t * 3 + 1]!, c = I[t * 3 + 2]!;
      if (Math.max(ps[a]!, ps[b]!, ps[c]!) < -1 || Math.min(ps[a]!, ps[b]!, ps[c]!) > 1) return 0;
      if (Math.max(pt[a]!, pt[b]!, pt[c]!) < -1 || Math.min(pt[a]!, pt[b]!, pt[c]!) > 1) return 0;
      return -1;
    },
    (_t, x, y, z) => {
      const qx = x - cx, qy = y - cy, qz = z - cz;
      const s = (qx * R[0] + qy * R[1] + qz * R[2]) / halfW;
      const tt = (qx * Up[0] + qy * Up[1] + qz * Up[2]) / halfH;
      if (s < -1 || s >= 1 || tt <= -1 || tt > 1) return 0;
      if (zbuf) {
        const gxi = Math.min(GW - 1, Math.floor(((s + 1) / 2) * GW));
        const gyi = Math.min(GH - 1, Math.floor(((1 - tt) / 2) * GH));
        const dep = qx * D[0] + qy * D[1] + qz * D[2];
        if (dep > zbuf[gyi * GW + gxi]! + bias) return 0;
      }
      const bx = Math.min(BW - 1, Math.floor(((s + 1) / 2) * BW));
      const by = Math.min(BH - 1, Math.floor(((1 - tt) / 2) * BH));
      const i = (by * BW + bx) * 2;
      const l = LA[i]!, al = LA[i + 1]!;
      const ink = channel === 'alpha' ? al : channel === 'dark' ? (al * (255 - l)) / 255 : (al * l) / 255;
      return ink >= cut ? 1 : 0;
    },
  );
}
