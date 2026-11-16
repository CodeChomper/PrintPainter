import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { CutMesh } from '@/core/export/cut';
import { UNIT_TO_MM } from '@/core/units';
import type { ExportObject } from '@/io/export/3mf/bambu';
import { platform } from '@/platform';
import { sceneObjects, type SceneObject } from '../document';
import { getViewport } from '../engine';
import { cancelExportWork, cutInWorker, write3mfInWorker } from '../services/workers';
import { usePaintStore } from './paint';
import { usePaletteStore } from './palette';
import { PLATE, useSceneStore } from './scene';
import { useUiStore } from './ui';

const SMOOTH_KEY = 'pp.exportSmooth';
export const SMOOTH_MAX = 0.3;
const SMOOTH_DEFAULT = 0.05;

export type CutState = 'waiting' | 'cutting' | 'done' | 'uncut' | 'error';

export interface CutSummary {
  id: string;
  name: string;
  state: CutState;
  progress: number;
  triangles: number;
  sourceTriangles: number;
  watertight: boolean;
  sourceWatertight: boolean;
  fallbacks: number;
  /** Slots (1..16) this object uses. */
  slots: number[];
  error: string | null;
}

function loadSmooth(): number {
  try {
    const v = Number(localStorage.getItem(SMOOTH_KEY) ?? SMOOTH_DEFAULT);
    if (v >= 0 && v <= SMOOTH_MAX) return v;
  } catch {
    /* ignore */
  }
  return SMOOTH_DEFAULT;
}

/** Export panel state: cuts visible objects in a worker, previews them, writes the 3MF. */
export const useExportStore = defineStore('export', () => {
  const ui = useUiStore();
  const scene = useSceneStore();
  const paint = usePaintStore();
  const palette = usePaletteStore();

  const open = ref(false);
  const smoothMm = ref(loadSmooth());
  const showCut = ref(true);
  const summaries = ref<CutSummary[]>([]);
  const writing = ref(false);
  // Heavy results stay out of Vue's reactivity.
  const cache = new Map<string, { key: string; cut: CutMesh }>();
  let job = 0;
  let running = false;

  watch(smoothMm, (v) => {
    try {
      localStorage.setItem(SMOOTH_KEY, String(v));
    } catch {
      /* ignore */
    }
  });

  const objects = () => [...sceneObjects.values()].filter((o) => !o.hidden);
  const keyOf = (o: SceneObject) => `${smoothMm.value}|${paint.revision}|${o.paintJob}|${o.unit}`;

  const busy = computed(() => summaries.value.some((s) => s.state === 'cutting' || s.state === 'waiting'));
  const ready = computed(() => summaries.value.length > 0 && !busy.value && !writing.value);
  const usedSlots = computed(() => [...new Set(summaries.value.flatMap((s) => s.slots))].sort((a, b) => a - b));
  const totalTriangles = computed(() => summaries.value.reduce((n, s) => n + s.triangles, 0));
  const allWatertight = computed(() => summaries.value.every((s) => s.watertight));

  function summaryFor(o: SceneObject): CutSummary {
    const c = cache.get(o.id);
    if (c && c.key === keyOf(o)) {
      const st = c.cut.stats;
      return {
        id: o.id,
        name: o.name,
        state: 'done',
        progress: 1,
        triangles: st.triangles,
        sourceTriangles: st.sourceTriangles,
        watertight: st.watertight,
        sourceWatertight: st.sourceWatertight,
        fallbacks: st.fallbacks,
        slots: st.slotTriangles.flatMap((n, s) => (n ? [s] : [])),
        error: null,
      };
    }
    const base: CutSummary = {
      id: o.id,
      name: o.name,
      state: 'waiting',
      progress: 0,
      triangles: o.report.outputTriangles,
      sourceTriangles: o.report.outputTriangles,
      watertight: o.report.watertight,
      sourceWatertight: o.report.watertight,
      fallbacks: 0,
      slots: [],
      error: null,
    };
    if (o.paintState === 'failed') return { ...base, state: 'uncut', slots: [1], error: o.paintError ?? null };
    return base;
  }

  function patch(id: string, p: Partial<CutSummary>) {
    const i = summaries.value.findIndex((s) => s.id === id);
    if (i >= 0) summaries.value[i] = { ...summaries.value[i]!, ...p };
  }

  /** Brings every visible object's cut up to date. Restarts if called again mid-way. */
  async function refresh() {
    if (!open.value) return;
    const my = ++job;
    if (running) cancelExportWork();
    const list = objects();
    summaries.value = list.map(summaryFor);
    updatePreviews();
    running = true;
    try {
      for (const o of list) {
        if (my !== job) return;
        const s = summaries.value.find((x) => x.id === o.id);
        if (!s || s.state !== 'waiting' || o.paintState !== 'ready' || !o.paint) continue;
        const key = keyOf(o);
        patch(o.id, { state: 'cutting', progress: 0 });
        let cut: CutMesh;
        try {
          cut = await cutInWorker(o.mesh, o.paint.atlas, o.paint.maps, smoothMm.value, o.paint.texelMm, (f) => {
            if (my === job) patch(o.id, { progress: f });
          });
        } catch (e) {
          if (my !== job) return;
          patch(o.id, { state: 'error', error: (e as Error).message || 'Cutting failed.' });
          continue;
        }
        if (my !== job) return;
        cache.set(o.id, { key, cut });
        patch(o.id, summaryFor(o));
        updatePreviews();
      }
    } finally {
      if (my === job) running = false;
    }
  }

  function updatePreviews() {
    const vp = getViewport();
    if (!vp) return;
    for (const o of sceneObjects.values()) {
      const c = cache.get(o.id);
      const show = open.value && showCut.value && !o.hidden && c && c.key === keyOf(o);
      vp.setCutPreview(o.id, show ? c.cut : null);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 200);
  };
  watch(
    () => [open.value, smoothMm.value, paint.revision, scene.items.map((i) => `${i.id}:${i.hidden}:${i.paintState}:${i.unit}:${i.texelMm}`).join()],
    () => (open.value ? scheduleRefresh() : undefined),
  );
  watch(showCut, updatePreviews);
  // Picking up a brush leaves the export view.
  watch(
    () => paint.tool,
    (t) => {
      if (open.value && t !== 'select') close();
    },
  );

  function show() {
    paint.tool = 'select';
    open.value = true;
  }

  function close() {
    open.value = false;
    job++;
    if (running) cancelExportWork();
    running = false;
    updatePreviews();
  }

  // Objects that are gone don't need their cuts any more.
  watch(
    () => scene.items.map((i) => i.id).join(),
    () => {
      for (const id of cache.keys()) if (!sceneObjects.has(id)) cache.delete(id);
    },
  );

  async function exportFile() {
    if (!ready.value) return;
    const list = objects();
    if (!list.length) return;
    const out: ExportObject[] = [];
    for (const o of list) {
      const s = UNIT_TO_MM[o.unit];
      const c = cache.get(o.id);
      const usable = c && c.key === keyOf(o) ? c.cut : null;
      const src = usable ? usable.positions : o.mesh.positions;
      const positions = new Float64Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        positions[i] = src[i]! * s + o.offset[0];
        positions[i + 1] = src[i + 1]! * s + o.offset[1];
        positions[i + 2] = src[i + 2]! * s + o.offset[2];
      }
      out.push({
        name: o.name,
        positions,
        // Copies: the arrays are handed to the worker, the cache keeps its own.
        indices: usable ? usable.indices.slice() : o.mesh.indices.slice(),
        slots: usable ? usable.slots.slice() : new Uint8Array(o.mesh.indices.length / 3).fill(1),
      });
    }
    writing.value = true;
    try {
      const bytes = await write3mfInWorker(out, {
        application: `PrintPainter-${__APP_VERSION__}`,
        palette: palette.slots.map((p) => ({ ...p })),
        plateCentre: [PLATE.w / 2, PLATE.d / 2],
      });
      const name = list.length === 1 ? list[0]!.name : 'PrintPainter';
      const saved = await platform.saveFile(new Blob([bytes as BlobPart], { type: 'model/3mf' }), {
        suggestedName: `${name}.3mf`,
        description: '3MF model',
        extension: '3mf',
        mime: 'model/3mf',
      });
      if (saved) {
        const n = usedSlots.value.length;
        ui.notify(
          'info',
          `Exported ${list.length} object${list.length === 1 ? '' : 's'} using ${n} filament${n === 1 ? '' : 's'}. In the slicer, set filament N to the colour of slot N.`,
        );
      }
    } catch (e) {
      ui.notify('error', `Export failed: ${(e as Error).message}`);
    } finally {
      writing.value = false;
    }
  }

  return {
    open,
    smoothMm,
    showCut,
    summaries,
    writing,
    busy,
    ready,
    usedSlots,
    totalTriangles,
    allWatertight,
    show,
    close,
    exportFile,
  };
});
