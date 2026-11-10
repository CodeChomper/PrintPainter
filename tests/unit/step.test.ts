// Runs the real occt-import-js WASM in Node on CAx-IF / sample files shipped inside the
// occt-import-js package (read in place, not copied into this repo).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OcctModule } from 'occt-import-js';
import { cleanupMesh } from '@/core/cleanup';
import { boundsSize, meshBounds } from '@/core/mesh';
import { occtParams, partsFromOcct } from '@/io/import/step';

const require = createRequire(import.meta.url);
const testFile = (p: string) => readFileSync(require.resolve(`occt-import-js/test/testfiles/${p}`));

let occt: OcctModule;
beforeAll(async () => {
  occt = await (require('occt-import-js') as () => Promise<OcctModule>)();
}, 60_000);

describe('STEP import (occt-import-js)', () => {
  it('reads a simple cube with 6 B-rep faces and cleans it to a watertight mesh', () => {
    const result = occt.ReadStepFile(testFile('simple-basic-cube/cube.stp'), occtParams('normal'));
    expect(result.success).toBe(true);
    const parts = partsFromOcct(result, 'cube');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.name).toBe('cube');
    const { mesh, report } = cleanupMesh(parts[0]!.mesh);
    expect(report.watertight).toBe(true);
    expect(new Set(mesh.faceIds).size).toBe(6);
    expect(mesh.faceIds!.includes(-1)).toBe(false);
  });

  it('splits an assembly into separate parts, each with face IDs', () => {
    const result = occt.ReadStepFile(testFile('cax-if/as1_pe_203.stp'), occtParams('draft'));
    expect(result.success).toBe(true);
    const parts = partsFromOcct(result, 'as1');
    expect(parts.length).toBeGreaterThan(1);
    expect(new Set(parts.map((p) => p.name)).size).toBe(parts.length); // names made unique
    // Product names from the assembly tree, not OpenCascade's generic "SOLID".
    expect(parts[0]!.name).toBe('PLATE');
    expect(parts.some((p) => p.name.startsWith('ROD_ASM'))).toBe(true);
    expect(parts.some((p) => /^solid/i.test(p.name))).toBe(false);
    for (const p of parts) {
      expect(p.mesh.faceIds!.length).toBe(p.mesh.indices.length / 3);
      const { report } = cleanupMesh({ ...p.mesh, positions: p.mesh.positions.slice(), indices: p.mesh.indices.slice() });
      expect(report.outputTriangles).toBeGreaterThan(0);
    }
  });

  it('finer quality gives more triangles on curved parts', () => {
    const bytes = testFile('cax-if/as1_pe_203.stp');
    const count = (q: 'draft' | 'fine') =>
      partsFromOcct(occt.ReadStepFile(bytes, occtParams(q)), 'as1').reduce((n, p) => n + p.mesh.indices.length / 3, 0);
    expect(count('fine')).toBeGreaterThan(count('draft'));
  });

  it('converts inch files to millimetres (as1 is authored in inches)', () => {
    const result = occt.ReadStepFile(testFile('cax-if/as1_pe_203.stp'), occtParams('draft'));
    const size = boundsSize(meshBounds(partsFromOcct(result, 'as1')[0]!.mesh));
    expect(size[0]).toBeCloseTo(180 * 25.4, 1);
  });

  it('outputs millimetres', () => {
    const result = occt.ReadStepFile(testFile('cube-10x10mm/Cube 10x10.stp'), occtParams('normal'));
    expect(result.success).toBe(true);
    const size = boundsSize(meshBounds(partsFromOcct(result, 'c')[0]!.mesh));
    expect(size[0]).toBeCloseTo(10, 3);
  });
});
