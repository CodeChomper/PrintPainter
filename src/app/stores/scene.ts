import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { boundsSize, boundsUnion, meshBounds, type Bounds } from '@/core/mesh';
import { findFreeSpot, type Rect } from '@/core/placement';
import { formatDims, UNIT_TO_MM, type LengthUnit, type UnitGuess } from '@/core/units';
import {
  formatFromName,
  IMPORT_EXTENSIONS,
  ImportError,
  importFile,
  releaseStepWorker,
  STEP_QUALITY,
  type ImportFormat,
  type ImportOptions,
  type StepQuality,
} from '@/io/import';
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
  /** Number of STEP B-rep faces, or null for mesh formats. */
  cadFaces: number | null;
  /** How many objects came from the same import (including this one). */
  siblings: number;
}

export interface UnitQuestion {
  fileName: string;
  /** X, Y, Z size in file units. */
  size: [number, number, number];
  guess: UnitGuess;
}

const STEP_KEY = 'pp.stepQuality';

function loadStepQuality(): StepQuality {
  try {
    const v = localStorage.getItem(STEP_KEY);
    if (v && v in STEP_QUALITY) return v as StepQuality;
  } catch {
    /* storage unavailable */
  }
  return 'normal';
}

function countFaces(ids: Int32Array | undefined): number | null {
  if (!ids) return null;
  const s = new Set<number>();
  for (const id of ids) if (id >= 0) s.add(id);
  return s.size;
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

function siblingsOf(o: SceneObject): SceneObject[] {
  return [...sceneObjects.values()].filter((x) => x.importId === o.importId);
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
    cadFaces: countFaces(o.mesh.faceIds),
    siblings: siblingsOf(o).length,
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
  /** STEP file names waiting for a quality choice, or null. */
  const stepQuestion = ref<string[] | null>(null);
  const stepQuality = ref<StepQuality>(loadStepQuality());
  let answerStep: ((q: StepQuality | null) => void) | null = null;

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

  function askStepQuality(fileNames: string[]): Promise<StepQuality | null> {
    stepQuestion.value = fileNames;
    return new Promise((resolve) => (answerStep = resolve));
  }

  function answerStepQuestion(q: StepQuality | null) {
    stepQuestion.value = null;
    if (q) {
      stepQuality.value = q;
      try {
        localStorage.setItem(STEP_KEY, q);
      } catch {
        /* ignore */
      }
    }
    answerStep?.(q);
    answerStep = null;
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
    // Ask once per batch for STEP tessellation quality.
    const steps = files.filter((f) => formatFromName(f.name) === 'step');
    let options: ImportOptions = {};
    if (steps.length) {
      const q = await askStepQuality(steps.map((f) => f.name));
      if (!q) files = files.filter((f) => !steps.includes(f));
      options = { stepQuality: q ?? undefined };
    }
    try {
      for (const file of files) {
        busy.value = formatFromName(file.name) === 'step' ? `Tessellating ${file.name}…` : `Importing ${file.name}…`;
        try {
          await importOne(file, options);
        } catch (e) {
          const msg = e instanceof ImportError ? e.message : `${file.name}: ${(e as Error).message ?? e}`;
          ui.notify('error', msg);
          if (!(e instanceof ImportError)) console.error(e);
        } finally {
          busy.value = null;
        }
      }
    } finally {
      if (steps.length) releaseStepWorker();
    }
  }

  async function importOne(file: File, options: ImportOptions) {
    const result = await importFile(file, options);
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
    const importSize = boundsSize(all).map((v) => v * scale);
    if (importSize[0]! > PLATE.w || importSize[1]! > PLATE.d) {
      ui.notify('warning', `${file.name} is ${formatDims(importSize)}, bigger than the ${PLATE.w} × ${PLATE.d} mm plate. If that's wrong, change its units in Properties.`);
    }
    const offset: [number, number, number] = [
      cx - ((all.min[0] + all.max[0]) / 2) * scale,
      cy - ((all.min[1] + all.max[1]) / 2) * scale,
      -all.min[2] * scale,
    ];

    const vp = getViewport();
    const importId = crypto.randomUUID();
    let lastId = '';
    for (const c of cleaned) {
      const obj: SceneObject = {
        id: crypto.randomUUID(),
        name: c.name,
        fileName: file.name,
        format: result.format,
        importId,
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
    refreshSummaries(importId);
    vp?.setEdgeHighlightsVisible(showEdges.value);
    select(lastId);
    vp?.frame();
  }

  function select(id: string | null) {
    selectedId.value = id;
    getViewport()?.setSelected(id);
  }

  /** Re-summarizes every object from one import (sibling counts, units, sizes). */
  function refreshSummaries(importId: string) {
    items.value = items.value.map((it) => {
      const o = sceneObjects.get(it.id);
      return o && o.importId === importId ? summarize(o) : it;
    });
  }

  function remove(id: string) {
    const o = sceneObjects.get(id);
    sceneObjects.delete(id);
    getViewport()?.removeObject(id);
    items.value = items.value.filter((i) => i.id !== id);
    if (o) refreshSummaries(o.importId);
    if (selectedId.value === id) select(null);
  }

  /**
   * Changes the source unit of every object from the same import (a file has one unit).
   * They scale together around the group's bottom centre, so assemblies stay assembled
   * and the group stays where it was on the plate.
   */
  function setUnit(id: string, unit: LengthUnit) {
    const o = sceneObjects.get(id);
    if (!o || o.unit === unit) return;
    const group = siblingsOf(o);
    const world = group
      .map((g) => {
        const s = UNIT_TO_MM[g.unit];
        const b = g.srcBounds;
        return {
          min: [0, 1, 2].map((k) => b.min[k]! * s + g.offset[k]!),
          max: [0, 1, 2].map((k) => b.max[k]! * s + g.offset[k]!),
        } as Bounds;
      })
      .reduce((a, b) => boundsUnion(a, b));
    const pivot = [(world.min[0] + world.max[0]) / 2, (world.min[1] + world.max[1]) / 2, world.min[2]];
    const vp = getViewport();
    for (const g of group) {
      const ratio = UNIT_TO_MM[unit] / UNIT_TO_MM[g.unit];
      g.offset = [0, 1, 2].map((k) => pivot[k]! + (g.offset[k]! - pivot[k]!) * ratio) as [number, number, number];
      g.unit = unit;
      vp?.setObjectTransform(g.id, UNIT_TO_MM[unit], g.offset);
    }
    refreshSummaries(o.importId);
    vp?.frame(); // the size may have changed a lot
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
    stepQuestion,
    stepQuality,
    answerStepQuestion,
    openImportDialog,
    importFiles,
    select,
    remove,
    setUnit,
    setShowEdges,
    syncViewport,
  };
});
