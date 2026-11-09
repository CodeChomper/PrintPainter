import type { IndexedMesh } from '@/core/mesh';
import type { UnitGuess } from '@/core/units';

export type ImportFormat = 'stl' | 'obj' | '3mf' | 'gltf' | 'ply' | 'fbx' | 'step';

/** One object from a file, in file units, with the file's transforms already applied. */
export interface ImportedPart {
  name: string;
  mesh: IndexedMesh;
}

export interface ImportResult {
  fileName: string;
  format: ImportFormat;
  parts: ImportedPart[];
  unit: UnitGuess;
  warnings: string[];
}

export class ImportError extends Error {}
