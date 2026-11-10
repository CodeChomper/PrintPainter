import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { DEFAULT_PALETTE, normalizeColor, parsePalette, serializePalette } from '@/core/palette';

const json = (o: unknown) => strToU8(JSON.stringify(o));

describe('normalizeColor', () => {
  it('accepts slicer and CSS-style hex colours', () => {
    expect(normalizeColor('#FFFFFF')).toBe('#ffffff');
    expect(normalizeColor('#abc')).toBe('#aabbcc');
    expect(normalizeColor('00AE42FF')).toBe('#00ae42');
    expect(normalizeColor('')).toBeNull();
    expect(normalizeColor('red')).toBeNull();
    expect(normalizeColor(undefined)).toBeNull();
  });
});

describe('parsePalette', () => {
  it('round-trips our own palette file', () => {
    const text = serializePalette('Mine', DEFAULT_PALETTE);
    const p = parsePalette('mine.json', strToU8(text));
    expect(p.name).toBe('Mine');
    expect(p.slots).toEqual(DEFAULT_PALETTE);
    expect(p.warnings).toEqual([]);
  });

  it('reads a Bambu Studio / OrcaSlicer filament preset', () => {
    const p = parsePalette(
      'Bambu PLA Basic @BBL X1C.json',
      json({
        type: 'filament',
        name: 'My Bambu PLA Basic @BBL X1C',
        inherits: 'Bambu PLA Basic @BBL X1C',
        filament_type: ['PLA'],
        default_filament_colour: ['#00AE42'],
      }),
    );
    expect(p.slots).toEqual([{ name: 'My Bambu PLA Basic', color: '#00ae42', material: 'PLA' }]);
  });

  it('picks a colour (and says so) when a preset has none', () => {
    const p = parsePalette('petg.json', json({ name: 'Generic PETG', filament_type: ['PETG'], default_filament_colour: [''] }));
    expect(p.slots[0]!.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(p.slots[0]!.material).toBe('PETG');
    expect(p.warnings.join(' ')).toMatch(/colour/);
  });

  it('reads the filament list of a Bambu/Orca 3MF project', () => {
    const config = {
      filament_colour: ['#FFFFFF', '#000000', '#FF0000'],
      filament_type: ['PLA', 'PLA', 'PETG'],
      filament_settings_id: ['Bambu PLA Basic @BBL X1C', 'Bambu PLA Matte @BBL X1C', 'Generic PETG'],
    };
    const zip = zipSync({ 'Metadata/project_settings.config': json(config), '3D/3dmodel.model': strToU8('<model/>') });
    const p = parsePalette('job.3mf', zip);
    expect(p.slots).toEqual([
      { name: 'Bambu PLA Basic', color: '#ffffff', material: 'PLA' },
      { name: 'Bambu PLA Matte', color: '#000000', material: 'PLA' },
      { name: 'Generic PETG', color: '#ff0000', material: 'PETG' },
    ]);
  });

  it('reads every preset in a zipped preset bundle', () => {
    const zip = zipSync({
      'filament/a.json': json({ name: 'A', filament_type: ['PLA'], default_filament_colour: ['#111111'] }),
      'filament/b.json': json({ name: 'B', filament_type: ['TPU'], default_filament_colour: ['#222222'] }),
      'bundle_structure.json': json({ version: 1 }),
    });
    const p = parsePalette('bundle.bbsflmt', zip);
    expect(p.slots.map((s) => s.name).sort()).toEqual(['A', 'B']);
  });

  it('keeps at most 16 slots', () => {
    const n = 20;
    const config = { filament_colour: Array(n).fill('#123456'), filament_type: Array(n).fill('PLA') };
    const p = parsePalette('big.json', json(config));
    expect(p.slots).toHaveLength(16);
    expect(p.warnings.join(' ')).toMatch(/16/);
  });

  it('rejects files that are not palettes', () => {
    expect(() => parsePalette('x.json', json({ hello: 1 }))).toThrow(/isn't a palette/);
    expect(() => parsePalette('x.json', strToU8('{nope'))).toThrow(/not valid JSON/);
  });
});
