// STEP → parts, from occt-import-js output. Pure: used by the occt worker and by tests.
import type { OcctNode, OcctParams, OcctResult } from 'occt-import-js';
import type { ImportedPart } from './types';

export type StepQuality = 'draft' | 'normal' | 'fine' | 'veryfine';

/** Tessellation presets: max chordal deviation (mm) and max angle between segments. */
export const STEP_QUALITY: Record<StepQuality, { label: string; deviation: number; angleDeg: number }> = {
  draft: { label: 'Draft', deviation: 0.1, angleDeg: 30 },
  normal: { label: 'Normal', deviation: 0.02, angleDeg: 15 },
  fine: { label: 'Fine', deviation: 0.005, angleDeg: 8 },
  veryfine: { label: 'Very fine', deviation: 0.002, angleDeg: 4 },
};

export const STEP_QUALITY_ORDER: StepQuality[] = ['draft', 'normal', 'fine', 'veryfine'];

export function occtParams(q: StepQuality): OcctParams {
  const p = STEP_QUALITY[q];
  return {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: p.deviation,
    angularDeflection: (p.angleDeg * Math.PI) / 180,
  };
}

const GENERIC_SHAPE_NAME = /^\s*(solid|shell|compound|compsolid|face|shape)?\s*$/i;

/**
 * One part per occt mesh (each solid / assembly instance). Each triangle gets the
 * index of the B-rep face it came from (-1 if occt didn't report one).
 */
export function partsFromOcct(result: OcctResult, fallbackName: string): ImportedPart[] {
  // Name each mesh after the nearest named node above it in the assembly tree.
  const nodeName = new Map<number, string>();
  const walk = (node: OcctNode, inherited: string) => {
    const name = node.name || inherited;
    for (const m of node.meshes) nodeName.set(m, name);
    for (const c of node.children) walk(c, name);
  };
  walk(result.root, '');

  const parts: ImportedPart[] = [];
  const used = new Map<string, number>();
  result.meshes.forEach((m, i) => {
    const idx = m.index.array;
    if (!idx.length) return;
    const triCount = idx.length / 3;
    const faceIds = new Int32Array(triCount).fill(-1);
    m.brep_faces.forEach((f, fi) => {
      for (let t = f.first; t <= f.last && t < triCount; t++) faceIds[t] = fi;
    });
    // OpenCascade labels shapes by type ("SOLID"); the assembly node's product name is more useful.
    const meshName = GENERIC_SHAPE_NAME.test(m.name) ? '' : m.name;
    let name = meshName || nodeName.get(i) || `${fallbackName} ${i + 1}`;
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    parts.push({
      name,
      mesh: {
        positions: Float32Array.from(m.attributes.position.array),
        indices: Uint32Array.from(idx),
        faceIds,
      },
    });
  });
  if (parts.length === 1) parts[0]!.name = fallbackName;
  return parts;
}
