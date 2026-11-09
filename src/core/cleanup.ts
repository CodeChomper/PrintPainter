// Import cleanup: weld duplicate vertices, drop degenerate and duplicate triangles,
// make winding consistent and outward, then check watertightness. No repair:
// open and non-manifold edges are reported (and highlighted by the UI), not fixed.
// Pure TS, no DOM, so it runs in a worker (and later, if needed, in Node/native).

import { boundsSize, meshBounds, type IndexedMesh } from './mesh';

export interface CleanupReport {
  inputTriangles: number;
  outputTriangles: number;
  /** Vertices removed by welding (duplicates within tolerance). */
  mergedVertices: number;
  /** Triangles removed because two corners were the same vertex, or coordinates were not finite. */
  removedDegenerate: number;
  /** Triangles removed because another triangle used the same three vertices. */
  removedDuplicate: number;
  /** Triangles whose winding was reversed to match their neighbours / face outward. */
  flippedTriangles: number;
  /** Edge-connected pieces. */
  components: number;
  /** Weld tolerance used, in source units. */
  weldTolerance: number;
  /** Vertex index pairs (into the cleaned mesh) of edges used by only one triangle. */
  openEdges: Uint32Array;
  /** Vertex index pairs of edges used by more than two triangles. */
  nonManifoldEdges: Uint32Array;
  /** Edges shared by two triangles that still disagree on winding (non-orientable surfaces). */
  inconsistentEdges: number;
  watertight: boolean;
}

export interface CleanupResult {
  mesh: IndexedMesh;
  report: CleanupReport;
}

export function cleanupMesh(input: IndexedMesh): CleanupResult {
  const inputTriangles = input.indices.length / 3;
  const size = boundsSize(meshBounds(input));
  const diag = Math.hypot(size[0], size[1], size[2]);
  const weldTolerance = Number.isFinite(diag) && diag > 0 ? diag * 1e-6 : 1e-9;

  const welded = weldVertices(input, weldTolerance);
  const filtered = removeDegenerateAndDuplicates(welded.mesh);
  const vCount = welded.mesh.positions.length / 3;
  const indices = filtered.indices;
  const oriented = orientTriangles(welded.mesh.positions, indices, vCount);
  const mesh = compactVertices({ positions: welded.mesh.positions, indices });
  const edges = analyzeEdges(mesh.indices, mesh.positions.length / 3);

  const pairs = (halfEdges: number[]) => {
    const out = new Uint32Array(halfEdges.length * 2);
    halfEdges.forEach((h, i) => {
      out[i * 2] = mesh.indices[h]!;
      out[i * 2 + 1] = mesh.indices[nextInTri(h)]!;
    });
    return out;
  };

  return {
    mesh,
    report: {
      inputTriangles,
      outputTriangles: mesh.indices.length / 3,
      mergedVertices: welded.merged,
      removedDegenerate: filtered.degenerate,
      removedDuplicate: filtered.duplicates,
      flippedTriangles: oriented.flipped,
      components: oriented.components,
      weldTolerance,
      openEdges: pairs(edges.open),
      nonManifoldEdges: pairs(edges.nonManifold),
      inconsistentEdges: edges.inconsistent,
      watertight: edges.open.length === 0 && edges.nonManifold.length === 0 && edges.inconsistent === 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Welding

/**
 * Merges vertices closer than `eps`. Uses a hash grid with cells 4·eps wide and only
 * probes neighbouring cells when a point is within eps of a cell wall, so the common
 * case is a single lookup. Unreferenced vertices are dropped.
 */
export function weldVertices(mesh: IndexedMesh, eps: number): { mesh: IndexedMesh; merged: number } {
  const p = mesh.positions;
  const n = p.length / 3;
  const used = new Uint8Array(n);
  for (const i of mesh.indices) used[i] = 1;

  const cell = eps * 4;
  const inv = 1 / cell;
  const eps2 = eps * eps;
  const buckets = new Map<number, number[]>();
  const remap = new Uint32Array(n);
  const out = new Float32Array(p.length);
  let count = 0;
  let usedCount = 0;
  const hash = (x: number, y: number, z: number) =>
    Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
  const range = (f: number, i: number): number[] => {
    const frac = f - i;
    return frac < 0.25 ? [0, -1] : frac > 0.75 ? [0, 1] : [0];
  };

  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    usedCount++;
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    const fx = x * inv, fy = y * inv, fz = z * inv;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let found = -1;
    if (Number.isFinite(fx + fy + fz)) {
      search: for (const dx of range(fx, ix)) {
        for (const dy of range(fy, iy)) {
          for (const dz of range(fz, iz)) {
            const bucket = buckets.get(hash(ix + dx, iy + dy, iz + dz));
            if (!bucket) continue;
            for (const id of bucket) {
              const ax = out[id * 3]! - x, ay = out[id * 3 + 1]! - y, az = out[id * 3 + 2]! - z;
              if (ax * ax + ay * ay + az * az <= eps2) {
                found = id;
                break search;
              }
            }
          }
        }
      }
    }
    if (found < 0) {
      found = count++;
      out[found * 3] = x;
      out[found * 3 + 1] = y;
      out[found * 3 + 2] = z;
      if (Number.isFinite(fx + fy + fz)) {
        const k = hash(ix, iy, iz);
        const bucket = buckets.get(k);
        if (bucket) bucket.push(found);
        else buckets.set(k, [found]);
      }
    }
    remap[i] = found;
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let j = 0; j < indices.length; j++) indices[j] = remap[mesh.indices[j]!]!;
  return { mesh: { positions: out.slice(0, count * 3), indices }, merged: usedCount - count };
}

// ---------------------------------------------------------------------------
// Degenerate / duplicate triangles

export function removeDegenerateAndDuplicates(mesh: IndexedMesh): {
  indices: Uint32Array;
  degenerate: number;
  duplicates: number;
} {
  const src = mesh.indices;
  const p = mesh.positions;
  const T = src.length / 3;
  const keep = new Uint32Array(src.length);
  let kept = 0;
  let degenerate = 0;
  let duplicates = 0;
  const heads = new Map<number, number>(); // hash of sorted triple -> first kept tri
  const chain: number[] = []; // next kept tri with same hash, -1 = end

  const finite = (v: number) =>
    Number.isFinite(p[v * 3]!) && Number.isFinite(p[v * 3 + 1]!) && Number.isFinite(p[v * 3 + 2]!);

  for (let t = 0; t < T; t++) {
    const a = src[t * 3]!, b = src[t * 3 + 1]!, c = src[t * 3 + 2]!;
    if (a === b || b === c || a === c || !finite(a) || !finite(b) || !finite(c)) {
      degenerate++;
      continue;
    }
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
    const h = Math.imul(lo, 73856093) ^ Math.imul(mid, 19349663) ^ Math.imul(hi, 83492791);
    let dup = false;
    for (let k = heads.get(h) ?? -1; k >= 0; k = chain[k]!) {
      const x = keep[k * 3]!, y = keep[k * 3 + 1]!, z = keep[k * 3 + 2]!;
      const klo = Math.min(x, y, z), khi = Math.max(x, y, z);
      if (klo === lo && khi === hi && x + y + z - klo - khi === mid) {
        dup = true;
        break;
      }
    }
    if (dup) {
      duplicates++;
      continue;
    }
    chain[kept] = heads.get(h) ?? -1;
    heads.set(h, kept);
    keep[kept * 3] = a;
    keep[kept * 3 + 1] = b;
    keep[kept * 3 + 2] = c;
    kept++;
  }
  return { indices: keep.slice(0, kept * 3), degenerate, duplicates };
}

// ---------------------------------------------------------------------------
// Edge analysis. Half-edge h = 3t + k runs from corner k to corner (k+1) % 3 of triangle t.

const nextInTri = (h: number) => (h % 3 === 2 ? h - 2 : h + 1);

export interface EdgeAnalysis {
  /** twin[h] = the other half-edge on a manifold edge, or -1 (open or non-manifold). */
  twin: Int32Array;
  /** One half-edge per open edge. */
  open: number[];
  /** One half-edge per non-manifold edge. */
  nonManifold: number[];
  /** Manifold edges whose two triangles traverse it in the same direction. */
  inconsistent: number;
}

export function analyzeEdges(indices: Uint32Array, vertexCount: number): EdgeAnalysis {
  const H = indices.length;
  const first = new Map<number, number>();
  const chain = new Int32Array(H).fill(-1);
  const counts = new Map<number, number>();
  for (let h = 0; h < H; h++) {
    const a = indices[h]!, b = indices[nextInTri(h)]!;
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    const f = first.get(key);
    if (f === undefined) first.set(key, h);
    else {
      chain[h] = chain[f]!;
      chain[f] = h;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const twin = new Int32Array(H).fill(-1);
  const open: number[] = [];
  const nonManifold: number[] = [];
  let inconsistent = 0;
  for (const [key, h] of first) {
    const n = counts.get(key)!;
    if (n === 1) open.push(h);
    else if (n > 2) nonManifold.push(h);
    else {
      const o = chain[h]!;
      twin[h] = o;
      twin[o] = h;
      if (indices[h] === indices[o]) inconsistent++;
    }
  }
  return { twin, open, nonManifold, inconsistent };
}

// ---------------------------------------------------------------------------
// Orientation

/**
 * Flips triangles (in place) so neighbours agree on winding, then makes each closed
 * component face outward (positive signed volume). Open components keep whichever
 * orientation most of their triangles already had.
 */
export function orientTriangles(
  positions: Float32Array,
  indices: Uint32Array,
  vertexCount: number,
): { flipped: number; components: number } {
  const T = indices.length / 3;
  const { twin } = analyzeEdges(indices, vertexCount);
  const flip = new Uint8Array(T);
  const comp = new Int32Array(T).fill(-1);
  const queue = new Int32Array(T);
  let components = 0;
  let flipped = 0;

  for (let seed = 0; seed < T; seed++) {
    if (comp[seed]! >= 0) continue;
    const c = components++;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    comp[seed] = c;
    let closed = true;
    while (head < tail) {
      const t = queue[head++]!;
      for (let k = 0; k < 3; k++) {
        const h = t * 3 + k;
        const o = twin[h]!;
        if (o < 0) {
          closed = false;
          continue;
        }
        const u = (o / 3) | 0;
        const sameDir = indices[h] === indices[o] ? 1 : 0;
        if (comp[u]! < 0) {
          comp[u] = c;
          flip[u] = flip[t]! ^ sameDir;
          queue[tail++] = u;
        }
      }
    }

    // queue[0..tail) holds this component's triangles.
    let invert: boolean;
    if (closed) {
      let vol = 0;
      for (let q = 0; q < tail; q++) {
        const t = queue[q]!;
        const s = signedVolume(positions, indices, t);
        vol += flip[t] ? -s : s;
      }
      invert = vol < 0;
    } else {
      let nf = 0;
      for (let q = 0; q < tail; q++) nf += flip[queue[q]!]!;
      invert = nf * 2 > tail;
    }
    for (let q = 0; q < tail; q++) {
      const t = queue[q]!;
      if (invert) flip[t] = flip[t]! ^ 1;
      if (flip[t]) {
        const i1 = indices[t * 3 + 1]!;
        indices[t * 3 + 1] = indices[t * 3 + 2]!;
        indices[t * 3 + 2] = i1;
        flipped++;
      }
    }
  }
  return { flipped, components };
}

function signedVolume(p: Float32Array, idx: Uint32Array, t: number): number {
  const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
  const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
  const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
  const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}

// ---------------------------------------------------------------------------

/** Drops vertices no triangle uses and renumbers indices. */
export function compactVertices(mesh: IndexedMesh): IndexedMesh {
  const n = mesh.positions.length / 3;
  const remap = new Int32Array(n).fill(-1);
  let count = 0;
  const indices = new Uint32Array(mesh.indices.length);
  const positions = new Float32Array(n * 3);
  for (let j = 0; j < indices.length; j++) {
    const v = mesh.indices[j]!;
    if (remap[v]! < 0) {
      remap[v] = count;
      positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), count * 3);
      count++;
    }
    indices[j] = remap[v]!;
  }
  return { positions: positions.slice(0, count * 3), indices };
}
