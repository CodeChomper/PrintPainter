// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { DEFAULT_PALETTE } from '@/core/palette';
import { write3mfBambu, type ExportObject } from '@/io/export/3mf/bambu';
import { num } from '@/io/export/3mf/package';
import { read3mf } from '@/io/import/threemf';

function cube(offset: [number, number, number], slots: number[]): ExportObject {
  const C = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  return {
    name: 'Cube <&>',
    positions: Float64Array.from(C.flatMap(([x, y, z]) => [x! * 10 + offset[0], y! * 10 + offset[1], z! * 10 + offset[2]])),
    indices: Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
    slots: Uint8Array.from(slots),
  };
}

describe('write3mfBambu', () => {
  const objects = [cube([-20, 0, 0], new Array(12).fill(1)), cube([5, 5, 0], [1, 2, 3, 4, 5, 16, 1, 1, 2, 2, 3, 3])];
  const bytes = write3mfBambu(objects, { application: 'PrintPainter-test', palette: DEFAULT_PALETTE, plateCentre: [128, 128] });

  it('writes the minimal file set with paint_color on every triangle', () => {
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const model = strFromU8(files['3D/3dmodel.model']!);
    expect(model).toContain('<metadata name="Application">PrintPainter-test</metadata>');
    expect(model).toContain('name="Cube &lt;&amp;&gt;"');
    expect(model.match(/paint_color="/g)?.length).toBe(24);
    for (const code of ['4', '8', '0C', '1C', '2C', 'DC']) expect(model).toContain(`paint_color="${code}"`);
  });

  it('reads back with the same geometry, placed around the plate centre', () => {
    const r = read3mf(bytes);
    expect(r.unit).toBe('mm');
    expect(r.parts).toHaveLength(2);
    for (const [i, p] of r.parts.entries()) {
      expect(p.mesh.indices.length).toBe(36);
      const src = objects[i]!.positions;
      for (let v = 0; v < src.length; v++) {
        const shift = v % 3 === 2 ? 0 : 128;
        expect(p.mesh.positions[v]).toBeCloseTo(src[v]! + shift, 4);
      }
    }
  });

  it('adds filament colours and types when asked', () => {
    const b = write3mfBambu(objects, { application: 'x', palette: DEFAULT_PALETTE, plateCentre: [0, 0], filamentSettings: true });
    const cfg = JSON.parse(strFromU8(unzipSync(b)['Metadata/project_settings.config']!));
    expect(cfg.filament_colour).toEqual(DEFAULT_PALETTE.map((p) => p.color.toUpperCase()));
    expect(cfg.filament_type).toEqual(['PLA', 'PLA', 'PLA', 'PLA']);
  });

  it('formats numbers compactly', () => {
    expect(num(1.5)).toBe('1.5');
    expect(num(-0.0000001)).toBe('0');
    expect(num(12.3456789)).toBe('12.345679');
  });
});
