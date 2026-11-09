// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { read3mf } from '@/io/import/threemf';
import { ImportError } from '@/io/import/types';

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const TRI_MESH = `<mesh><vertices>
  <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
 </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>`;

function pkg(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = { '_rels/.rels': strToU8(RELS) };
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  return zipSync(entries);
}

describe('read3mf', () => {
  it('reads a flat model with its unit and build transform', () => {
    const r = read3mf(pkg({
      '3D/3dmodel.model': `<model unit="inch" xmlns="${CORE}"><resources>
        <object id="1" type="model" name="tri">${TRI_MESH}</object>
        </resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></build></model>`,
    }));
    expect(r.unit).toBe('in');
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.name).toBe('tri');
    expect(Array.from(r.parts[0]!.mesh.positions.slice(0, 3))).toEqual([10, 20, 30]);
  });

  it('follows production-extension components into other model files (Bambu layout)', () => {
    const r = read3mf(pkg({
      '3D/3dmodel.model': `<model unit="millimeter" xmlns="${CORE}" xmlns:p="${PROD}" requiredextensions="p"><resources>
        <object id="2" type="model" name="assembly"><components>
          <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
          <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 5 0"/>
        </components></object>
        </resources><build><item objectid="2" transform="2 0 0 0 2 0 0 0 2 100 0 0"/></build></model>`,
      '3D/Objects/object_1.model': `<model unit="millimeter" xmlns="${CORE}"><resources>
        <object id="1" type="model">${TRI_MESH}</object></resources></model>`,
    }));
    expect(r.parts).toHaveLength(1); // one build item = one object
    const p = r.parts[0]!;
    expect(p.name).toBe('assembly');
    expect(p.mesh.indices.length).toBe(6);
    // First vertex of first component: (0,0,0) + (5,0,0), then scaled by 2 and moved +100 in x.
    expect(Array.from(p.mesh.positions.slice(0, 3))).toEqual([110, 0, 0]);
    // First vertex of second component: (0,5,0) -> (0,10,0) + 100.
    expect(Array.from(p.mesh.positions.slice(9, 12))).toEqual([100, 10, 0]);
  });

  it('reverses winding under a mirroring transform', () => {
    const r = read3mf(pkg({
      '3D/3dmodel.model': `<model xmlns="${CORE}"><resources><object id="1">${TRI_MESH}</object></resources>
        <build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`,
    }));
    expect(Array.from(r.parts[0]!.mesh.indices)).toEqual([0, 2, 1]);
    expect(r.unit).toBe('mm');
  });

  it('skips support objects and warns', () => {
    const r = read3mf(pkg({
      '3D/3dmodel.model': `<model xmlns="${CORE}"><resources>
        <object id="1" type="model">${TRI_MESH}</object>
        <object id="2" type="support">${TRI_MESH}</object>
        </resources><build><item objectid="1"/><item objectid="2"/></build></model>`,
    }));
    expect(r.parts).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/support/);
  });

  it('rejects files that are not zips', () => {
    expect(() => read3mf(new Uint8Array([1, 2, 3, 4]))).toThrow(ImportError);
  });
});
