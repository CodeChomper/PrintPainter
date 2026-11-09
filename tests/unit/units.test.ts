import { describe, expect, it } from 'vitest';
import { formatDims, guessUnitFromExtent, unitFrom3mf } from '@/core/units';

describe('guessUnitFromExtent', () => {
  it.each([
    [150, 'mm'], // a typical print in mm
    [0.5, 'cm'], // 0.5 mm is too small, 5 mm is printable
    [0.15, 'in'], // 1.5 mm in cm, 3.8 mm in inches
    [0.05, 'm'], // only metres give a printable size (50 mm)
    [8, 'mm'],
    [1, 'cm'], // 1 mm is below the 2 mm floor, 1 cm is printable
  ] as const)('extent %f -> %s', (extent, unit) => {
    const g = guessUnitFromExtent(extent);
    expect(g.unit).toBe(unit);
    expect(g.certain).toBe(false);
  });

  it('falls back to mm for absurd sizes', () => {
    expect(guessUnitFromExtent(1e7).unit).toBe('mm');
    expect(guessUnitFromExtent(0).unit).toBe('mm');
    expect(guessUnitFromExtent(NaN).unit).toBe('mm');
  });
});

describe('unitFrom3mf', () => {
  it('maps the spec units', () => {
    expect(unitFrom3mf(null)).toBe('mm');
    expect(unitFrom3mf('micron')).toBe('um');
    expect(unitFrom3mf('inch')).toBe('in');
    expect(unitFrom3mf('meter')).toBe('m');
  });
});

describe('formatDims', () => {
  it('formats sizes with sensible precision', () => {
    expect(formatDims([20, 150.25, 3.14159])).toBe('20 × 150.3 × 3.142 mm');
  });
});
