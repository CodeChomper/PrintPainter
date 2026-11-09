import { Matrix4, Vector3, type BufferGeometry, type Mesh, type Object3D } from 'three';
import type { ImportedPart } from './types';

/**
 * Collects the meshes under a three.js object into parts with world transforms baked in.
 * Meshes that share a name (an OBJ object split by material, a glTF mesh with several
 * primitives) are merged into one part.
 */
export function partsFromObject3D(root: Object3D, fallbackName: string): ImportedPart[] {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { pos: number[]; idx: number[] }>();
  let unnamed = 0;
  const v = new Vector3();

  root.traverse((o) => {
    if (!(o as Mesh).isMesh) return;
    const mesh = o as Mesh;
    const geom = mesh.geometry as BufferGeometry;
    const attr = geom.getAttribute('position');
    if (!attr || attr.count === 0) return;

    const name = mesh.name || mesh.parent?.name || `${fallbackName} ${++unnamed}`;
    let g = groups.get(name);
    if (!g) groups.set(name, (g = { pos: [], idx: [] }));

    const m: Matrix4 = mesh.matrixWorld;
    const base = g.pos.length / 3;
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(m);
      g.pos.push(v.x, v.y, v.z);
    }
    const mirror = m.determinant() < 0;
    const index = geom.getIndex();
    const triCount = index ? index.count / 3 : attr.count / 3;
    for (let t = 0; t < triCount; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      if (mirror) g.idx.push(base + a, base + c, base + b);
      else g.idx.push(base + a, base + b, base + c);
    }
  });

  const parts: ImportedPart[] = [];
  for (const [name, g] of groups) {
    if (!g.idx.length) continue;
    parts.push({ name, mesh: { positions: new Float32Array(g.pos), indices: new Uint32Array(g.idx) } });
  }
  // A single part takes the file's name rather than a generic node name.
  if (parts.length === 1) parts[0]!.name = fallbackName;
  return parts;
}
