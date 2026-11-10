// Slot-index paint maps and the brush rasterizer.
//
// Each object's paint lives in one Uint8Array per atlas page: 0 = unpainted (prints
// as slot 1, the base), 1..16 = palette slot. The CPU copy is authoritative (undo,
// export and project files read it directly); the viewport uploads the rectangles
// that changed.
//
// A dab paints every texel whose surface point lies within `radius` of the brush axis
// (a ray from the camera through the cursor hit), faces the camera and passes the
// caller's visibility test (the viewport checks its depth buffer). Texels are
// rasterized conservatively: any texel within RASTER_REACH of a triangle in UV space
// is painted using the nearest surface point, so the GPU never samples an unpainted
// gutter texel along chart edges.
//
// Pure TS, no DOM.

import { RASTER_REACH, type PaintAtlas } from './atlas';

export type Vec3 = [number, number, number];

/** Undo tile edge, in texels. */
export const TILE = 128;
/** Slot values are 0 (unpainted) and 1..MAX_SLOTS. */
export const MAX_SLOTS = 16;

export interface Rect {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  y1: number;
}

export interface Dab {
  /** Brush axis origin and unit direction, in the atlas's source units. */
  origin: Vec3;
  dir: Vec3;
  radius: number;
  /** Slot to write (0 erases). */
  value: number;
  /** Extra per-texel test (occlusion); position in source units. */
  visible?: (x: number, y: number, z: number) => boolean;
}

export interface TileSnapshot {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8Array;
}

/** Tiles changed by one action. Applying it swaps tile contents, so the same edit undoes and redoes. */
export interface TileEdit {
  tiles: TileSnapshot[];
  bytes: number;
}

export function createMaps(atlas: PaintAtlas): Uint8Array[] {
  return atlas.pages.map((p) => new Uint8Array(p.width * p.height));
}

export function triPages(atlas: PaintAtlas): Uint8Array {
  const out = new Uint8Array(atlas.indices.length / 3);
  atlas.pages.forEach((p, i) => out.fill(i, p.triStart, p.triStart + p.triCount));
  return out;
}

/** Collects undo snapshots and dirty rectangles while painting. */
export class PaintRecorder {
  private touched: Uint8Array[];
  private tilesX: number[];
  private saved: TileSnapshot[] = [];
  private dirty: (Rect | null)[];

  constructor(private atlas: PaintAtlas, private maps: Uint8Array[]) {
    this.tilesX = atlas.pages.map((p) => Math.ceil(p.width / TILE));
    this.touched = atlas.pages.map((p, i) => new Uint8Array(this.tilesX[i]! * Math.ceil(p.height / TILE)));
    this.dirty = atlas.pages.map(() => null);
  }

  /** Call before changing texel (x, y) of `page`. */
  touch(page: number, x: number, y: number): void {
    const tx = (x / TILE) | 0, ty = (y / TILE) | 0;
    const flags = this.touched[page]!;
    const ti = ty * this.tilesX[page]! + tx;
    if (!flags[ti]) {
      flags[ti] = 1;
      this.saved.push(copyTile(this.atlas, this.maps, page, tx * TILE, ty * TILE));
    }
    const d = this.dirty[page];
    if (!d) this.dirty[page] = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
    else {
      if (x < d.x0) d.x0 = x;
      if (y < d.y0) d.y0 = y;
      if (x >= d.x1) d.x1 = x + 1;
      if (y >= d.y1) d.y1 = y + 1;
    }
  }

  /** Rectangles changed since the last call, per page (null = unchanged). */
  takeDirty(): (Rect | null)[] {
    const d = this.dirty;
    this.dirty = this.atlas.pages.map(() => null);
    return d;
  }

  /** Ends the action. Returns the undo edit, or null if nothing actually changed. */
  finish(): TileEdit | null {
    const tiles = this.saved.filter((s) => !tileEquals(this.atlas, this.maps, s));
    this.saved = [];
    this.touched.forEach((t) => t.fill(0));
    if (!tiles.length) return null;
    return { tiles, bytes: tiles.reduce((n, t) => n + t.data.byteLength, 0) };
  }
}

function copyTile(atlas: PaintAtlas, maps: Uint8Array[], page: number, x: number, y: number): TileSnapshot {
  const W = atlas.pages[page]!.width, H = atlas.pages[page]!.height;
  const w = Math.min(TILE, W - x), h = Math.min(TILE, H - y);
  const data = new Uint8Array(w * h);
  const m = maps[page]!;
  for (let r = 0; r < h; r++) data.set(m.subarray((y + r) * W + x, (y + r) * W + x + w), r * w);
  return { page, x, y, w, h, data };
}

function tileEquals(atlas: PaintAtlas, maps: Uint8Array[], s: TileSnapshot): boolean {
  const W = atlas.pages[s.page]!.width;
  const m = maps[s.page]!;
  for (let r = 0; r < s.h; r++) {
    const row = (s.y + r) * W + s.x;
    for (let c = 0; c < s.w; c++) if (m[row + c] !== s.data[r * s.w + c]) return false;
  }
  return true;
}

/** Swaps the edit's tiles with the maps' contents (undo and redo are the same operation). */
export function swapTiles(atlas: PaintAtlas, maps: Uint8Array[], edit: TileEdit): (Rect | null)[] {
  const dirty: (Rect | null)[] = atlas.pages.map(() => null);
  for (const s of edit.tiles) {
    const W = atlas.pages[s.page]!.width;
    const m = maps[s.page]!;
    for (let r = 0; r < s.h; r++) {
      const row = (s.y + r) * W + s.x;
      for (let c = 0; c < s.w; c++) {
        const i = r * s.w + c;
        const v = m[row + c]!;
        m[row + c] = s.data[i]!;
        s.data[i] = v;
      }
    }
    dirty[s.page] = unionRect(dirty[s.page] ?? null, { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h });
  }
  return dirty;
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * Paints one dab onto the triangles listed in `tris` (paint triangle indices; pass
 * every triangle if there is no spatial index). Returns the number of texels changed.
 */
export function paintDab(
  atlas: PaintAtlas,
  maps: Uint8Array[],
  pageOf: Uint8Array,
  rec: PaintRecorder,
  dab: Dab,
  tris: ArrayLike<number>,
  count = tris.length,
): number {
  const I = atlas.indices, X = atlas.positions, U = atlas.uvs;
  const [ox, oy, oz] = dab.origin;
  const [dx, dy, dz] = dab.dir;
  const r = dab.radius, r2 = r * r;
  const value = dab.value;
  const visible = dab.visible;
  const reach2 = RASTER_REACH * RASTER_REACH;
  let changed = 0;

  for (let n = 0; n < count; n++) {
    const t = tris[n]!;
    const ia = I[t * 3]!, ib = I[t * 3 + 1]!, ic = I[t * 3 + 2]!;
    const pax = X[ia * 3]!, pay = X[ia * 3 + 1]!, paz = X[ia * 3 + 2]!;
    const e1x = X[ib * 3]! - pax, e1y = X[ib * 3 + 1]! - pay, e1z = X[ib * 3 + 2]! - paz;
    const e2x = X[ic * 3]! - pax, e2y = X[ic * 3 + 1]! - pay, e2z = X[ic * 3 + 2]! - paz;

    // Only faces turned towards the brush.
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (nx * dx + ny * dy + nz * dz >= 0) continue;

    // Quick reject: the triangle's bounding circle, seen along the axis, misses the brush.
    {
      const q0x = pax - ox, q0y = pay - oy, q0z = paz - oz;
      const a0 = q0x * dx + q0y * dy + q0z * dz;
      const p0x = q0x - a0 * dx, p0y = q0y - a0 * dy, p0z = q0z - a0 * dz;
      const a1 = (q0x + e1x) * dx + (q0y + e1y) * dy + (q0z + e1z) * dz;
      const p1x = q0x + e1x - a1 * dx, p1y = q0y + e1y - a1 * dy, p1z = q0z + e1z - a1 * dz;
      const a2 = (q0x + e2x) * dx + (q0y + e2y) * dy + (q0z + e2z) * dz;
      const p2x = q0x + e2x - a2 * dx, p2y = q0y + e2y - a2 * dy, p2z = q0z + e2z - a2 * dz;
      const cx = (p0x + p1x + p2x) / 3, cy = (p0y + p1y + p2y) / 3, cz = (p0z + p1z + p2z) / 3;
      const R = Math.sqrt(
        Math.max(
          (p0x - cx) ** 2 + (p0y - cy) ** 2 + (p0z - cz) ** 2,
          (p1x - cx) ** 2 + (p1y - cy) ** 2 + (p1z - cz) ** 2,
          (p2x - cx) ** 2 + (p2y - cy) ** 2 + (p2z - cz) ** 2,
        ),
      );
      if (Math.hypot(cx, cy, cz) > r + R) continue;
    }

    const ua = U[ia * 2]!, va = U[ia * 2 + 1]!;
    const ub = U[ib * 2]!, vb = U[ib * 2 + 1]!;
    const uc = U[ic * 2]!, vc = U[ic * 2 + 1]!;
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
        const cx = x + 0.5;
        let su = cx, sv = cy;
        let lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) * inv;
        let lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) * inv;
        if (lb < 0 || lc < 0 || lb + lc > 1) {
          // Outside: use the nearest point on the triangle if it is within reach.
          const q = closestOnTriangle(cx, cy, ua, va, ub, vb, uc, vc);
          if ((q[0] - cx) ** 2 + (q[1] - cy) ** 2 > reach2) continue;
          su = q[0];
          sv = q[1];
          lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) * inv;
          lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) * inv;
        }
        const px = pax + lb * e1x + lc * e2x;
        const py = pay + lb * e1y + lc * e2y;
        const pz = paz + lb * e1z + lc * e2z;
        const qx = px - ox, qy = py - oy, qz = pz - oz;
        const along = qx * dx + qy * dy + qz * dz;
        if (qx * qx + qy * qy + qz * qz - along * along > r2) continue;
        const idx = y * W + x;
        if (map[idx] === value) continue;
        if (visible && !visible(px, py, pz)) continue;
        rec.touch(page, x, y);
        map[idx] = value;
        changed++;
      }
    }
  }
  return changed;
}

const _q: [number, number] = [0, 0];
/** Closest point to (px, py) on triangle abc (2D). Reuses one result array. */
function closestOnTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): [number, number] {
  let best = Infinity;
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const ex = x1 - x0, ey = y1 - y0;
    const l2 = ex * ex + ey * ey;
    let s = l2 > 0 ? ((px - x0) * ex + (py - y0) * ey) / l2 : 0;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const qx = x0 + s * ex, qy = y0 + s * ey;
    const d = (qx - px) ** 2 + (qy - py) ** 2;
    if (d < best) {
      best = d;
      _q[0] = qx;
      _q[1] = qy;
    }
  };
  seg(ax, ay, bx, by);
  seg(bx, by, cx, cy);
  seg(cx, cy, ax, ay);
  return _q;
}

/**
 * Carries paint from one atlas of a mesh to another atlas of the same source mesh
 * (after a unit or resolution change). Every new texel takes the old value at the
 * same surface point.
 */
export function resampleMaps(oldAtlas: PaintAtlas, oldMaps: Uint8Array[], newAtlas: PaintAtlas): Uint8Array[] {
  const maps = createMaps(newAtlas);
  const oldTri = new Int32Array(oldAtlas.triSource.length).fill(-1);
  oldAtlas.triSource.forEach((s, t) => (oldTri[s] = t));
  const oldPage = triPages(oldAtlas);
  const newPage = triPages(newAtlas);
  const I = newAtlas.indices, U = newAtlas.uvs, OI = oldAtlas.indices, OU = oldAtlas.uvs;
  const reach2 = RASTER_REACH * RASTER_REACH;

  for (let t = 0; t < I.length / 3; t++) {
    const o = oldTri[newAtlas.triSource[t]!]!;
    if (o < 0) continue;
    const op = oldPage[o]!;
    const oW = oldAtlas.pages[op]!.width, oH = oldAtlas.pages[op]!.height;
    const om = oldMaps[op]!;
    // Corner k of a paint triangle is corner k of its source triangle in every atlas.
    const oua = OU[OI[o * 3]! * 2]!, ova = OU[OI[o * 3]! * 2 + 1]!;
    const oub = OU[OI[o * 3 + 1]! * 2]!, ovb = OU[OI[o * 3 + 1]! * 2 + 1]!;
    const ouc = OU[OI[o * 3 + 2]! * 2]!, ovc = OU[OI[o * 3 + 2]! * 2 + 1]!;

    const ua = U[I[t * 3]! * 2]!, va = U[I[t * 3]! * 2 + 1]!;
    const ub = U[I[t * 3 + 1]! * 2]!, vb = U[I[t * 3 + 1]! * 2 + 1]!;
    const uc = U[I[t * 3 + 2]! * 2]!, vc = U[I[t * 3 + 2]! * 2 + 1]!;
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const page = newPage[t]!;
    const W = newAtlas.pages[page]!.width, H = newAtlas.pages[page]!.height;
    const map = maps[page]!;
    const x0 = Math.max(0, Math.ceil(Math.min(ua, ub, uc) - RASTER_REACH - 0.5));
    const x1 = Math.min(W - 1, Math.floor(Math.max(ua, ub, uc) + RASTER_REACH - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(va, vb, vc) - RASTER_REACH - 0.5));
    const y1 = Math.min(H - 1, Math.floor(Math.max(va, vb, vc) + RASTER_REACH - 0.5));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let su = x + 0.5, sv = y + 0.5;
        let lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) * inv;
        let lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) * inv;
        if (lb < 0 || lc < 0 || lb + lc > 1) {
          const q = closestOnTriangle(su, sv, ua, va, ub, vb, uc, vc);
          if ((q[0] - su) ** 2 + (q[1] - sv) ** 2 > reach2) continue;
          su = q[0];
          sv = q[1];
          lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) * inv;
          lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) * inv;
        }
        const la = 1 - lb - lc;
        const ou = la * oua + lb * oub + lc * ouc;
        const ov = la * ova + lb * ovb + lc * ovc;
        const ox = Math.min(oW - 1, Math.max(0, Math.floor(ou)));
        const oy = Math.min(oH - 1, Math.max(0, Math.floor(ov)));
        const v = om[oy * oW + ox]!;
        if (v) map[y * W + x] = v;
      }
    }
  }
  return maps;
}

/** Sets every painted texel back to 0, recording undo tiles. Returns the texels changed. */
export function clearMaps(maps: Uint8Array[], rec: PaintRecorder, atlas: PaintAtlas): number {
  let changed = 0;
  maps.forEach((m, page) => {
    const W = atlas.pages[page]!.width;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      rec.touch(page, i % W, (i / W) | 0);
      m[i] = 0;
      changed++;
    }
  });
  return changed;
}

/** Applies a value lookup table to tile snapshots (keeps undo data consistent with remapSlots). */
export function remapEdit(edit: TileEdit, lut: Uint8Array): void {
  for (const t of edit.tiles) for (let i = 0; i < t.data.length; i++) t.data[i] = lut[t.data[i]!]!;
}

/** Applies a value lookup table (256 entries) to every texel. */
export function remapSlots(maps: Uint8Array[], lut: Uint8Array): void {
  for (const m of maps) for (let i = 0; i < m.length; i++) m[i] = lut[m[i]!]!;
}

/** Texel count per slot value (index 0 = unpainted). */
export function slotHistogram(maps: Uint8Array[]): Uint32Array {
  const h = new Uint32Array(256);
  for (const m of maps) for (let i = 0; i < m.length; i++) h[m[i]!]!++;
  return h;
}
