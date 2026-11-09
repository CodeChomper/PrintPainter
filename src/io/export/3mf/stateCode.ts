/**
 * Whole-triangle state code shared by Bambu/Orca `paint_color` and Prusa
 * `slic3rpe:mmu_segmentation`. See docs/3mf-dialects.md.
 *
 * A leaf triangle is a bit stream: 2 bits split-sides (0 = leaf), then 2 bits of
 * state if state < 3, else bits 1,1 followed by (state - 3) in 4-bit groups
 * (1111 = "add 15 and continue"). Bits are packed 4 per hex digit (first bit =
 * least significant) and the digits are written in reverse order.
 *
 * Returns '' for state 0 (unpainted: omit the attribute).
 */
export function encodeTriangleState(state: number): string {
  if (!Number.isInteger(state) || state < 0) throw new RangeError(`invalid state ${state}`);
  if (state === 0) return '';
  const bits: number[] = [0, 0];
  if (state < 3) bits.push(state & 1, (state >> 1) & 1);
  else {
    bits.push(1, 1);
    let n = state - 3;
    while (n >= 15) {
      bits.push(1, 1, 1, 1);
      n -= 15;
    }
    for (let i = 0; i < 4; i++) bits.push((n >> i) & 1);
  }
  let out = '';
  for (let o = 0; o < bits.length; o += 4) {
    let v = 0;
    for (let i = 3; i >= 0; i--) v = (v << 1) | (bits[o + i] ?? 0);
    out = v.toString(16).toUpperCase() + out;
  }
  return out;
}
