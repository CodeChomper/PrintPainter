// Paint atlas: gives every triangle its own non-overlapping spot in one or more
// texture pages, so paint can be stored as a slot-index texture.
//
// Charts are grown from seed triangles while face normals stay within a cone, then
// projected flat onto the chart's average normal. Normals within the cone guarantee
// each projected triangle keeps its winding; any chart that still overlaps itself
// (a surface that folds back over itself) or is too big for a page is split in two
// until it fits. Charts are packed onto shelves, pages capped at maxPageSize.
//
// Our own unwrapper rather than xatlas: the npm xatlas builds take 16-bit indices
// (65k vertices) and don't report which page a triangle landed on. Planar charts
// are also much faster, and texel density stays within cos(maxChartAngle) of the
// target, which is all filament painting needs.
//
// Pure TS, no DOM: runs in a worker.

import { analyzeEdges } from './cleanup';
import type { IndexedMesh } from './mesh';

export interface AtlasPage {
  width: number;
  height: number;
  /** Triangles of this page are paint triangles [triStart, triStart + triCount). */
  triStart: number;
  triCount: number;
}

export interface PaintAtlas {
  /** Paint mesh: the source mesh with vertices split along chart seams. Source units. */
  positions: Float32Array;
  /** Triangles, grouped by page. */
  indices: Uint32Array;
  /** Texel-space UVs (0..page width / height), two per paint vertex. */
  uvs: Float32Array;
  /** Paint vertex → source mesh vertex. */
  xref: Uint32Array;
  /** Paint triangle → source mesh triangle. */
  triSource: Uint32Array;
  /** Per paint triangle, when the source mesh has them (STEP faces). */
  faceIds?: Int32Array;
  pages: AtlasPage[];
  /** Edge length of one texel, in source units. */
  texelSize: number;
  charts: number;
}

export interface AtlasOptions {
  /** Edge length of one texel, in source units. */
  texelSize: number;
  /** Largest page edge in texels (the GPU texture size limit). Default 8192. */
  maxPageSize?: number;
  /** Largest angle between a chart's seed normal and its other triangles. Default 45°. */
  maxChartAngleDeg?: number;
  /** Empty texels kept around each chart (paint rasterizes up to one texel outside). Default 2. */
  padding?: number;
}

/** Conservative rasterization reach, in texels: covers every texel a fragment inside a triangle can sample. */
export const RASTER_REACH = 0.75;

export function buildAtlas(mesh: IndexedMesh, options: AtlasOptions): PaintAtlas {
  const ts = options.texelSize;
  if (!(ts > 0)) throw new Error('texelSize must be positive');
  const maxPage = options.maxPageSize ?? 8192;
  const pad = options.padding ?? 2;
  const cosMax = Math.cos(((options.maxChartAngleDeg ?? 45) * Math.PI) / 180);
  const P = mesh.positions;
  const I = mesh.indices;
  const T = I.length / 3;
  const V = P.length / 3;

  // Face normals (unit, zero for degenerate faces) and areas.
  const fn = new Float32Array(T * 3);
  const area = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    area[t] = len / 2;
    if (len > 0) {
      fn[t * 3] = nx / len;
      fn[t * 3 + 1] = ny / len;
      fn[t * 3 + 2] = nz / len;
    }
  }

  const { twin } = analyzeEdges(I, V);

  // --- Chart growing ------------------------------------------------------
  const chartOf = new Int32Array(T).fill(-1);
  const seeds = Uint32Array.from({ length: T }, (_, i) => i).sort((x, y) => area[y]! - area[x]!);
  const queue = new Uint32Array(T);
  /** Chart triangles plus the seed whose normal bounds them (every triangle is within maxChartAngle of it). */
  const grown: { tris: Uint32Array; seed: number }[] = [];
  for (const seed of seeds) {
    if (chartOf[seed]! >= 0) continue;
    const c = grown.length;
    const sx = fn[seed * 3]!, sy = fn[seed * 3 + 1]!, sz = fn[seed * 3 + 2]!;
    const seedDegenerate = sx === 0 && sy === 0 && sz === 0;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    chartOf[seed] = c;
    while (head < tail) {
      const t = queue[head++]!;
      for (let k = 0; k < 3; k++) {
        const o = twin[t * 3 + k]!;
        if (o < 0) continue;
        const u = (o / 3) | 0;
        if (chartOf[u]! >= 0) continue;
        const nx = fn[u * 3]!, ny = fn[u * 3 + 1]!, nz = fn[u * 3 + 2]!;
        const degenerate = nx === 0 && ny === 0 && nz === 0;
        // Degenerate faces have no direction and join any neighbour; a degenerate seed
        // only collects other degenerate faces.
        if (seedDegenerate ? !degenerate : !degenerate && nx * sx + ny * sy + nz * sz < cosMax) continue;
        chartOf[u] = c;
        queue[tail++] = u;
      }
    }
    grown.push({ tris: queue.slice(0, tail), seed });
  }

  // --- Projection, overlap check and splitting ----------------------------
  interface Chart {
    tris: Uint32Array;
    /** Texel-space position of each corner (tris.length × 3 × 2), min corner at 0,0. */
    uv: Float32Array;
    w: number;
    h: number;
    page: number;
    x: number;
    y: number;
  }
  const charts: Chart[] = [];
  const work = grown;
  const member = new Int32Array(T).fill(-1);
  let memberStamp = 0;
  let bitmap = new Uint8Array(0);
  const maxContent = maxPage - 2 * pad;

  while (work.length) {
    const { tris, seed } = work.pop()!;
    const flat = projectChart(tris, seed);
    if (flat && tris.length > 1 && (flat.w > maxContent || flat.h > maxContent || overlaps(tris, flat))) {
      splitChart(tris).forEach((part) => work.push({ tris: part, seed }));
      continue;
    }
    if (!flat) {
      // Not even a single triangle fits a page: give up loudly rather than paint wrong.
      throw new Error('A triangle is larger than the biggest paint texture; use a coarser paint resolution.');
    }
    charts.push({ tris, uv: flat.uv, w: flat.w, h: flat.h, page: 0, x: 0, y: 0 });
  }

  function projectChart(tris: Uint32Array, seed: number): { uv: Float32Array; w: number; h: number } | null {
    // Axis: the area-weighted average normal, unless the seed normal keeps the worst
    // triangle closer (the seed always keeps them within maxChartAngle).
    let ax = 0, ay = 0, az = 0;
    for (const t of tris) {
      ax += fn[t * 3]! * area[t]!;
      ay += fn[t * 3 + 1]! * area[t]!;
      az += fn[t * 3 + 2]! * area[t]!;
    }
    let len = Math.hypot(ax, ay, az);
    if (!(len > 0)) {
      ax = 0; ay = 0; az = 1; len = 1;
    }
    ax /= len; ay /= len; az /= len;
    const worst = (x: number, y: number, z: number) => {
      let m = 1;
      for (const t of tris) {
        if (!area[t]) continue;
        const d = fn[t * 3]! * x + fn[t * 3 + 1]! * y + fn[t * 3 + 2]! * z;
        if (d < m) m = d;
      }
      return m;
    };
    const sx = fn[seed * 3]!, sy = fn[seed * 3 + 1]!, sz = fn[seed * 3 + 2]!;
    if ((sx || sy || sz) && worst(sx, sy, sz) > worst(ax, ay, az)) {
      ax = sx; ay = sy; az = sz;
    }
    // Basis with u × v = axis, so front faces stay counter-clockwise.
    let ux: number, uy: number, uz: number;
    if (Math.abs(ax) < 0.9) {
      ux = 0; uy = az; uz = -ay; // axis × X
    } else {
      ux = -az; uy = 0; uz = ax; // Y × axis
    }
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;

    const n = tris.length * 3;
    const uv = new Float32Array(n * 2);
    const px = new Float64Array(n), py = new Float64Array(n);
    for (let i = 0; i < tris.length; i++) {
      for (let k = 0; k < 3; k++) {
        const v = I[tris[i]! * 3 + k]! * 3;
        const x = P[v]!, y = P[v + 1]!, z = P[v + 2]!;
        px[i * 3 + k] = (x * ux + y * uy + z * uz) / ts;
        py[i * 3 + k] = (x * vx + y * vy + z * vz) / ts;
      }
    }

    // Rotate to the smallest bounding rectangle, then lay it flat (width ≥ height).
    const angle = minAreaRectAngle(px, py);
    const c = Math.cos(angle), s = Math.sin(angle);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = px[i]! * c + py[i]! * s;
      const y = -px[i]! * s + py[i]! * c;
      px[i] = x;
      py[i] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const tall = maxY - minY > maxX - minX;
    for (let i = 0; i < n; i++) {
      // 90° rotation (x, y) → (-y, x) keeps orientation.
      uv[i * 2] = tall ? maxY - py[i]! : px[i]! - minX;
      uv[i * 2 + 1] = tall ? px[i]! - minX : py[i]! - minY;
    }
    const w = tall ? maxY - minY : maxX - minX;
    const h = tall ? maxX - minX : maxY - minY;
    if (w > maxContent || h > maxContent) {
      return tris.length > 1 ? { uv, w, h } : null;
    }
    return { uv, w, h };
  }

  /** True if any texel centre is strictly inside two of the chart's triangles, or a triangle flipped. */
  function overlaps(tris: Uint32Array, flat: { uv: Float32Array; w: number; h: number }): boolean {
    const W = Math.ceil(flat.w) + 1, H = Math.ceil(flat.h) + 1;
    if (bitmap.length < W * H) bitmap = new Uint8Array(W * H);
    else bitmap.fill(0, 0, W * H);
    const uv = flat.uv;
    for (let i = 0; i < tris.length; i++) {
      const x0 = uv[i * 6]!, y0 = uv[i * 6 + 1]!;
      const x1 = uv[i * 6 + 2]!, y1 = uv[i * 6 + 3]!;
      const x2 = uv[i * 6 + 4]!, y2 = uv[i * 6 + 5]!;
      const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      const a3 = area[tris[i]!]! / (ts * ts); // 3D area in texels²
      if (d < 0 && -d / 2 > 1e-3 * Math.max(a3, 1e-9)) return true; // folded over
      if (d <= 0) continue;
      const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      for (let ty = by0; ty <= by1; ty++) {
        const cy = ty + 0.5;
        for (let tx = bx0; tx <= bx1; tx++) {
          const cx = tx + 0.5;
          if ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0) <= 0) continue;
          if ((x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1) <= 0) continue;
          if ((x0 - x2) * (cy - y2) - (y0 - y2) * (cx - x2) <= 0) continue;
          const idx = ty * W + tx;
          if (bitmap[idx]) return true;
          bitmap[idx] = 1;
        }
      }
    }
    return false;
  }

  /** Splits a chart into two by breadth-first order, so the first half stays connected. */
  function splitChart(tris: Uint32Array): Uint32Array[] {
    const stamp = ++memberStamp;
    for (const t of tris) member[t] = stamp;
    const order = new Uint32Array(tris.length);
    const seen = new Uint8Array(tris.length);
    const local = new Map<number, number>();
    tris.forEach((t, i) => local.set(t, i));
    let n = 0;
    for (let s = 0; s < tris.length && n < tris.length; s++) {
      if (seen[s]) continue;
      seen[s] = 1;
      let head = n;
      order[n++] = tris[s]!;
      while (head < n) {
        const t = order[head++]!;
        for (let k = 0; k < 3; k++) {
          const o = twin[t * 3 + k]!;
          if (o < 0) continue;
          const u = (o / 3) | 0;
          if (member[u] !== stamp) continue;
          const li = local.get(u)!;
          if (seen[li]) continue;
          seen[li] = 1;
          order[n++] = u;
        }
      }
    }
    const half = Math.ceil(tris.length / 2);
    return [order.slice(0, half), order.slice(half)];
  }

  // --- Packing ------------------------------------------------------------
  const rects = charts.map((c, i) => ({ i, w: Math.ceil(c.w) + 2 * pad, h: Math.ceil(c.h) + 2 * pad }));
  rects.sort((a, b) => b.h - a.h || b.w - a.w);
  let totalArea = 0;
  let widest = 0;
  for (const r of rects) {
    totalArea += r.w * r.h;
    widest = Math.max(widest, r.w);
  }
  const roundUp4 = (v: number) => Math.ceil(v / 4) * 4;
  const pageW = Math.min(maxPage, Math.max(roundUp4(widest), roundUp4(Math.sqrt(totalArea * 1.25))));

  interface Shelf { y: number; h: number; used: number }
  const pageHeights: number[] = [];
  let shelves: Shelf[] = [];
  let top = 0;
  let page = 0;
  for (const r of rects) {
    let shelf = shelves.find((s) => s.used + r.w <= pageW);
    if (!shelf) {
      if (top + r.h > maxPage) {
        pageHeights[page] = top;
        page++;
        shelves = [];
        top = 0;
      }
      shelf = { y: top, h: r.h, used: 0 };
      shelves.push(shelf);
      top += r.h;
    }
    const c = charts[r.i]!;
    c.page = page;
    c.x = shelf.used + pad;
    c.y = shelf.y + pad;
    shelf.used += r.w;
  }
  pageHeights[page] = top;

  // --- Output mesh, grouped by page ----------------------------------------
  const byPage = charts.map((_, i) => i).sort((a, b) => charts[a]!.page - charts[b]!.page);
  const outIdx = new Uint32Array(T * 3);
  const outTri = new Uint32Array(T);
  const vmap = new Int32Array(V);
  const vstamp = new Int32Array(V).fill(-1);
  const xrefTmp = new Uint32Array(T * 3);
  const uvTmp = new Float32Array(T * 6);
  let nv = 0;
  let nt = 0;
  const pages: AtlasPage[] = pageHeights.map((h) => ({ width: pageW, height: roundUp4(Math.max(h, 4)), triStart: 0, triCount: 0 }));
  for (let ci = 0; ci < byPage.length; ci++) {
    const c = charts[byPage[ci]!]!;
    const pg = pages[c.page]!;
    if (pg.triCount === 0) pg.triStart = nt;
    pg.triCount += c.tris.length;
    for (let i = 0; i < c.tris.length; i++) {
      const t = c.tris[i]!;
      outTri[nt] = t;
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k]!;
        if (vstamp[v] !== ci) {
          vstamp[v] = ci;
          vmap[v] = nv;
          xrefTmp[nv] = v;
          uvTmp[nv * 2] = c.x + c.uv[(i * 3 + k) * 2]!;
          uvTmp[nv * 2 + 1] = c.y + c.uv[(i * 3 + k) * 2 + 1]!;
          nv++;
        }
        outIdx[nt * 3 + k] = vmap[v]!;
      }
      nt++;
    }
  }
  const xref = xrefTmp.slice(0, nv);
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const s = xref[i]! * 3;
    positions[i * 3] = P[s]!;
    positions[i * 3 + 1] = P[s + 1]!;
    positions[i * 3 + 2] = P[s + 2]!;
  }
  const result: PaintAtlas = {
    positions,
    indices: outIdx,
    uvs: uvTmp.slice(0, nv * 2),
    xref,
    triSource: outTri,
    pages,
    texelSize: ts,
    charts: charts.length,
  };
  if (mesh.faceIds) {
    const f = mesh.faceIds;
    result.faceIds = Int32Array.from(outTri, (t) => f[t]!);
  }
  return result;
}

/** Rotation angle (radians) that gives the point set its smallest axis-aligned bounding rectangle. */
function minAreaRectAngle(xs: Float64Array, ys: Float64Array): number {
  const hull = convexHull(xs, ys);
  const h = hull.length / 2;
  if (h < 3) {
    if (h === 2) return -Math.atan2(hull[3]! - hull[1]!, hull[2]! - hull[0]!);
    return 0;
  }
  const areaAt = (a: number) => {
    const c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < h; i++) {
      const x = hull[i * 2]! * c + hull[i * 2 + 1]! * s;
      const y = -hull[i * 2]! * s + hull[i * 2 + 1]! * c;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return (x1 - x0) * (y1 - y0);
  };
  // The best rectangle has a side along a hull edge. Large hulls: sample angles instead.
  const candidates: number[] = [];
  if (h <= 256) {
    for (let i = 0; i < h; i++) {
      const j = (i + 1) % h;
      candidates.push(Math.atan2(hull[j * 2 + 1]! - hull[i * 2 + 1]!, hull[j * 2]! - hull[i * 2]!));
    }
  } else {
    for (let k = 0; k < 180; k++) candidates.push((k / 180) * (Math.PI / 2));
  }
  let best = 0, bestArea = Infinity;
  for (const a of candidates) {
    const ar = areaAt(a);
    if (ar < bestArea - 1e-9) {
      bestArea = ar;
      best = a;
    }
  }
  return best;
}

/** Andrew's monotone chain. Returns hull vertices as x,y pairs, counter-clockwise. */
function convexHull(xs: Float64Array, ys: Float64Array): Float64Array {
  const n = xs.length;
  const idx = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a]! - xs[b]! || ys[a]! - ys[b]!);
  const out = new Uint32Array(2 * n + 1);
  let k = 0;
  const cross = (o: number, a: number, b: number) =>
    (xs[a]! - xs[o]!) * (ys[b]! - ys[o]!) - (ys[a]! - ys[o]!) * (xs[b]! - xs[o]!);
  for (let i = 0; i < n; i++) {
    while (k >= 2 && cross(out[k - 2]!, out[k - 1]!, idx[i]!) <= 0) k--;
    out[k++] = idx[i]!;
  }
  for (let i = n - 2, lo = k + 1; i >= 0; i--) {
    while (k >= lo && cross(out[k - 2]!, out[k - 1]!, idx[i]!) <= 0) k--;
    out[k++] = idx[i]!;
  }
  const m = Math.max(0, k - 1);
  const hull = new Float64Array(m * 2);
  for (let i = 0; i < m; i++) {
    hull[i * 2] = xs[out[i]!]!;
    hull[i * 2 + 1] = ys[out[i]!]!;
  }
  return hull;
}

/** Total triangle area in source units². */
export function surfaceArea(mesh: IndexedMesh): number {
  const P = mesh.positions, I = mesh.indices;
  let sum = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return sum;
}

/** Default paint resolution: 0.1 mm per texel. */
export const DEFAULT_TEXEL_MM = 0.1;
/** Above this many texels the resolution is coarsened so memory stays reasonable (~2 full 8192² pages). */
export const MAX_TEXELS = 128 * 1024 * 1024;

/**
 * Picks the texel size (mm) for a surface: the requested size unless the surface
 * would need more than MAX_TEXELS (packing overhead included), then the next coarser
 * "nice" step.
 */
export function chooseTexelMm(areaMm2: number, requestedMm = DEFAULT_TEXEL_MM): number {
  const steps = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 5];
  const fits = (mm: number) => (areaMm2 * 1.6) / (mm * mm) <= MAX_TEXELS;
  if (fits(requestedMm)) return requestedMm;
  for (const s of steps) if (s > requestedMm && fits(s)) return s;
  return Math.sqrt((areaMm2 * 1.6) / MAX_TEXELS);
}
