// Boundary tracing for export: turns one chart's slot map into smooth boundary
// curves between slots.
//
// 1. Label image: every texel the chart's triangles cover (the same conservative
//    coverage the brush paints) takes its slot (0 = unpainted counts as slot 1).
//    Uncovered texels around the chart take the nearest covered texel's slot, out to
//    a margin. Boundaries then run straight on past the chart's outline instead of
//    following it, so smoothing can't pull a sliver of the wrong slot into the chart.
// 2. Multi-label marching squares on the texel-centre lattice: a segment between edge
//    midpoints where two slots meet, or segments to the cell centre where three or
//    four meet (or a 2-slot saddle). Each segment knows the slot on either side.
// 3. Segments are linked into chains between junctions, then smoothed: RDP to a
//    tolerance (removes the texel staircase), then two rounds of Chaikin corner
//    cutting with the cut capped in length, so big shapes keep their corners.
//
// Pure TS, no DOM: runs in a worker.

import { RASTER_REACH, type PaintAtlas } from '../atlas';
import { closestOnTriangle } from '../paint';

/** Boundary segments in page texel coordinates. Slot `left` lies to the left of a→b. */
export interface BoundaryGraph {
  x: Float64Array;
  y: Float64Array;
  a: Uint32Array;
  b: Uint32Array;
  left: Uint8Array;
  right: Uint8Array;
  segments: number;
}

export interface TraceOptions {
  /** RDP tolerance in texels; 0 keeps the raw marching-squares outline. */
  epsilon: number;
  /** Longest Chaikin corner cut, in texels. */
  cornerCap: number;
  /** Texels of label extension around the chart. */
  margin: number;
}

export interface ChartTrace {
  /** Set when the whole chart is one slot (no boundaries). */
  uniform: number | null;
  graph: BoundaryGraph | null;
  /** Label image (page texel x = ox + i), -1 = unknown. */
  lab: Int8Array;
  ox: number;
  oy: number;
  w: number;
  h: number;
}

export function traceOptions(smoothTexels: number): TraceOptions {
  const epsilon = smoothTexels > 0 ? Math.max(0.55, smoothTexels) : 0;
  const cornerCap = epsilon > 0 ? Math.max(1, 2 * epsilon) : 0;
  return { epsilon, cornerCap, margin: Math.ceil(searchRadius({ epsilon, cornerCap, margin: 0 })) + 3 };
}

/** Beyond this distance from every boundary, a texel's own slot is the region's slot. */
export function searchRadius(o: TraceOptions): number {
  return o.epsilon + o.cornerCap + 2;
}

/** Bounding rectangle (in texels) of some paint triangles' UVs. */
function uvBounds(atlas: PaintAtlas, tris: ArrayLike<number>): [number, number, number, number] {
  const I = atlas.indices, U = atlas.uvs;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let n = 0; n < tris.length; n++) {
    const t = tris[n]!;
    for (let k = 0; k < 3; k++) {
      const p = I[t * 3 + k]! * 2;
      const u = U[p]!, v = U[p + 1]!;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  }
  return [u0, v0, u1, v1];
}

/** Traces the slot boundaries of one chart (a set of paint triangles on one page). */
export function traceChart(
  atlas: PaintAtlas,
  map: Uint8Array,
  page: number,
  tris: ArrayLike<number>,
  opts: TraceOptions,
): ChartTrace {
  const W = atlas.pages[page]!.width, H = atlas.pages[page]!.height;
  const [u0, v0, u1, v1] = uvBounds(atlas, tris);

  // Fast path: every texel the chart could cover holds the same slot.
  {
    const x0 = Math.max(0, Math.floor(u0) - 1), x1 = Math.min(W - 1, Math.ceil(u1) + 1);
    const y0 = Math.max(0, Math.floor(v0) - 1), y1 = Math.min(H - 1, Math.ceil(v1) + 1);
    const first = map[y0 * W + x0]! || 1;
    let same = true;
    for (let y = y0; y <= y1 && same; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        if ((map[row + x]! || 1) !== first) {
          same = false;
          break;
        }
      }
    }
    if (same) return { uniform: first, graph: null, lab: new Int8Array(0), ox: 0, oy: 0, w: 0, h: 0 };
  }

  const M = opts.margin;
  const ox = Math.floor(u0) - M, oy = Math.floor(v0) - M;
  const w = Math.ceil(u1) + M + 1 - ox, h = Math.ceil(v1) + M + 1 - oy;
  const lab = new Int8Array(w * h).fill(-1);

  // 1. Coverage, exactly as the brush rasterizes.
  const I = atlas.indices, U = atlas.uvs;
  const reach2 = RASTER_REACH * RASTER_REACH;
  let lo = 255, hi = 0;
  for (let n = 0; n < tris.length; n++) {
    const t = tris[n]!;
    const ua = U[I[t * 3]! * 2]!, va = U[I[t * 3]! * 2 + 1]!;
    const ub = U[I[t * 3 + 1]! * 2]!, vb = U[I[t * 3 + 1]! * 2 + 1]!;
    const uc = U[I[t * 3 + 2]! * 2]!, vc = U[I[t * 3 + 2]! * 2 + 1]!;
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const x0 = Math.max(0, Math.ceil(Math.min(ua, ub, uc) - RASTER_REACH - 0.5));
    const x1 = Math.min(W - 1, Math.floor(Math.max(ua, ub, uc) + RASTER_REACH - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(va, vb, vc) - RASTER_REACH - 0.5));
    const y1 = Math.min(H - 1, Math.floor(Math.max(va, vb, vc) + RASTER_REACH - 0.5));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const li = (y - oy) * w + (x - ox);
        if (lab[li]! >= 0) continue;
        const cx = x + 0.5;
        const lb = ((cx - ua) * (vc - va) - (uc - ua) * (cy - va)) * inv;
        const lc = ((ub - ua) * (cy - va) - (cx - ua) * (vb - va)) * inv;
        if (lb < 0 || lc < 0 || lb + lc > 1) {
          const q = closestOnTriangle(cx, cy, ua, va, ub, vb, uc, vc);
          if ((q[0] - cx) ** 2 + (q[1] - cy) ** 2 > reach2) continue;
        }
        const s = map[y * W + x]! || 1;
        lab[li] = s;
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
    }
  }
  if (lo >= hi) return { uniform: hi || 1, graph: null, lab: new Int8Array(0), ox: 0, oy: 0, w: 0, h: 0 };

  // 2. Extend labels outward (two-pass chamfer distance, weights 2/3), out to the margin.
  extendLabels(lab, w, h, 2 * M);

  // 3. Marching squares.
  const raw = marchingSquares(lab, w, h, ox, oy);

  // 4. Chains and smoothing.
  const graph = smoothGraph(raw, opts);
  return { uniform: null, graph, lab, ox, oy, w, h };
}

function extendLabels(lab: Int8Array, w: number, h: number, maxDist: number): void {
  const dist = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < lab.length; i++) if (lab[i]! >= 0) dist[i] = 0;
  const relax = (i: number, j: number, wgt: number) => {
    const d = dist[j]! + wgt;
    if (d < dist[i]!) {
      dist[i] = d;
      lab[i] = lab[j]!;
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      if (x > 0) relax(i, i - 1, 2);
      if (y > 0) {
        relax(i, i - w, 2);
        if (x > 0) relax(i, i - w - 1, 3);
        if (x < w - 1) relax(i, i - w + 1, 3);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      if (x < w - 1) relax(i, i + 1, 2);
      if (y < h - 1) {
        relax(i, i + w, 2);
        if (x < w - 1) relax(i, i + w + 1, 3);
        if (x > 0) relax(i, i + w - 1, 3);
      }
    }
  }
  for (let i = 0; i < lab.length; i++) if (dist[i]! > maxDist) lab[i] = -1;
}

interface RawGraph {
  x: number[];
  y: number[];
  a: number[];
  b: number[];
  left: number[];
  right: number[];
}

function marchingSquares(lab: Int8Array, w: number, h: number, ox: number, oy: number): RawGraph {
  const g: RawGraph = { x: [], y: [], a: [], b: [], left: [], right: [] };
  const ids = new Map<number, number>();
  const vert = (key: number, x: number, y: number) => {
    let v = ids.get(key);
    if (v === undefined) {
      v = g.x.length;
      ids.set(key, v);
      g.x.push(x + ox);
      g.y.push(y + oy);
    }
    return v;
  };
  const c = [0, 0, 0, 0];
  const cx = [0.5, 1.5, 1.5, 0.5], cy = [0.5, 0.5, 1.5, 1.5];
  // Edge k runs from corner k to corner k+1; midpoint offsets within the cell.
  const mx = [1, 1.5, 1, 0.5], my = [0.5, 1, 1.5, 1];
  const diff: number[] = [];
  const centreBase = 2 * w * h;

  const emit = (pv: number, px: number, py: number, qv: number, qx: number, qy: number, kx: number, ky: number, kLabel: number, other: number) => {
    if (kLabel < 0 || other < 0) return; // beyond the extension margin
    const side = (qx - px) * (ky - py) - (qy - py) * (kx - px);
    g.a.push(pv);
    g.b.push(qv);
    if (side > 0) {
      g.left.push(kLabel);
      g.right.push(other);
    } else {
      g.left.push(other);
      g.right.push(kLabel);
    }
  };

  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const p = j * w + i;
      c[0] = lab[p]!;
      c[1] = lab[p + 1]!;
      c[2] = lab[p + w + 1]!;
      c[3] = lab[p + w]!;
      if (c[0] === c[1] && c[1] === c[2] && c[2] === c[3]) continue;
      diff.length = 0;
      for (let k = 0; k < 4; k++) if (c[k] !== c[(k + 1) & 3]) diff.push(k);
      const keys = [2 * p, 2 * (p + 1) + 1, 2 * (p + w), 2 * p + 1];
      const mid = (k: number) => vert(keys[k]!, i + mx[k]!, j + my[k]!);
      if (diff.length === 2) {
        const ea = diff[0]!, eb = diff[1]!;
        const k = (ea + 1) & 3;
        emit(mid(ea), i + mx[ea]!, j + my[ea]!, mid(eb), i + mx[eb]!, j + my[eb]!, i + cx[k]!, j + cy[k]!, c[k]!, c[ea]!);
      } else {
        const cv = vert(centreBase + p, i + 1, j + 1);
        for (const k of diff) {
          emit(mid(k), i + mx[k]!, j + my[k]!, cv, i + 1, j + 1, i + cx[k]!, j + cy[k]!, c[k]!, c[(k + 1) & 3]!);
        }
      }
    }
  }
  return g;
}

/** Links segments into chains between junctions and smooths each chain. */
function smoothGraph(raw: RawGraph, opts: TraceOptions): BoundaryGraph {
  const V = raw.x.length, S = raw.a.length;
  const deg = new Uint32Array(V);
  for (let s = 0; s < S; s++) {
    deg[raw.a[s]!]!++;
    deg[raw.b[s]!]!++;
  }
  const start = new Uint32Array(V + 1);
  for (let v = 0; v < V; v++) start[v + 1] = start[v]! + deg[v]!;
  const inc = new Uint32Array(2 * S);
  const fill = start.slice(0, V);
  for (let s = 0; s < S; s++) {
    inc[fill[raw.a[s]!]!++] = s;
    inc[fill[raw.b[s]!]!++] = s;
  }

  const x: number[] = [], y: number[] = [];
  const outA: number[] = [], outB: number[] = [], outL: number[] = [], outR: number[] = [];
  // Junction and end vertices keep one shared output vertex.
  const keep = new Int32Array(V).fill(-1);
  const keepVertex = (v: number) => {
    if (keep[v]! < 0) {
      keep[v] = x.length;
      x.push(raw.x[v]!);
      y.push(raw.y[v]!);
    }
    return keep[v]!;
  };
  const used = new Uint8Array(S);
  const px: number[] = [], py: number[] = [];

  const walk = (v0: number, s0: number, closed: boolean) => {
    px.length = 0;
    py.length = 0;
    let v = v0, s = s0;
    const forward = raw.a[s] === v;
    const L = forward ? raw.left[s]! : raw.right[s]!;
    const R = forward ? raw.right[s]! : raw.left[s]!;
    px.push(raw.x[v]!);
    py.push(raw.y[v]!);
    for (;;) {
      used[s] = 1;
      const u = raw.a[s] === v ? raw.b[s]! : raw.a[s]!;
      px.push(raw.x[u]!);
      py.push(raw.y[u]!);
      v = u;
      if (closed ? v === v0 : deg[v] !== 2) break;
      let next = -1;
      for (let q = start[v]!; q < start[v + 1]!; q++) if (!used[inc[q]!]) next = inc[q]!;
      if (next < 0) break;
      s = next;
    }
    const endV = v;
    const pts = smoothChain(px, py, closed, opts);
    if (closed) {
      if (pts.length < 6) return; // collapsed loop
      const n = pts.length / 2;
      const base = x.length;
      for (let i = 0; i < n; i++) {
        x.push(pts[i * 2]!);
        y.push(pts[i * 2 + 1]!);
      }
      for (let i = 0; i < n; i++) {
        outA.push(base + i);
        outB.push(base + ((i + 1) % n));
        outL.push(L);
        outR.push(R);
      }
      return;
    }
    const n = pts.length / 2;
    const first = keepVertex(v0), last = keepVertex(endV);
    let prev = first;
    for (let i = 1; i < n; i++) {
      let cur: number;
      if (i === n - 1) cur = last;
      else {
        cur = x.length;
        x.push(pts[i * 2]!);
        y.push(pts[i * 2 + 1]!);
      }
      if (cur !== prev) {
        outA.push(prev);
        outB.push(cur);
        outL.push(L);
        outR.push(R);
      }
      prev = cur;
    }
  };

  for (let v = 0; v < V; v++) {
    if (deg[v] === 2) continue;
    for (let q = start[v]!; q < start[v + 1]!; q++) if (!used[inc[q]!]) walk(v, inc[q]!, false);
  }
  for (let s = 0; s < S; s++) if (!used[s]) walk(raw.a[s]!, s, true);

  return {
    x: Float64Array.from(x),
    y: Float64Array.from(y),
    a: Uint32Array.from(outA),
    b: Uint32Array.from(outB),
    left: Uint8Array.from(outL),
    right: Uint8Array.from(outR),
    segments: outA.length,
  };
}

/**
 * Smooths one chain (closed chains repeat the first point at the end). Returns x,y
 * pairs; open chains keep their end points exactly, closed ones drop the repeat.
 */
export function smoothChain(px: number[], py: number[], closed: boolean, opts: TraceOptions): number[] {
  let n = px.length;
  if (closed) n--; // drop the repeated start
  if (opts.epsilon <= 0) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(px[i]!, py[i]!);
    if (!closed) out.push(px[n]!, py[n]!);
    return out;
  }
  // RDP. Closed chains are split at the point farthest from the start.
  let keepIdx: number[];
  if (closed) {
    let far = 0, best = -1;
    for (let i = 1; i < n; i++) {
      const d = (px[i]! - px[0]!) ** 2 + (py[i]! - py[0]!) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const a = rdp(px, py, 0, far, opts.epsilon);
    const b = rdp(px, py, far, n, opts.epsilon, true);
    keepIdx = [...a, ...b.slice(1, -1)];
  } else {
    keepIdx = rdp(px, py, 0, n - 1, opts.epsilon);
  }
  let pts: number[] = [];
  for (const i of keepIdx) pts.push(px[i % n]!, py[i % n]!);
  // Capped Chaikin, two rounds.
  for (let round = 0; round < 2; round++) pts = chaikin(pts, closed, opts.cornerCap);
  return pts;
}

/**
 * Ramer–Douglas–Peucker over indices i0..i1 (inclusive). With `wrap`, index i1 = n
 * stands for point 0. Iterative, so long chains can't overflow the stack.
 */
function rdp(px: number[], py: number[], i0: number, i1: number, eps: number, wrap = false): number[] {
  const n = px.length - 1;
  const X = (i: number) => px[wrap && i === n ? 0 : i]!;
  const Y = (i: number) => py[wrap && i === n ? 0 : i]!;
  const keep = new Uint8Array(i1 - i0 + 1);
  keep[0] = 1;
  keep[i1 - i0] = 1;
  const stack = [i0, i1];
  const eps2 = eps * eps;
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    if (b - a < 2) continue;
    const ax = X(a), ay = Y(a), dx = X(b) - ax, dy = Y(b) - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const qx = X(i) - ax, qy = Y(i) - ay;
      let d: number;
      if (l2 === 0) d = qx * qx + qy * qy;
      else {
        const cr = qx * dy - qy * dx;
        d = (cr * cr) / l2;
        const t = (qx * dx + qy * dy) / l2;
        if (t < 0) d = qx * qx + qy * qy;
        else if (t > 1) d = (X(i) - X(b)) ** 2 + (Y(i) - Y(b)) ** 2;
      }
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (worst > eps2) {
      keep[wi - i0] = 1;
      stack.push(a, wi, wi, b);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(i0 + i);
  return out;
}

function chaikin(pts: number[], closed: boolean, cap: number): number[] {
  const n = pts.length / 2;
  if (n < 3 && !closed) return pts;
  const out: number[] = [];
  const segs = closed ? n : n - 1;
  if (!closed) out.push(pts[0]!, pts[1]!);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2]!, ay = pts[i * 2 + 1]!, bx = pts[j * 2]!, by = pts[j * 2 + 1]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const f = Math.min(0.25, cap / len);
    if (closed || i > 0) out.push(ax + f * (bx - ax), ay + f * (by - ay));
    if (closed || i < segs - 1) out.push(bx - f * (bx - ax), by - f * (by - ay));
  }
  if (!closed) out.push(pts[(n - 1) * 2]!, pts[(n - 1) * 2 + 1]!);
  return out;
}
