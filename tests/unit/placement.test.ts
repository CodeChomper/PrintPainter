import { describe, expect, it } from 'vitest';
import { findFreeSpot } from '@/core/placement';

const plate = { w: 256, d: 256 };

describe('findFreeSpot', () => {
  it('uses the plate centre when empty', () => {
    expect(findFreeSpot(20, 20, [], plate)).toEqual([0, 0]);
  });

  it('moves next to an object in the centre, keeping the gap', () => {
    const [x, y] = findFreeSpot(20, 20, [{ minX: -10, maxX: 10, minY: -10, maxY: 10 }], plate);
    const r = { minX: x - 10, maxX: x + 10, minY: y - 10, maxY: y + 10 };
    const clear = r.minX >= 15 || r.maxX <= -15 || r.minY >= 15 || r.maxY <= -15;
    expect(clear).toBe(true);
    expect(Math.hypot(x, y)).toBeLessThanOrEqual(30);
  });

  it('falls back to the centre when the plate is full', () => {
    expect(findFreeSpot(200, 200, [{ minX: -128, maxX: 128, minY: -128, maxY: 128 }], plate)).toEqual([0, 0]);
  });
});
