import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { boundsSize, boundsUnion, meshBounds, type Bounds } from '@/core/mesh';
import { findFreeSpot, type Rect } from '@/core/placement';
import { UNIT_TO_MM, type LengthUnit, type UnitGuess } from '@/core/units';
import { IMPORT_EXTENSIONS, ImportError, importFile, type ImportFormat } from '@/io/import';
import { platform } from '@/platform';
import { sceneObjects, type SceneObject } from '../document';
import { getViewport } from '../engine';
import { cleanupInWorker } from '../services/workers';
import { useUiStore } from './ui';

export interface ObjectSummary {
  id: string;
  name: string;
  fileName: string;
  format: ImportFormat;
  triangles: number;
  unit: LengthUnit;
  /** Size in mm. */
  dims: [number, number, number];
  watertight: boolean;
  openEdges: number;
  nonManifoldEdges: number;
  inconsistentEdges: number;
  mergedVertices: number;
  removedDegenerate: number;
  removedDuplicate: number;
  flippedTriangles: number;
  components: number;
}

export interface UnitQuestion {
  fileName: string;
  /** X, Y, Z size in file units. */
  size: [number, number, number];
  guess: UnitGuess;
}

// Matches the viewport's default plate. Printer/plate selection comes later.
const PLATE = { w: 256, d: 256 };

function footprint(o: SceneObject): Rect {
  const s = UNIT_TO_MM[o.unit];
  const b = o.srcBounds;
  return {
    minX: b.min[0] * s + o.offset[0],
    maxX: b.max[0] * s + o.offset[0],
    minY: b.min[1] * s + o.offset[1],
    maxY: b.max[1] * s + o.offset[1],
  };
}

function summarize(o: SceneObject): ObjectSummary {
  const r = o.report;
  const s = UNIT_TO_MM[o.unit];
  const size = boundsSize(o.srcBounds);
  return {
    id: o.id,
    name: o.name,
    fileName: o.fileName,
    format: o.format,
    triangles: r.outputTriangles,
    unit: o.unit,
    dims: [size[0] * s, size[1] * s, size[2] * s],
    watertight: r.watertight,
    openEdges: r.openEdges.length / 2,
    nonManifoldEdges: r.nonManifoldEdges.length / 2,
    inconsistentEdges: r.inconsistentEdges,
    mergedVertices: r.mergedVertices,
    removedDegenerate: r.removedDegenerate,
    removedDuplicate: r.removedDuplicate,
    flippedTriangles: r.flippedTriangles,
    components: r.components,
  };
}

export const useSceneStore = defineStore('scene', () => {
  const ui = useUiStore();
  const items = ref<ObjectSummary[]>([]);
  const selectedId = ref<string | null>(null);
  const busy = ref<string | null>(null);
  const showEdges = ref(true);
  const unitQuestion = ref<UnitQuestion | null>(null);
  let answerUnit: ((u: LengthUnit | null) => void) | null = null;

  const selected = computed(() => items.value.find((i) => i.id === selectedId.value) ?? null);

  function askUnit(q: UnitQuestion): Promise<LengthUnit | null> {
    unitQuestion.value = q;
    return new Promise((resolve) => (answerUnit = resolve));
  }

  function answerUnitQuestion(u: LengthUnit | null) {
    unitQuestion.value = null;
    answerUnit?.(u);
    answerUnit = null;
  }

  async function openImportDialog() {
    const files = await platform.openFiles({
      description: '3D models',
      extensions: IMPORT_EXTENSIONS,
      multiple: true,
    });
    await importFiles(files);
  }

  async function importFiles(files: File[]) {
    for (const file of files) {
      busy.value = `Importing ${file.name}…`;
      try {
        await importOne(file);
      } catch (e) {
        const msg = e instanceof ImportError ? e.message : `${file.name}: ${(e as Error).message ?? e}`;
        ui.notify('error', msg);
        if (!(e instanceof ImportError)) console.error(e);
      } finally {
        busy.value = null;
      }
    }
  }

  async function importOne(file: File) {
    const result = await importFile(file);
    result.warnings.forEach((w) => ui.notify('warning', `${file.name}: ${w}`));

    let unit = result.unit.unit;
    if (!result.unit.certain) {
      const b = result.parts.map((p) => meshBounds(p.mesh)).reduce<Bounds>((a, x) => boundsUnion(a, x), meshBounds(result.parts[0]!.mesh));
      const size = boundsSize(b);
      const answer = await askUnit({ fileName: file.name, size, guess: result.unit });
      if (!answer) return;
      unit = answer;
    }

    busy.value = `Checking ${file.name}…`;
    const cleaned = [];
    for (const part of result.parts) {
      const { mesh, report } = await cleanupInWorker(part.mesh);
      if (report.outputTriangles === 0) continue;
      cleaned.push({ name: part.name, mesh, report, srcBounds: meshBounds(mesh) });
    }
    if (!cleaned.length) throw new ImportError(`${file.name}: no usable triangles after cleanup.`);

    // Keep the parts' relative positions, sit the import on Z=0 and put it in the
    // free spot nearest the plate centre.
    const scale = UNIT_TO_MM[unit];
    const all = cleaned.map((c) => c.srcBounds).reduce((a, b) => boundsUnion(a, b));
    const [cx, cy] = findFreeSpot(
      (all.max[0] - all.min[0]) * scale,
      (all.max[1] - all.min[1]) * scale,
      [...sceneObjects.values()].map(footprint),
      PLATE,
    );
    const offset: [number, number, number] = [
      cx - ((all.min[0] + all.max[0]) / 2) * scale,
      cy - ((all.min[1] + all.max[1]) / 2) * scale,
      -all.min[2] * scale,
    ];

    const vp = getViewport();
    let lastId = '';
    for (const c of cleaned) {
      const obj: SceneObject = {
        id: crypto.randomUUID(),
        name: c.name,
        fileName: file.name,
        format: result.format,
        mesh: c.mesh,
        report: c.report,
        unit,
        offset: [...offset],
        srcBounds: c.srcBounds,
      };
      sceneObjects.set(obj.id, obj);
      vp?.addObject(obj.id, obj.mesh, obj.report.openEdges, obj.report.nonManifoldEdges);
      vp?.setObjectTransform(obj.id, scale, obj.offset);
      items.value.push(summarize(obj));
      lastId = obj.id;

      const s = items.value[items.value.length - 1]!;
      if (!s.watertight) {
        const bits = [
          s.openEdges && `${s.openEdges} open edge${s.openEdges === 1 ? '' : 's'} (red)`,
          s.nonManifoldEdges && `${s.nonManifoldEdges} non-manifold edge${s.nonManifoldEdges === 1 ? '' : 's'} (orange)`,
          s.inconsistentEdges && `${s.inconsistentEdges} edges with mixed winding`,
        ].filter(Boolean);
        ui.notify('warning', `${s.name} isn't watertight: ${bits.join(', ')}. PrintPainter doesn't repair meshes; the slicer may.`);
      }
    }
    vp?.setEdgeHighlightsVisible(showEdges.value);
    select(lastId);
    vp?.frame();
  }

  function select(id: string | null) {
    selectedId.value = id;
    getViewport()?.setSelected(id);
  }

  function remove(id: string) {
    sceneObjects.delete(id);
    getViewport()?.removeObject(id);
    items.value = items.value.filter((i) => i.id !== id);
    if (selectedId.value === id) select(null);
  }

  /** Changes an object's source unit, keeping its bottom centre where it is on the plate. */
  function setUnit(id: string, unit: LengthUnit) {
    const o = sceneObjects.get(id);
    if (!o || o.unit === unit) return;
    const b = o.srcBounds;
    const bc = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]] as const;
    const oldS = UNIT_TO_MM[o.unit];
    const newS = UNIT_TO_MM[unit];
    o.offset = [0, 1, 2].map((k) => bc[k]! * oldS + o.offset[k]! - bc[k]! * newS) as [number, number, number];
    o.unit = unit;
    getViewport()?.setObjectTransform(id, newS, o.offset);
    const i = items.value.findIndex((x) => x.id === id);
    if (i >= 0) items.value[i] = summarize(o);
  }

  /** Rebuilds the viewport's objects from the scene document (after the viewport is recreated). */
  function syncViewport() {
    const vp = getViewport();
    if (!vp) return;
    for (const o of sceneObjects.values()) {
      vp.addObject(o.id, o.mesh, o.report.openEdges, o.report.nonManifoldEdges);
      vp.setObjectTransform(o.id, UNIT_TO_MM[o.unit], o.offset);
    }
    vp.setEdgeHighlightsVisible(showEdges.value);
    vp.setSelected(selectedId.value);
    if (sceneObjects.size) vp.frame();
  }

  function setShowEdges(v: boolean) {
    showEdges.value = v;
    getViewport()?.setEdgeHighlightsVisible(v);
  }

  return {
    items,
    selectedId,
    selected,
    busy,
    showEdges,
    unitQuestion,
    answerUnitQuestion,
    openImportDialog,
    importFiles,
    select,
    remove,
    setUnit,
    setShowEdges,
    syncViewport,
  };
});
