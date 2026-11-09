import { describe, expect, it } from 'vitest';
import { encodeTriangleState } from '@/io/export/3mf/stateCode';

describe('encodeTriangleState', () => {
  it('omits the attribute for unpainted triangles', () => {
    expect(encodeTriangleState(0)).toBe('');
  });

  // Codes confirmed in Bambu Studio 02.09.01.70 (M0 spike: A-c4, filaments 1-4).
  it.each([
    [1, '4'],
    [2, '8'],
    [3, '0C'],
    [4, '1C'],
  ])('state %i -> %s (verified in Bambu Studio)', (state, code) => {
    expect(encodeTriangleState(state)).toBe(code);
  });

  it.each([
    [5, '2C'],
    [16, 'DC'],
    [17, 'EC'],
    [18, '0FC'], // first state that needs a continuation group
  ])('state %i -> %s', (state, code) => {
    expect(encodeTriangleState(state)).toBe(code);
  });

  it('rejects invalid states', () => {
    expect(() => encodeTriangleState(-1)).toThrow(RangeError);
    expect(() => encodeTriangleState(1.5)).toThrow(RangeError);
  });
});
