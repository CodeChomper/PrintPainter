/** Indexed triangle mesh. Positions are xyz triples in the mesh's own (source) units. */
export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function triangleCount(mesh: IndexedMesh): number {
  return mesh.indices.length / 3;
}

export function vertexCount(mesh: IndexedMesh): number {
  return mesh.positions.length / 3;
}

/** Bounds over the vertices referenced by triangles (unreferenced vertices are ignored). */
export function meshBounds(mesh: IndexedMesh): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (const i of mesh.indices) {
    for (let k = 0; k < 3; k++) {
      const v = p[i * 3 + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}

export function boundsSize(b: Bounds): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function boundsUnion(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Converts a non-indexed triangle soup (9 floats per triangle) to an IndexedMesh with no sharing. */
export function fromSoup(positions: Float32Array): IndexedMesh {
  const n = positions.length / 3;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  return { positions, indices };
}
