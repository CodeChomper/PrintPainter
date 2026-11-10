import { describe, expect, it } from 'vitest';
import { cleanupMesh, orientTriangles, weldVertices } from '@/core/cleanup';
import { fromSoup, meshBounds, type IndexedMesh } from '@/core/mesh';

// Unit cube corners and outward-wound (CCW from outside) triangles.
const C = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const CUBE_TRIS = [
  [0, 2, 1], [0, 3, 2], // bottom (-Z)
  [4, 5, 6], [4, 6, 7], // top (+Z)
  [0, 1, 5], [0, 5, 4], // front (-Y)
  [1, 2, 6], [1, 6, 5], // right (+X)
  [2, 3, 7], [2, 7, 6], // back (+Y)
  [3, 0, 4], [3, 4, 7], // left (-X)
];

/** Triangle soup (no shared vertices), like a binary STL. */
function soup(tris: number[][], offset: [number, number, number] = [0, 0, 0]): Float32Array {
  const out: number[] = [];
  for (const t of tris) for (const v of t) out.push(C[v]![0]! + offset[0], C[v]![1]! + offset[1], C[v]![2]! + offset[2]);
  return new Float32Array(out);
}

function signedVolume(m: IndexedMesh): number {
  let v = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
    v += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
      - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
      + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  return v;
}

const flipTri = (t: number[]) => [t[0]!, t[2]!, t[1]!];

describe('cleanupMesh', () => {
  it('welds an STL-style soup cube into a watertight 8-vertex mesh', () => {
    const { mesh, report } = cleanupMesh(fromSoup(soup(CUBE_TRIS)));
    expect(mesh.positions.length / 3).toBe(8);
    expect(report.mergedVertices).toBe(36 - 8);
    expect(report.outputTriangles).toBe(12);
    expect(report.flippedTriangles).toBe(0);
    expect(report.components).toBe(1);
    expect(report.watertight).toBe(true);
    expect(report.openEdges.length).toBe(0);
    expect(signedVolume(mesh)).toBeCloseTo(1);
  });

  it('fixes a single inverted triangle', () => {
    const tris = CUBE_TRIS.map((t, i) => (i === 5 ? flipTri(t) : t));
    const { mesh, report } = cleanupMesh(fromSoup(soup(tris)));
    expect(report.flippedTriangles).toBe(1);
    expect(report.watertight).toBe(true);
    expect(signedVolume(mesh)).toBeCloseTo(1);
  });

  it('turns an inside-out cube outward', () => {
    const { mesh, report } = cleanupMesh(fromSoup(soup(CUBE_TRIS.map(flipTri))));
    expect(report.flippedTriangles).toBe(12);
    expect(report.watertight).toBe(true);
    expect(signedVolume(mesh)).toBeCloseTo(1);
  });

  it('reports open edges for a missing triangle without repairing', () => {
    const { report } = cleanupMesh(fromSoup(soup(CUBE_TRIS.slice(1))));
    expect(report.watertight).toBe(false);
    expect(report.outputTriangles).toBe(11);
    expect(report.openEdges.length / 2).toBe(3);
    expect(report.nonManifoldEdges.length).toBe(0);
  });

  it('removes degenerate and duplicate triangles', () => {
    const tris = [...CUBE_TRIS, [0, 0, 1], CUBE_TRIS[3]!, flipTri(CUBE_TRIS[4]!)];
    const { report } = cleanupMesh(fromSoup(soup(tris)));
    expect(report.removedDegenerate).toBe(1);
    expect(report.removedDuplicate).toBe(2); // same vertex set, either winding
    expect(report.outputTriangles).toBe(12);
    expect(report.watertight).toBe(true);
  });

  it('drops triangles with non-finite coordinates', () => {
    const bad = new Float32Array([...soup(CUBE_TRIS), NaN, 0, 0, 1, 0, 0, 0, 1, 0]);
    const { report } = cleanupMesh(fromSoup(bad));
    expect(report.removedDegenerate).toBe(1);
    expect(report.watertight).toBe(true);
  });

  it('flags non-manifold edges where two cubes share an edge', () => {
    const a = soup(CUBE_TRIS);
    const b = soup(CUBE_TRIS, [1, 1, 0]); // touches the first cube along the edge x=1,y=1
    const { report } = cleanupMesh(fromSoup(new Float32Array([...a, ...b])));
    expect(report.nonManifoldEdges.length / 2).toBe(1);
    expect(report.watertight).toBe(false);
  });

  it('counts separate pieces as components and orients each outward', () => {
    const a = soup(CUBE_TRIS);
    const b = soup(CUBE_TRIS.map(flipTri), [3, 0, 0]);
    const { mesh, report } = cleanupMesh(fromSoup(new Float32Array([...a, ...b])));
    expect(report.components).toBe(2);
    expect(report.flippedTriangles).toBe(12);
    expect(report.watertight).toBe(true);
    expect(signedVolume(mesh)).toBeCloseTo(2);
  });
});

describe('weldVertices', () => {
  it('merges vertices within tolerance, including across hash-cell walls', () => {
    // 0.999999 and 1.000001 sit on opposite sides of a cell boundary for most cell sizes.
    const positions = new Float32Array([0.999999, 0, 0, 1.000001, 0, 0, 5, 5, 5]);
    const { mesh, merged } = weldVertices({ positions, indices: new Uint32Array([0, 1, 2]) }, 1e-4);
    expect(merged).toBe(1);
    expect(Array.from(mesh.indices)).toEqual([0, 0, 1]);
  });

  it('keeps vertices further apart than the tolerance', () => {
    const positions = new Float32Array([0, 0, 0, 0.01, 0, 0]);
    const { merged } = weldVertices({ positions, indices: new Uint32Array([0, 1, 1]) }, 1e-4);
    expect(merged).toBe(0);
  });
});

describe('orientTriangles', () => {
  it('keeps the majority winding on an open surface', () => {
    // Two triangles forming a quad, second one flipped.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 3, 2]);
    const { flipped } = orientTriangles(positions, indices, 4);
    expect(flipped).toBe(1);
    expect(Array.from(indices)).toEqual([0, 1, 2, 0, 2, 3]);
  });
});

describe('meshBounds', () => {
  it('ignores unreferenced vertices', () => {
    const b = meshBounds({ positions: new Float32Array([0, 0, 0, 1, 2, 3, 100, 100, 100]), indices: new Uint32Array([0, 1, 1]) });
    expect(b.max).toEqual([1, 2, 3]);
  });
});

describe('cleanupMesh face IDs', () => {
  it('keeps per-triangle face IDs aligned after removing triangles', () => {
    const tris = [CUBE_TRIS[0]!, [0, 0, 1], ...CUBE_TRIS.slice(1), CUBE_TRIS[3]!];
    const faceIds = Int32Array.from(tris, (_t, i) => (i === 1 ? 99 : i === tris.length - 1 ? 98 : i * 10));
    const { mesh, report } = cleanupMesh({ ...fromSoup(soup(tris)), faceIds });
    expect(report.outputTriangles).toBe(12);
    expect(mesh.faceIds).toBeDefined();
    // The degenerate (99) and duplicate (98) triangles are gone; the rest keep their IDs in order.
    expect(Array.from(mesh.faceIds!)).toEqual([0, ...Array.from({ length: 11 }, (_x, i) => (i + 2) * 10)]);
  });
});
