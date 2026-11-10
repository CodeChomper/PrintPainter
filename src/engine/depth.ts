import type { Matrix4 } from 'three';

/**
 * A snapshot of the view's depth (view-space distance per pixel, 0 = nothing there),
 * taken once per stroke. Answers "is this world point visible from the camera?" so
 * the brush never paints through the model.
 */
export class DepthView {
  private v: Float64Array;
  private p: Float64Array;
  /** World size of one pixel at view distance 1. */
  private pixelAtUnitDepth: number;

  constructor(
    private depth: Float32Array,
    private width: number,
    private height: number,
    view: Matrix4,
    projection: Matrix4,
    fovDeg: number,
  ) {
    this.v = Float64Array.from(view.elements);
    this.p = Float64Array.from(projection.elements);
    this.pixelAtUnitDepth = (2 * Math.tan((fovDeg * Math.PI) / 360)) / height;
  }

  visible(x: number, y: number, z: number): boolean {
    const v = this.v, p = this.p;
    const vx = v[0]! * x + v[4]! * y + v[8]! * z + v[12]!;
    const vy = v[1]! * x + v[5]! * y + v[9]! * z + v[13]!;
    const vz = v[2]! * x + v[6]! * y + v[10]! * z + v[14]!;
    const d = -vz;
    if (d <= 0) return false;
    const cx = p[0]! * vx + p[4]! * vy + p[8]! * vz + p[12]!;
    const cy = p[1]! * vx + p[5]! * vy + p[9]! * vz + p[13]!;
    const cw = p[3]! * vx + p[7]! * vy + p[11]! * vz + p[15]!;
    const px = (cx / cw * 0.5 + 0.5) * this.width;
    const py = (cy / cw * 0.5 + 0.5) * this.height;
    if (!(px >= 0 && py >= 0 && px < this.width && py < this.height)) return false;
    const ix = px | 0, iy = py | 0;
    // Farthest surface in the 3×3 neighbourhood: forgiving at silhouettes and grazing angles.
    let far = 0;
    for (let j = Math.max(0, iy - 1); j <= Math.min(this.height - 1, iy + 1); j++) {
      for (let i = Math.max(0, ix - 1); i <= Math.min(this.width - 1, ix + 1); i++) {
        const s = this.depth[j * this.width + i]!;
        if (s === 0) return true; // background next to it: nothing in front
        if (s > far) far = s;
      }
    }
    const bias = d * (2.5 * this.pixelAtUnitDepth + 0.002);
    return d <= far + bias;
  }
}
