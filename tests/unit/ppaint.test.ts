import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildAtlas } from '@/core/atlas';
import { cleanupMesh } from '@/core/cleanup';
import type { LayerDoc } from '@/core/layers';
import { createMaps } from '@/core/paint';
import { DEFAULT_PALETTE } from '@/core/palette';
import {
  MANIFEST,
  parseProject,
  ProjectError,
  projectEntries,
  readProject,
  writeProject,
  type ProjectData,
} from '@/io/project/ppaint';
import { box } from './meshes';

function sample(): ProjectData {
  const { mesh, report } = cleanupMesh(box(10, 6, 4));
  mesh.faceIds = Int32Array.from({ length: mesh.indices.length / 3 }, (_, t) => t >> 1);
  const atlas = buildAtlas(mesh, { texelSize: 0.2, maxPageSize: 64 });
  const maps = createMaps(atlas);
  maps.forEach((m, p) => m.forEach((_, i) => (m[i] = (i + p) % 5)));
  const mask = createMaps(atlas).map((m) => m.map((_, i) => i % 2));
  const doc: LayerDoc = {
    layers: [
      { id: 'L1', name: 'Base', visible: true, kind: 'paint', slot: 2, masks: [] },
      {
        id: 'L2',
        name: 'Logo',
        visible: false,
        kind: 'fill',
        slot: 4,
        masks: [
          { id: 'M1', name: 'Hand', enabled: true, invert: true, op: 'subtract', kind: 'painted' },
          {
            id: 'M2', name: 'Img', enabled: false, invert: false, op: 'intersect', kind: 'decal', bitmap: 'B1', channel: 'dark', threshold: 0.3,
            centre: [1, 2, 3], dir: [0, 0, -1], up: [0, 1, 0], width: 4, rotationDeg: 15, through: true,
          },
          { id: 'M3', name: 'Stripes', enabled: true, invert: false, op: 'add', kind: 'height', fromMm: 1, toMm: 2, repeatMm: 3 },
        ],
      },
    ],
    maps: new Map([['L1', maps.map((m) => m.slice())], ['M1', mask]]),
    bitmaps: new Map([['B1', { width: 3, height: 2, la: Uint8Array.from({ length: 12 }, (_, i) => i * 20) }]]),
  };
  const plain = cleanupMesh(box(3));
  return {
    palette: DEFAULT_PALETTE.map((s) => ({ ...s })),
    objects: [
      {
        id: 'a-1',
        name: 'Box <1>',
        fileName: 'box.step',
        format: 'step',
        importId: 'imp',
        unit: 'cm',
        offset: [1.5, -2, 0],
        hidden: false,
        mesh,
        report,
        paint: { atlas, maps, doc, texelMm: 2, current: true },
      },
      {
        id: 'b-2',
        name: 'Plain',
        fileName: 'plain.stl',
        format: 'stl',
        importId: 'imp2',
        unit: 'mm',
        offset: [0, 0, 0],
        hidden: true,
        mesh: plain.mesh,
        report: plain.report,
        paint: null,
      },
    ],
  };
}

/** Edits one file inside a .ppaint. */
function tamper(bytes: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(bytes);
  edit(files);
  return zipSync(files);
}

describe('.ppaint', () => {
  const src = sample();
  const bytes = writeProject(src, 'PrintPainter-test');

  it('round-trips mesh, report, atlas, paint and palette', () => {
    expect(bytes.length).toBeGreaterThan(0);
    const p = readProject(bytes);
    expect(p.palette).toEqual(src.palette);
    expect(p.objects).toHaveLength(2);
    const [a, b] = p.objects;
    const s = src.objects[0]!;
    expect(a!.name).toBe('Box <1>');
    expect(a!.unit).toBe('cm');
    expect(a!.offset).toEqual([1.5, -2, 0]);
    expect(a!.mesh.positions).toEqual(s.mesh.positions);
    expect(a!.mesh.indices).toEqual(s.mesh.indices);
    expect(a!.mesh.faceIds).toEqual(s.mesh.faceIds);
    expect(a!.report).toEqual(s.report);
    const pa = a!.paint!;
    const sa = s.paint!;
    expect(pa.texelMm).toBe(2);
    expect(pa.current).toBe(true);
    expect(pa.atlas.pages).toEqual(sa.atlas.pages);
    expect(pa.atlas.pages.length).toBeGreaterThan(1); // exercises multi-page
    expect(pa.atlas.positions).toEqual(sa.atlas.positions);
    expect(pa.atlas.indices).toEqual(sa.atlas.indices);
    expect(pa.atlas.uvs).toEqual(sa.atlas.uvs);
    expect(pa.atlas.xref).toEqual(sa.atlas.xref);
    expect(pa.atlas.triSource).toEqual(sa.atlas.triSource);
    expect(pa.atlas.faceIds).toEqual(sa.atlas.faceIds);
    expect(pa.atlas.texelSize).toBe(sa.atlas.texelSize);
    expect(pa.atlas.charts).toBe(sa.atlas.charts);
    expect(pa.maps).toEqual(sa.maps);
    expect(b!.hidden).toBe(true);
    expect(b!.paint).toBeNull();
    expect(b!.mesh.faceIds).toBeUndefined();
  });

  it('round-trips layers, painted masks and decal images', () => {
    const d = readProject(bytes).objects[0]!.paint!.doc;
    const s = src.objects[0]!.paint!.doc;
    expect(d.layers).toEqual(s.layers);
    expect(d.maps).toEqual(s.maps);
    expect(d.bitmaps).toEqual(s.bitmaps);
  });

  it('opens a version 1 file (no layers) as one paint layer', () => {
    const v1 = tamper(bytes, (f) => {
      const m = JSON.parse(strFromU8(f[MANIFEST]!));
      m.version = 1;
      delete m.objects[0].paint.layers;
      delete m.objects[0].paint.bitmaps;
      f[MANIFEST] = strToU8(JSON.stringify(m));
      for (const k of Object.keys(f)) if (/layer\.|bitmap\./.test(k)) delete f[k];
    });
    const p = readProject(v1).objects[0]!.paint!;
    expect(p.doc.layers).toHaveLength(1);
    expect(p.doc.layers[0]!.kind).toBe('paint');
    expect(p.doc.maps.get(p.doc.layers[0]!.id)).toEqual(p.maps);
    expect(p.doc.maps.get(p.doc.layers[0]!.id)![0]).not.toBe(p.maps[0]); // its own copy
  });

  it('tags entries so unchanged data can be skipped', () => {
    const p = sample();
    p.objects[0]!.revs = { surface: 3, paint: 7, maps: new Map([['M1', 5]]) };
    const { entries } = projectEntries(p, 'x');
    const tag = (path: string) => entries.find((e) => e.path === path)?.tag;
    expect(tag('objects/a-1/mesh.positions.f32')).toBe('g');
    expect(tag('objects/a-1/atlas.uvs.f32')).toBe('s3');
    expect(tag('objects/a-1/paint.0.u8')).toBe('s3.p7');
    expect(tag('objects/a-1/layer.M1.0.u8')).toBe('s3.m5');
    expect(tag('objects/a-1/layer.L1.0.u8')).toBe('s3.m0');
    expect(tag('objects/a-1/bitmap.B1.u8')).toBe('b');
  });

  it('rejects files that are not projects', () => {
    expect(() => readProject(strToU8('hello'))).toThrow(ProjectError);
    expect(() => readProject(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/project.json is missing/);
    const other = tamper(bytes, (f) => (f[MANIFEST] = strToU8(JSON.stringify({ format: 'something-else' }))));
    expect(() => readProject(other)).toThrow("This isn't a PrintPainter project.");
  });

  it('asks for an update when the file is from a newer version', () => {
    const newer = tamper(bytes, (f) => {
      const m = JSON.parse(strFromU8(f[MANIFEST]!));
      m.version = 99;
      f[MANIFEST] = strToU8(JSON.stringify(m));
    });
    expect(() => readProject(newer)).toThrow(/newer version/);
  });

  it('rejects damaged data instead of crashing later', () => {
    const cases: [string, (f: Record<string, Uint8Array>) => void, RegExp][] = [
      ['missing array', (f) => delete f['objects/a-1/atlas.uvs.f32'], /atlas.uvs.f32 is missing/],
      [
        'index out of range',
        (f) => {
          const i = new Uint32Array(f['objects/a-1/mesh.indices.u32']!.slice().buffer);
          i[0] = 1e6;
          f['objects/a-1/mesh.indices.u32'] = new Uint8Array(i.buffer);
        },
        /points past the end/,
      ],
      ['truncated array', (f) => (f['objects/a-1/mesh.positions.f32'] = f['objects/a-1/mesh.positions.f32']!.subarray(1)), /partial value/],
      ['wrong map size', (f) => (f['objects/a-1/paint.0.u8'] = new Uint8Array(3)), /wrong size/],
      [
        'bad page',
        (f) => {
          const m = JSON.parse(strFromU8(f[MANIFEST]!));
          m.objects[0].paint.pages[0].width = 1e9;
          f[MANIFEST] = strToU8(JSON.stringify(m));
        },
        /paint page 1 is broken/,
      ],
      ['missing layer map', (f) => delete f['objects/a-1/layer.M1.1.u8'], /layer data M1 \(page 2\)/],
      ['wrong bitmap size', (f) => (f['objects/a-1/bitmap.B1.u8'] = new Uint8Array(5)), /decal image B1/],
      [
        'bad layer',
        (f) => {
          const m = JSON.parse(strFromU8(f[MANIFEST]!));
          m.objects[0].paint.layers[1].masks[0].kind = 'teleport';
          f[MANIFEST] = strToU8(JSON.stringify(m));
        },
        /unknown kind/,
      ],
      [
        'unknown units',
        (f) => {
          const m = JSON.parse(strFromU8(f[MANIFEST]!));
          m.objects[1].unit = 'furlong';
          f[MANIFEST] = strToU8(JSON.stringify(m));
        },
        /unknown units/,
      ],
      [
        'bad id',
        (f) => {
          const m = JSON.parse(strFromU8(f[MANIFEST]!));
          m.objects[1].id = '../x';
          f[MANIFEST] = strToU8(JSON.stringify(m));
        },
        /bad id/,
      ],
    ];
    for (const [what, edit, msg] of cases) {
      expect(() => readProject(tamper(bytes, edit)), what).toThrow(msg);
    }
  });

  it('clamps slot values above 16 to unpainted', () => {
    const { manifest, entries } = projectEntries(sample(), 'x');
    const files = Object.fromEntries(entries.map((e) => [e.path, e.data().slice()]));
    files['objects/a-1/paint.0.u8']![0] = 200;
    files['objects/a-1/layer.L1.0.u8']![0] = 200;
    files['objects/a-1/layer.M1.0.u8']![0] = 7;
    const p = parseProject(manifest, files);
    expect(p.objects[0]!.paint!.maps[0]![0]).toBe(0);
    expect(p.objects[0]!.paint!.doc.maps.get('L1')![0]![0]).toBe(0);
    expect(p.objects[0]!.paint!.doc.maps.get('M1')![0]![0]).toBe(1); // masks are 0/1
  });
});
