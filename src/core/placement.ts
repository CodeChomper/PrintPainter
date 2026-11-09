/** Axis-aligned footprint on the plate, in mm (plate centred on the origin). */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Finds a centre for a w×d footprint that doesn't overlap `taken` (with `gap` mm
 * between objects), trying positions closest to the plate centre first. Falls back to
 * the centre when nothing fits.
 */
export function findFreeSpot(
  w: number,
  d: number,
  taken: Rect[],
  plate: { w: number; d: number },
  gap = 5,
  step = 5,
): [number, number] {
  if (!taken.length) return [0, 0];
  const candidates: [number, number][] = [];
  const hx = Math.max(0, (plate.w - w) / 2);
  const hy = Math.max(0, (plate.d - d) / 2);
  for (let x = -Math.floor(hx / step) * step; x <= hx; x += step) {
    for (let y = -Math.floor(hy / step) * step; y <= hy; y += step) candidates.push([x, y]);
  }
  candidates.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2));
  for (const [x, y] of candidates) {
    const r = { minX: x - w / 2 - gap, maxX: x + w / 2 + gap, minY: y - d / 2 - gap, maxY: y + d / 2 + gap };
    if (taken.every((t) => r.maxX <= t.minX || r.minX >= t.maxX || r.maxY <= t.minY || r.minY >= t.maxY)) return [x, y];
  }
  return [0, 0];
}
