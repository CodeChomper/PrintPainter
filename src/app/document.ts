import type { CleanupReport } from '@/core/cleanup';
import type { Bounds, IndexedMesh } from '@/core/mesh';
import type { LengthUnit } from '@/core/units';
import type { ImportFormat } from '@/io/import';

/**
 * The scene's heavy data. Deliberately a plain Map, not Pinia state: typed arrays with
 * millions of entries must never be wrapped in reactive proxies. The scene store keeps
 * small reactive summaries of these objects for the UI.
 */
export interface SceneObject {
  id: string;
  name: string;
  fileName: string;
  format: ImportFormat;
  /** Objects imported from the same file share this, and change units together. */
  importId: string;
  /** Cleaned mesh in source units. */
  mesh: IndexedMesh;
  report: CleanupReport;
  unit: LengthUnit;
  /** Translation in mm applied after scaling by the unit. */
  offset: [number, number, number];
  /** Bounds of `mesh` in source units. */
  srcBounds: Bounds;
}

export const sceneObjects = new Map<string, SceneObject>();
