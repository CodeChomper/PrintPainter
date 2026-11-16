// Export cutting: splits an object's mesh along its (smoothed) paint boundaries so
// every output triangle has exactly one slot.
//
// Pass 1, per chart: trace the boundaries (trace.ts) and clip them to each triangle
//   in the chart's texel space. Clipped ends on a triangle edge are recorded as a
//   parameter t along that mesh edge, measured from its lower-numbered vertex.
// Pass 2, per mesh edge: merge the t values from every triangle that uses the edge
//   (both sides of a chart seam trace their own curves, so they can differ slightly).
//   Each merged point becomes one shared output vertex.
// Pass 3, per triangle with boundaries or edge points: constrained Delaunay
//   triangulation (cdt2d) of the corners, every edge point and the clipped curves,
//   done in a reference triangle (0,0) (1,0) (1,1) where points on all three edges
//   are exactly collinear. Each piece takes the slot on its side of the nearest
//   curve (labels.ts).
//
// Because neighbours always see the same edge points, the result is watertight
// whenever the input is, including across seams.
//
// Pure TS, no DOM: runs in a worker.

import cdt2d from 'cdt2d';
import type { PaintAtlas } from '../atlas';
import { analyzeEdges } from '../cleanup';
import type { IndexedMesh } from '../mesh';
import { triPages } from '../paint';
import { labelAt, SegmentIndex, type SegmentSet } from './labels';
import { searchRadius, traceChart, traceOptions } from './trace';

export interface CutOptions {
  /** Boundary smoothing tolerance in mm; 0 = no smoothing (texel outline). */
  smoothMm: number;
  /** Texel edge in mm (the atlas's texel size converted to mm). */
  texelMm: number;
  onProgress?: (fraction: number) => void;
}

export interface CutStats {
  sourceTriangles: number;
  triangles: number;
  /** Source triangles that were split. */
  cutTriangles: number;
  /** Triangles where triangulation failed and a simple fan was used instead. */
  fallbacks: number;
  /** Zero-area output triangles (should be 0). */
  degenerate: number;
  sourceWatertight: boolean;
  watertight: boolean;
  openEdges: number;
  nonManifoldEdges: number;
  /** Triangle count per slot (index 1..16). */
  slotTriangles: number[];
}

export interface CutMesh {
  /** Source units, like the input mesh. */
  positions: Float64Array;
  indices: Uint32Array;
  /** Slot (1..16) per triangle. */
  slots: Uint8Array;
  stats: CutStats;
}

/** Points closer than this (texels) to a triangle edge count as on it. */
const ON_EDGE = 1e-3;

interface End {
  /** 0..2 = on that edge, 3..5 = corner (kind - 3), -1 = inside. */
  kind: number;
  /** Canonical parameter along the edge (edge points only). */
  t: number;
  /** Chart vertex id (inside points only). */
  id: number;
  u: number;
  v: number;
}

interface Piece {
  a: End;
  b: End;
  left: number;
  right: number;
}

interface CutTri {
  paint: number;
  pieces: Piece[];
}

const edgeMask = (e: End) => (e.kind < 0 ? 0 : e.kind < 3 ? 1 << e.kind : (1 << (e.kind - 3)) | (1 << ((e.kind - 1) % 3)));

export function cutMesh(mesh: IndexedMesh, atlas: PaintAtlas, maps: Uint8Array[], opts: CutOptions): CutMesh {
  const SI = mesh.indices, SP = mesh.positions;
  const T = SI.length / 3, V = SP.length / 3;
  const I = atlas.indices, U = atlas.uvs;
  const PT = I.length / 3;
  const topt = traceOptions(opts.smoothMm / opts.texelMm);
  const R = searchRadius(topt);
  const pageOf = triPages(atlas);
  const paintOf = new Int32Array(T).fill(-1);
  atlas.triSource.forEach((s, t) => (paintOf[s] = t));

  const uniform = new Uint8Array(T).fill(1);
  const cut = new Map<number, CutTri>();
  const edgeTs = new Map<number, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? a * V + b : b * V + a);

  // --- Pass 1: charts ----------------------------------------------------------
  const charts = chartsOf(atlas);
  let done = 0;
  for (const tris of charts) {
    const page = pageOf[tris[0]!]!;
    const tr = traceChart(atlas, maps[page]!, page, tris, topt);
    done += tris.length;
    opts.onProgress?.((0.8 * done) / PT);
    if (tr.uniform !== null || !tr.graph || !tr.graph.segments) {
      const u = tr.uniform ?? 1;
      for (const t of tris) uniform[atlas.triSource[t]!] = u;
      continue;
    }
    const index = new SegmentIndex(tr.graph, tr.ox, tr.oy, tr.w, tr.h);
    const sample = (x: number, y: number) => {
      const near = index.labelNear(x, y, R);
      if (near >= 0) return near;
      const i = Math.min(tr.w - 1, Math.max(0, Math.floor(x) - tr.ox));
      const j = Math.min(tr.h - 1, Math.max(0, Math.floor(y) - tr.oy));
      const l = tr.lab[j * tr.w + i]!;
      return l > 0 ? l : 1;
    };

    for (const t of tris) {
      const ts = atlas.triSource[t]!;
      const S = [SI[ts * 3]!, SI[ts * 3 + 1]!, SI[ts * 3 + 2]!];
      const uu = [U[I[t * 3]! * 2]!, U[I[t * 3 + 1]! * 2]!, U[I[t * 3 + 2]! * 2]!];
      const vv = [U[I[t * 3]! * 2 + 1]!, U[I[t * 3 + 1]! * 2 + 1]!, U[I[t * 3 + 2]! * 2 + 1]!];
      uniform[ts] = sample((uu[0]! + uu[1]! + uu[2]!) / 3, (vv[0]! + vv[1]! + vv[2]!) / 3);
      const det = (uu[1]! - uu[0]!) * (vv[2]! - vv[0]!) - (uu[2]! - uu[0]!) * (vv[1]! - vv[0]!);
      if (Math.abs(det) < 1e-9) continue;
      const sigma = det > 0 ? 1 : -1;
      const len = [0, 1, 2].map((k) => Math.hypot(uu[(k + 1) % 3]! - uu[k]!, vv[(k + 1) % 3]! - vv[k]!));
      const dist = (k: number, x: number, y: number) => {
        const k1 = (k + 1) % 3;
        return (sigma * ((uu[k1]! - uu[k]!) * (y - vv[k]!) - (vv[k1]! - vv[k]!) * (x - uu[k]!))) / len[k]!;
      };
      const onEdge = (k: number, x: number, y: number): End => {
        const k1 = (k + 1) % 3;
        const [cs, ce] = S[k]! < S[k1]! ? [k, k1] : [k1, k];
        const dx = uu[ce]! - uu[cs]!, dy = vv[ce]! - vv[cs]!;
        const L = len[k]!;
        let tt = ((x - uu[cs]!) * dx + (y - vv[cs]!) * dy) / (L * L);
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        if (tt * L < ON_EDGE) return { kind: 3 + cs, t: 0, id: -1, u: uu[cs]!, v: vv[cs]! };
        if ((1 - tt) * L < ON_EDGE) return { kind: 3 + ce, t: 0, id: -1, u: uu[ce]!, v: vv[ce]! };
        return { kind: k, t: tt, id: -1, u: x, v: y };
      };
      const classify = (id: number, x: number, y: number): End => {
        let mk = 0, md = Infinity;
        for (let k = 0; k < 3; k++) {
          const d = dist(k, x, y);
          if (d < md) {
            md = d;
            mk = k;
          }
        }
        return md < ON_EDGE ? onEdge(mk, x, y) : { kind: -1, t: 0, id, u: x, v: y };
      };

      const umin = Math.min(...uu) - ON_EDGE, umax = Math.max(...uu) + ON_EDGE;
      const vmin = Math.min(...vv) - ON_EDGE, vmax = Math.max(...vv) + ON_EDGE;
      const [cand, n] = index.query(umin, vmin, umax, vmax);
      const pieces: Piece[] = [];
      for (let q = 0; q < n; q++) {
        const s = cand[q]!;
        const ax = index.ax[s]!, ay = index.ay[s]!, bx = index.bx[s]!, by = index.by[s]!;
        if (Math.max(ax, bx) < umin || Math.min(ax, bx) > umax || Math.max(ay, by) < vmin || Math.min(ay, by) > vmax) continue;
        let sIn = 0, sOut = 1, kIn = -1, kOut = -1, reject = false;
        for (let k = 0; k < 3; k++) {
          const da = dist(k, ax, ay), db = dist(k, bx, by);
          if (da < 0 && db < 0) {
            reject = true;
            break;
          }
          if (da < 0) {
            const sp = da / (da - db);
            if (sp > sIn) {
              sIn = sp;
              kIn = k;
            }
          } else if (db < 0) {
            const sp = da / (da - db);
            if (sp < sOut) {
              sOut = sp;
              kOut = k;
            }
          }
        }
        if (reject || sIn >= sOut) continue;
        const px = ax + sIn * (bx - ax), py = ay + sIn * (by - ay);
        const qx = ax + sOut * (bx - ax), qy = ay + sOut * (by - ay);
        if (Math.hypot(qx - px, qy - py) < ON_EDGE) continue;
        const a = kIn >= 0 ? onEdge(kIn, px, py) : classify(index.aId[s]!, px, py);
        const b = kOut >= 0 ? onEdge(kOut, qx, qy) : classify(index.bId[s]!, qx, qy);
        if (edgeMask(a) & edgeMask(b)) continue; // runs along an edge
        pieces.push({ a, b, left: index.left[s]!, right: index.right[s]! });
      }
      if (!pieces.length) continue;
      cut.set(ts, { paint: t, pieces });
      for (const p of pieces) {
        for (const e of [p.a, p.b]) {
          if (e.kind < 0 || e.kind > 2) continue;
          const key = edgeKey(S[e.kind]!, S[(e.kind + 1) % 3]!);
          const list = edgeTs.get(key);
          if (list) list.push(e.t);
          else edgeTs.set(key, [e.t]);
        }
      }
    }
  }

  // --- Pass 2: shared edge points ---------------------------------------------
  const pos: number[] = Array.from(SP);
  let nextId = V;
  const edgePts = new Map<number, { t: Float64Array; id: Uint32Array }>();
  for (const [key, list] of edgeTs) {
    const a = Math.floor(key / V), b = key - a * V;
    const len3 = Math.hypot(SP[b * 3]! - SP[a * 3]!, SP[b * 3 + 1]! - SP[a * 3 + 1]!, SP[b * 3 + 2]! - SP[a * 3 + 2]!);
    const tol = len3 > 0 ? (ON_EDGE * atlas.texelSize) / len3 : 1;
    list.sort((x, y) => x - y);
    const kept: number[] = [];
    for (const t of list) {
      if (t < tol || t > 1 - tol) continue;
      if (kept.length && t - kept[kept.length - 1]! < tol) continue;
      kept.push(t);
    }
    if (!kept.length) continue;
    const ids = new Uint32Array(kept.length);
    kept.forEach((t, i) => {
      ids[i] = nextId++;
      for (let c = 0; c < 3; c++) pos.push(SP[a * 3 + c]! + t * (SP[b * 3 + c]! - SP[a * 3 + c]!));
    });
    edgePts.set(key, { t: Float64Array.from(kept), id: ids });
  }

  // --- Pass 3: triangulate ----------------------------------------------------
  const outIdx: number[] = [];
  const outSlot: number[] = [];
  let fallbacks = 0, degenerate = 0;
  for (let ts = 0; ts < T; ts++) {
    if (ts % 4096 === 0) opts.onProgress?.(0.8 + (0.2 * ts) / T);
    const S = [SI[ts * 3]!, SI[ts * 3 + 1]!, SI[ts * 3 + 2]!];
    const ce = cut.get(ts);
    const e0 = edgePts.get(edgeKey(S[0]!, S[1]!)), e1 = edgePts.get(edgeKey(S[1]!, S[2]!)), e2 = edgePts.get(edgeKey(S[2]!, S[0]!));
    if (!ce && !e0 && !e1 && !e2) {
      outIdx.push(S[0]!, S[1]!, S[2]!);
      outSlot.push(uniform[ts]!);
      continue;
    }
    const r = triangulate(S, [e0, e1, e2], ce, atlas, uniform[ts]!, SP, pos, () => nextId++);
    if (r.fallback) fallbacks++;
    degenerate += r.degenerate;
    for (let i = 0; i < r.tris.length; i++) outIdx.push(r.tris[i]!);
    for (let i = 0; i < r.slots.length; i++) outSlot.push(r.slots[i]!);
  }

  // Drop unreferenced vertices.
  const remap = new Int32Array(nextId).fill(-1);
  let nv = 0;
  const indices = new Uint32Array(outIdx.length);
  const positions: number[] = [];
  for (let i = 0; i < outIdx.length; i++) {
    const v = outIdx[i]!;
    if (remap[v]! < 0) {
      remap[v] = nv++;
      positions.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    }
    indices[i] = remap[v]!;
  }
  const slots = Uint8Array.from(outSlot);
  const src = analyzeEdges(SI, V);
  const res = analyzeEdges(indices, nv);
  const slotTriangles = new Array<number>(17).fill(0);
  for (const s of slots) slotTriangles[s]!++;
  opts.onProgress?.(1);
  return {
    positions: Float64Array.from(positions),
    indices,
    slots,
    stats: {
      sourceTriangles: T,
      triangles: slots.length,
      cutTriangles: cut.size,
      fallbacks,
      degenerate,
      sourceWatertight: !src.open.length && !src.nonManifold.length && !src.inconsistent,
      watertight: !res.open.length && !res.nonManifold.length && !res.inconsistent,
      openEdges: res.open.length,
      nonManifoldEdges: res.nonManifold.length,
      slotTriangles,
    },
  };
}

/** Paint triangles grouped by chart (charts never share paint vertices). */
function chartsOf(atlas: PaintAtlas): number[][] {
  const I = atlas.indices;
  const nv = atlas.uvs.length / 2;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const T = I.length / 3;
  for (let t = 0; t < T; t++) {
    union(I[t * 3]!, I[t * 3 + 1]!);
    union(I[t * 3]!, I[t * 3 + 2]!);
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    const r = find(I[t * 3]!);
    const g = groups.get(r);
    if (g) g.push(t);
    else groups.set(r, [t]);
  }
  return [...groups.values()];
}

interface TriResult {
  tris: number[];
  slots: number[];
  fallback: boolean;
  degenerate: number;
}

/** Binary search: index of the value in sorted `a` closest to x. */
function nearest(a: Float64Array, x: number): number {
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(a[hi]! - x) < Math.abs(a[lo]! - x) ? hi : lo;
}

function triangulate(
  S: number[],
  edges: ({ t: Float64Array; id: Uint32Array } | undefined)[],
  ce: CutTri | undefined,
  atlas: PaintAtlas,
  uniformSlot: number,
  SP: Float32Array,
  pos: number[],
  newId: () => number,
): TriResult {
  // Reference triangle: corner 0 = (0,0), 1 = (1,0), 2 = (1,1).
  const px: number[] = [], py: number[] = [];
  const gid: number[] = []; // global vertex id, -1 = inside point (allocated on output)
  const cornerLocal = [0, 0, 0];
  const edgeLocal: number[][] = [[], [], []];
  const boundary: number[] = [];
  const add = (x: number, y: number, g: number) => {
    px.push(x);
    py.push(y);
    gid.push(g);
    return px.length - 1;
  };
  const CX = [0, 1, 1], CY = [0, 0, 1];
  for (let k = 0; k < 3; k++) {
    cornerLocal[k] = add(CX[k]!, CY[k]!, S[k]!);
    boundary.push(cornerLocal[k]!);
    const e = edges[k];
    if (!e) continue;
    const forward = S[k]! < S[(k + 1) % 3]!;
    const n = e.t.length;
    edgeLocal[k] = new Array<number>(n);
    for (let q = 0; q < n; q++) {
      const i = forward ? q : n - 1 - q;
      const s = forward ? e.t[i]! : 1 - e.t[i]!;
      const x = k === 0 ? s : k === 1 ? 1 : 1 - s;
      const y = k === 0 ? 0 : k === 1 ? s : 1 - s;
      const l = add(x, y, e.id[i]!);
      edgeLocal[k]![i] = l;
      boundary.push(l);
    }
  }
  const nB = px.length;

  // Clipped curves, in reference coordinates.
  const sa: number[] = [], sb: number[] = [], sl: number[] = [], sr: number[] = [];
  if (ce) {
    const t = ce.paint;
    const I = atlas.indices, U = atlas.uvs;
    const ua = U[I[t * 3]! * 2]!, va = U[I[t * 3]! * 2 + 1]!;
    const ub = U[I[t * 3 + 1]! * 2]!, vb = U[I[t * 3 + 1]! * 2 + 1]!;
    const uc = U[I[t * 3 + 2]! * 2]!, vc = U[I[t * 3 + 2]! * 2 + 1]!;
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    const flip = det < 0;
    const inside = new Map<number, number>();
    const local = (e: End): number => {
      if (e.kind >= 3) return cornerLocal[e.kind - 3]!;
      if (e.kind >= 0) {
        const ep = edges[e.kind]!;
        return edgeLocal[e.kind]![nearest(ep.t, e.t)]!;
      }
      const have = inside.get(e.id);
      if (have !== undefined) return have;
      let l1 = ((e.u - ua) * (vc - va) - (uc - ua) * (e.v - va)) / det;
      let l2 = ((ub - ua) * (e.v - va) - (e.u - ua) * (vb - va)) / det;
      l1 = Math.max(1e-9, l1);
      l2 = Math.max(1e-9, l2);
      const sum = l1 + l2;
      if (sum > 1 - 1e-9) {
        l1 *= (1 - 1e-9) / sum;
        l2 *= (1 - 1e-9) / sum;
      }
      const l = add(l1 + l2, l2, -1);
      inside.set(e.id, l);
      return l;
    };
    const seen = new Set<number>();
    for (const p of ce.pieces) {
      const a = local(p.a), b = local(p.b);
      if (a === b) continue;
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      if (seen.has(key)) continue;
      seen.add(key);
      sa.push(a);
      sb.push(b);
      sl.push(flip ? p.right : p.left);
      sr.push(flip ? p.left : p.right);
    }
    splitCrossings(px, py, gid, sa, sb, sl, sr);
    mergeCoincident(px, py, nB, sa, sb, sl, sr);
  }

  const set: SegmentSet = {
    ax: sa.map((i) => px[i]!),
    ay: sa.map((i) => py[i]!),
    bx: sb.map((i) => px[i]!),
    by: sb.map((i) => py[i]!),
    aId: sa,
    bId: sb,
    left: sl,
    right: sr,
  };
  const all = Uint32Array.from(sa.keys());
  const slotAt = (x: number, y: number) => {
    const l = sa.length ? labelAt(set, all, all.length, x, y) : -1;
    return l > 0 ? l : uniformSlot;
  };

  // Only points some constraint still uses go to the triangulator (merged duplicates don't).
  const used = new Uint8Array(px.length);
  used.fill(1, 0, nB);
  for (let i = 0; i < sa.length; i++) used[sa[i]!] = used[sb[i]!] = 1;
  const toCdt = new Int32Array(px.length).fill(-1);
  const fromCdt: number[] = [];
  for (let i = 0; i < px.length; i++) {
    if (!used[i]) continue;
    toCdt[i] = fromCdt.length;
    fromCdt.push(i);
  }

  // Constraints: the boundary loop plus the curves.
  const cons: [number, number][] = [];
  for (let i = 0; i < nB; i++) cons.push([toCdt[boundary[i]!]!, toCdt[boundary[(i + 1) % nB]!]!]);
  for (let i = 0; i < sa.length; i++) cons.push([toCdt[sa[i]!]!, toCdt[sb[i]!]!]);
  const pts: [number, number][] = fromCdt.map((i) => [px[i]!, py[i]!]);
  const nInside = fromCdt.length - nB;

  let cells: [number, number, number][] | null = null;
  try {
    cells = cdt2d(pts, cons).map(([a, b, c]) => [fromCdt[a]!, fromCdt[b]!, fromCdt[c]!] as [number, number, number]);
    if (cells.length !== nB + 2 * nInside - 2) cells = null;
  } catch {
    cells = null;
  }

  const out: TriResult = { tris: [], slots: [], fallback: false, degenerate: 0 };
  const globalOf = (l: number) => {
    if (gid[l]! < 0) {
      const id = newId();
      gid[l] = id;
      // Reference (x, y) = barycentric (1 - x, x - y, y).
      const b1 = px[l]! - py[l]!, b2 = py[l]!;
      const s0 = S[0]! * 3, s1 = S[1]! * 3, s2 = S[2]! * 3;
      for (let c = 0; c < 3; c++) pos.push(SP[s0 + c]! + b1 * (SP[s1 + c]! - SP[s0 + c]!) + b2 * (SP[s2 + c]! - SP[s0 + c]!));
    }
    return gid[l]!;
  };

  if (!cells) {
    // Fan from the centroid: always valid for a convex polygon.
    out.fallback = true;
    const c = add(2 / 3, 1 / 3, -1);
    const slot = slotAt(2 / 3, 1 / 3);
    for (let i = 0; i < nB; i++) {
      out.tris.push(globalOf(boundary[i]!), globalOf(boundary[(i + 1) % nB]!), globalOf(c));
      out.slots.push(slot);
    }
    return out;
  }
  for (const [a, b, c] of cells) {
    const area = (px[b]! - px[a]!) * (py[c]! - py[a]!) - (px[c]! - px[a]!) * (py[b]! - py[a]!);
    if (area === 0) out.degenerate++;
    const slot = slotAt((px[a]! + px[b]! + px[c]!) / 3, (py[a]! + py[b]! + py[c]!) / 3);
    if (area >= 0) out.tris.push(globalOf(a), globalOf(b), globalOf(c));
    else out.tris.push(globalOf(a), globalOf(c), globalOf(b));
    out.slots.push(slot);
  }
  return out;
}

/**
 * Points at the same spot (two curve ends meeting, or crossings found twice) become one:
 * the triangulator can't take duplicates. Boundary points (index < nB) are never moved;
 * an inside point on top of one joins it. Segments that collapse or repeat are dropped.
 */
function mergeCoincident(px: number[], py: number[], nB: number, sa: number[], sb: number[], sl: number[], sr: number[]): void {
  const EPS = 1e-12;
  const canon = new Int32Array(px.length);
  const byKey = new Map<string, number>();
  const key = (i: number) => `${Math.round(px[i]! / EPS)},${Math.round(py[i]! / EPS)}`;
  for (let i = 0; i < px.length; i++) {
    const k = key(i);
    const have = byKey.get(k);
    if (have === undefined || i < nB) {
      canon[i] = i;
      if (have === undefined) byKey.set(k, i);
    } else canon[i] = have;
  }
  const seen = new Set<number>();
  let w = 0;
  for (let i = 0; i < sa.length; i++) {
    const a = canon[sa[i]!]!, b = canon[sb[i]!]!;
    if (a === b) continue;
    const k = a < b ? a * 1e6 + b : b * 1e6 + a;
    if (seen.has(k)) continue;
    seen.add(k);
    sa[w] = a;
    sb[w] = b;
    sl[w] = sl[i]!;
    sr[w] = sr[i]!;
    w++;
  }
  sa.length = sb.length = sl.length = sr.length = w;
}

/** Splits curve segments where they cross (smoothing can make close curves touch). */
function splitCrossings(px: number[], py: number[], gid: number[], sa: number[], sb: number[], sl: number[], sr: number[]): void {
  const m = sa.length;
  if (m < 2) return;
  const order = Array.from({ length: m }, (_, i) => i).sort((i, j) => Math.min(px[sa[i]!]!, px[sb[i]!]!) - Math.min(px[sa[j]!]!, px[sb[j]!]!));
  const cuts = new Map<number, [number, number][]>();
  const orient = (a: number, b: number, c: number) => (px[b]! - px[a]!) * (py[c]! - py[a]!) - (py[b]! - py[a]!) * (px[c]! - px[a]!);
  for (let oi = 0; oi < m; oi++) {
    const i = order[oi]!;
    const ai = sa[i]!, bi = sb[i]!;
    const maxX = Math.max(px[ai]!, px[bi]!);
    const yi0 = Math.min(py[ai]!, py[bi]!), yi1 = Math.max(py[ai]!, py[bi]!);
    for (let oj = oi + 1; oj < m; oj++) {
      const j = order[oj]!;
      const aj = sa[j]!, bj = sb[j]!;
      if (Math.min(px[aj]!, px[bj]!) > maxX) break;
      if (Math.max(py[aj]!, py[bj]!) < yi0 || Math.min(py[aj]!, py[bj]!) > yi1) continue;
      if (ai === aj || ai === bj || bi === aj || bi === bj) continue;
      const d1 = orient(ai, bi, aj), d2 = orient(ai, bi, bj);
      const d3 = orient(aj, bj, ai), d4 = orient(aj, bj, bi);
      if (!(((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))) continue;
      const ti = d3 / (d3 - d4), tj = d1 / (d1 - d2);
      px.push(px[ai]! + ti * (px[bi]! - px[ai]!));
      py.push(py[ai]! + ti * (py[bi]! - py[ai]!));
      gid.push(-1);
      const p = px.length - 1;
      (cuts.get(i) ?? cuts.set(i, []).get(i)!).push([ti, p]);
      (cuts.get(j) ?? cuts.set(j, []).get(j)!).push([tj, p]);
    }
  }
  if (!cuts.size) return;
  for (const [i, list] of cuts) {
    list.sort((x, y) => x[0] - y[0]);
    let prev = sa[i]!;
    const end = sb[i]!;
    const L = sl[i]!, Rr = sr[i]!;
    sb[i] = list[0]![1];
    prev = list[0]![1];
    for (let q = 1; q < list.length; q++) {
      sa.push(prev);
      sb.push(list[q]![1]);
      sl.push(L);
      sr.push(Rr);
      prev = list[q]![1];
    }
    sa.push(prev);
    sb.push(end);
    sl.push(L);
    sr.push(Rr);
  }
}

