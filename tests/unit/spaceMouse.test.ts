import { describe, expect, it } from 'vitest';
import { BUTTON, parseReport, ZERO_AXES } from '@/engine/spaceMouse';
import { DEFAULT_SPACE_SETTINGS, motionFromAxes, shapeAxis } from '@/engine/spaceNavigation';

const view = (...i16: number[]) => {
  const d = new DataView(new ArrayBuffer(i16.length * 2));
  i16.forEach((v, i) => d.setInt16(i * 2, v, true));
  return d;
};

describe('parseReport', () => {
  it('reads separate translation and rotation reports (SpaceMouse Pro)', () => {
    expect(parseReport(1, view(10, -20, 350))).toEqual({ axes: { tx: 10, ty: -20, tz: 350 } });
    expect(parseReport(2, view(-350, 5, 7))).toEqual({ axes: { rx: -350, ry: 5, rz: 7 } });
  });

  it('reads all six axes from one report (newer models)', () => {
    expect(parseReport(1, view(1, 2, 3, 4, 5, 6))).toEqual({ axes: { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 } });
  });

  it('reads the button bitmask, including the high bits', () => {
    const d = new DataView(new Uint8Array([0b10, 0, 0, 0b100]).buffer);
    const r = parseReport(3, d)!;
    expect(r.buttons! & (1 << BUTTON.FIT)).toBeTruthy();
    expect(r.buttons! & (1 << BUTTON.ROTATION)).toBeTruthy();
    expect(r.buttons).toBeGreaterThan(0);
  });

  it('ignores other reports', () => {
    expect(parseReport(23, view(1, 2, 3))).toBeNull();
  });
});

describe('motionFromAxes', () => {
  const s = DEFAULT_SPACE_SETTINGS;

  it('has a dead zone and reaches 1 at full deflection', () => {
    expect(shapeAxis(10)).toBe(0);
    expect(shapeAxis(350)).toBeCloseTo(1);
    expect(shapeAxis(-500)).toBeCloseTo(-1);
    expect(shapeAxis(175)).toBeGreaterThan(0);
    expect(shapeAxis(175)).toBeLessThan(0.5);
  });

  it('maps the cap in object mode', () => {
    expect(motionFromAxes({ ...ZERO_AXES, tx: 350 }, s).panX).toBeCloseTo(1); // right
    expect(motionFromAxes({ ...ZERO_AXES, tz: -350 }, s).panY).toBeCloseTo(1); // pulled up
    expect(motionFromAxes({ ...ZERO_AXES, ty: 350 }, s).zoom).toBeCloseTo(1); // pulled toward you
    expect(motionFromAxes({ ...ZERO_AXES, rx: 350 }, s).tilt).toBeCloseTo(1);
    expect(motionFromAxes({ ...ZERO_AXES, rz: 350 }, s).spin).toBeCloseTo(-1); // clockwise from above
    const still = motionFromAxes({ ...ZERO_AXES, ry: 350 }, s); // roll is unused
    expect(Object.values(still).every((v) => v === 0)).toBe(true);
  });

  it('applies zoom-up/down, inverts and the rotation lock', () => {
    const up = { ...s, zoomUpDown: true };
    expect(motionFromAxes({ ...ZERO_AXES, tz: 350 }, up).zoom).toBeCloseTo(1); // pushed down
    expect(motionFromAxes({ ...ZERO_AXES, ty: -350 }, up).panY).toBeCloseTo(1); // pushed forward
    expect(motionFromAxes({ ...ZERO_AXES, tx: 350 }, { ...s, invertPanX: true }).panX).toBeCloseTo(-1);
    const locked = motionFromAxes({ ...ZERO_AXES, rx: 350, rz: 350, tx: 350 }, { ...s, lockRotation: true });
    expect(locked.tilt).toBe(0);
    expect(locked.spin).toBe(0);
    expect(locked.panX).toBeCloseTo(1);
  });
});
