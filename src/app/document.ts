import type { PaintAtlas } from '@/core/atlas';
import type { LayerDoc } from '@/core/layers';
import type { CleanupReport } from '@/core/cleanup';
import type { Bounds, IndexedMesh } from '@/core/mesh';
import type { LengthUnit } from '@/core/units';
import type { ImportFormat } from '@/io/import';

export type PaintState = 'preparing' | 'ready' | 'failed';

export interface ObjectPaint {
  atlas: PaintAtlas;
  /**
   * The layers combined: one slot map per atlas page (0 = unpainted, 1..16 = slot).
   * What the viewport shows and the export cuts. Written only by the layer composer.
   */
  maps: Uint8Array[];
  /** The layer stack and its maps. */
  doc: LayerDoc;
  /** Per layer or mask map id: bumped when that map changes (autosave change tracking). */
  mapRevs: Map<string, number>;
  /** Texel edge in mm. */
  texelMm: number;
}

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
  hidden: boolean;
  paint: ObjectPaint | null;
  paintState: PaintState;
  paintError?: string;
  /** Bumped per atlas build so a stale result is ignored. */
  paintJob: number;
  /** Atlas the paint was last saved with (autosave change tracking). */
  surfaceRev: number;
  /** Bumped whenever this object's slot maps change (autosave change tracking). */
  paintRev: number;
}

export const sceneObjects = new Map<string, SceneObject>();

/** Notes that an object's paint changed (and which layer map, if one), so the autosave writes it again. */
export function touchPaint(id: string, mapId?: string): void {
  const o = sceneObjects.get(id);
  if (!o) return;
  o.paintRev++;
  if (mapId && o.paint) o.paint.mapRevs.set(mapId, (o.paint.mapRevs.get(mapId) ?? 0) + 1);
}
