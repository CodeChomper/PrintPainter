// Which slot a point lies in, given the boundary segments around it.
//
// The nearest point on a planar boundary graph always lies on the boundary of the
// point's own region (a straight path to anything farther would cross that boundary
// first). So the slot is the one on the point's side of the nearest segment. When
// the nearest point is a shared vertex, the segments around that vertex are sorted
// by angle and the point takes the side of whichever neighbour it is angularly
// closer to. That stays right at junctions, and at vertices on a triangle's edge
// where the region outside the triangle sits between two segments.

import type { BoundaryGraph } from './trace';

/** A set of segments with endpoint ids (equal ids = the same vertex). */
export interface SegmentSet {
  ax: ArrayLike<number>;
  ay: ArrayLike<number>;
  bx: ArrayLike<number>;
  by: ArrayLike<number>;
  aId: ArrayLike<number>;
  bId: ArrayLike<number>;
  left: ArrayLike<number>;
  right: ArrayLike<number>;
}

const TAU = Math.PI * 2;

/**
 * Slot at (px, py) from the candidate segments `cand` (indices into `s`), or -1 if
 * none is within `maxDist`.
 */
export function labelAt(s: SegmentSet, cand: ArrayLike<number>, count: number, px: number, py: number, maxDist = Infinity): number {
  let best = maxDist * maxDist, bi = -1, bt = 0;
  for (let n = 0; n < count; n++) {
    const i = cand[n]!;
    const ax = s.ax[i]!, ay = s.ay[i]!;
    const dx = s.bx[i]! - ax, dy = s.by[i]! - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
    if (d < best || (d === best && bi >= 0 && t > 0 && t < 1)) {
      best = d;
      bi = i;
      bt = t;
    }
  }
  if (bi < 0) return -1;
  if (bt > 0 && bt < 1) {
    const cr = (s.bx[bi]! - s.ax[bi]!) * (py - s.ay[bi]!) - (s.by[bi]! - s.ay[bi]!) * (px - s.ax[bi]!);
    return cr >= 0 ? s.left[bi]! : s.right[bi]!;
  }
  // Nearest point is a vertex: look at every candidate segment that meets there.
  const v = bt === 0 ? s.aId[bi]! : s.bId[bi]!;
  const vx = bt === 0 ? s.ax[bi]! : s.bx[bi]!;
  const vy = bt === 0 ? s.ay[bi]! : s.by[bi]!;
  const phi = Math.atan2(py - vy, px - vx);
  let cw = Infinity, cwLabel = -1, ccw = Infinity, ccwLabel = -1;
  for (let n = 0; n < count; n++) {
    const i = cand[n]!;
    let ox: number, oy: number, leftOut: number, rightOut: number;
    if (s.aId[i] === v) {
      ox = s.bx[i]! - s.ax[i]!;
      oy = s.by[i]! - s.ay[i]!;
      leftOut = s.left[i]!;
      rightOut = s.right[i]!;
    } else if (s.bId[i] === v) {
      ox = s.ax[i]! - s.bx[i]!;
      oy = s.ay[i]! - s.by[i]!;
      leftOut = s.right[i]!;
      rightOut = s.left[i]!;
    } else continue;
    const theta = Math.atan2(oy, ox);
    let d = (phi - theta) % TAU;
    if (d < 0) d += TAU;
    if (d < cw) {
      cw = d;
      cwLabel = leftOut; // p is counter-clockwise from this segment: its left side
    }
    const e = TAU - d;
    if (e < ccw) {
      ccw = e;
      ccwLabel = rightOut; // p is clockwise from this segment: its right side
    }
  }
  return cw <= ccw ? cwLabel : ccwLabel;
}

/** Uniform grid over a boundary graph's segments, for nearest-segment queries. */
export class SegmentIndex implements SegmentSet {
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  aId: Uint32Array;
  bId: Uint32Array;
  left: Uint8Array;
  right: Uint8Array;
  private cellStart: Uint32Array;
  private cellSegs: Uint32Array;
  private stamp: Uint32Array;
  private epoch = 0;
  private gx: number;
  private gy: number;
  private buf = new Uint32Array(256);

  constructor(
    g: BoundaryGraph,
    private x0: number,
    private y0: number,
    w: number,
    h: number,
    private cell = 8,
  ) {
    const S = g.segments;
    this.ax = new Float64Array(S);
    this.ay = new Float64Array(S);
    this.bx = new Float64Array(S);
    this.by = new Float64Array(S);
    for (let i = 0; i < S; i++) {
      this.ax[i] = g.x[g.a[i]!]!;
      this.ay[i] = g.y[g.a[i]!]!;
      this.bx[i] = g.x[g.b[i]!]!;
      this.by[i] = g.y[g.b[i]!]!;
    }
    this.aId = g.a;
    this.bId = g.b;
    this.left = g.left;
    this.right = g.right;
    this.gx = Math.max(1, Math.ceil(w / cell));
    this.gy = Math.max(1, Math.ceil(h / cell));
    const counts = new Uint32Array(this.gx * this.gy + 1);
    const each = (i: number, fn: (c: number) => void) => {
      const [cx0, cy0] = this.cellOf(Math.min(this.ax[i]!, this.bx[i]!), Math.min(this.ay[i]!, this.by[i]!));
      const [cx1, cy1] = this.cellOf(Math.max(this.ax[i]!, this.bx[i]!), Math.max(this.ay[i]!, this.by[i]!));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fn(cy * this.gx + cx);
    };
    for (let i = 0; i < S; i++) each(i, (c) => counts[c + 1]!++);
    for (let c = 0; c < this.gx * this.gy; c++) counts[c + 1]! += counts[c]!;
    this.cellStart = counts;
    this.cellSegs = new Uint32Array(counts[this.gx * this.gy]!);
    const fill = counts.slice(0, this.gx * this.gy);
    for (let i = 0; i < S; i++) each(i, (c) => (this.cellSegs[fill[c]!++] = i));
    this.stamp = new Uint32Array(S);
  }

  private cellOf(x: number, y: number): [number, number] {
    const cx = Math.min(this.gx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
    const cy = Math.min(this.gy - 1, Math.max(0, Math.floor((y - this.y0) / this.cell)));
    return [cx, cy];
  }

  /** Segments whose cells overlap the box. Returns a reused buffer and its length. */
  query(x0: number, y0: number, x1: number, y1: number): [Uint32Array, number] {
    const e = ++this.epoch;
    if (e === 0xffffffff) {
      this.stamp.fill(0);
      this.epoch = 1;
    }
    const [cx0, cy0] = this.cellOf(x0, y0);
    const [cx1, cy1] = this.cellOf(x1, y1);
    let n = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.gx + cx;
        for (let q = this.cellStart[c]!; q < this.cellStart[c + 1]!; q++) {
          const s = this.cellSegs[q]!;
          if (this.stamp[s] === this.epoch) continue;
          this.stamp[s] = this.epoch;
          if (n === this.buf.length) {
            const b = new Uint32Array(n * 2);
            b.set(this.buf);
            this.buf = b;
          }
          this.buf[n++] = s;
        }
      }
    }
    return [this.buf, n];
  }

  /** Slot at a point, or -1 if no boundary is within `radius`. */
  labelNear(px: number, py: number, radius: number): number {
    const [cand, n] = this.query(px - radius, py - radius, px + radius, py + radius);
    return labelAt(this, cand, n, px, py, radius);
  }
}
