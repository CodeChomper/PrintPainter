import { defineStore } from 'pinia';
import { ref, shallowRef, watch } from 'vue';
import { History, type HistoryEntry } from '@/core/history';
import { clearMaps, PaintRecorder, remapEdit, swapTiles } from '@/core/paint';
import type { StrokeEdit } from '@/engine/PaintTool';
import { sceneObjects, touchPaint } from '../document';
import { isMaskTarget, useLayersStore } from './layers';

import type { FillMode } from '@/core/fill';

export type Tool = 'select' | 'brush' | 'eraser' | 'fill' | 'line' | 'lasso';
export type { FillMode };

const SIZE_KEY = 'pp.brushSize';
const FILL_KEY = 'pp.fill';
export const FILL_ANGLE_MAX = 90;

const STROKE_LABELS: Record<Tool, string> = {
  select: 'Paint',
  brush: 'Paint stroke',
  eraser: 'Erase',
  fill: 'Fill',
  line: 'Line',
  lasso: 'Lasso fill',
};

function loadFill(): { mode: FillMode; angle: number; through: boolean } {
  const d = { mode: 'angle' as FillMode, angle: 30, through: false };
  try {
    const v = JSON.parse(localStorage.getItem(FILL_KEY) ?? 'null') as Partial<typeof d> | null;
    if (v && ['angle', 'face', 'island'].includes(v.mode as string)) d.mode = v.mode!;
    if (v && typeof v.angle === 'number' && v.angle >= 1 && v.angle <= FILL_ANGLE_MAX) d.angle = v.angle;
    if (v && typeof v.through === 'boolean') d.through = v.through;
  } catch {
    /* ignore */
  }
  return d;
}
export const BRUSH_MIN = 0.2;
export const BRUSH_MAX = 60;

function loadSize(): number {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    if (v >= BRUSH_MIN && v <= BRUSH_MAX) return v;
  } catch {
    /* ignore */
  }
  return 4;
}

/** Tool state and the undo history. The paint itself lives in sceneObjects (outside Vue). */
export const usePaintStore = defineStore('paint', () => {
  const tool = ref<Tool>('select');
  /** Brush diameter in mm. */
  const size = ref(loadSize());
  const symmetry = ref<[boolean, boolean, boolean]>([false, false, false]);
  const preview = ref(false);
  const savedFill = loadFill();
  /** Bucket fill: what stops the fill. */
  const fillMode = ref<FillMode>(savedFill.mode);
  /** Bucket fill (angle mode): largest bend between neighbouring triangles, in degrees. */
  const fillAngle = ref(savedFill.angle);
  /** Lasso: also paint surfaces facing away or hidden behind others. */
  const lassoThrough = ref(savedFill.through);

  const history = new History();
  const canUndo = ref(false);
  const canRedo = ref(false);
  const undoLabel = shallowRef<string | null>(null);
  const redoLabel = shallowRef<string | null>(null);
  /** Bumped whenever any paint changes (strokes, undo/redo, clears, slot remaps). */
  const revision = ref(0);
  function refreshHistory() {
    revision.value++;
    canUndo.value = history.canUndo;
    canRedo.value = history.canRedo;
    undoLabel.value = history.undoLabel;
    redoLabel.value = history.redoLabel;
  }

  watch(size, (v) => {
    try {
      localStorage.setItem(SIZE_KEY, String(v));
    } catch {
      /* ignore */
    }
  });

  watch([fillMode, fillAngle, lassoThrough], ([mode, angle, through]) => {
    try {
      localStorage.setItem(FILL_KEY, JSON.stringify({ mode, angle, through }));
    } catch {
      /* ignore */
    }
  });

  function setSize(mm: number) {
    size.value = Math.round(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, mm)) * 10) / 10;
  }

  /** Records tile edits (already applied to layer maps) as one undo step. */
  function pushEdits(label: string, edits: StrokeEdit[]) {
    // Bind to the paint data as it is now; a rebuilt atlas drops these entries.
    const bound = edits
      .map((e) => {
        const o = sceneObjects.get(e.id);
        return { ...e, atlas: o?.paint?.atlas, mask: !!o && isMaskTarget(o, e.target) };
      })
      .filter((b): b is StrokeEdit & { atlas: NonNullable<typeof b.atlas>; mask: boolean } => !!b.atlas);
    if (!bound.length) return;
    const swap = () => {
      const layers = useLayersStore();
      for (const b of bound) {
        layers.painted(b.id, b.target, swapTiles(b.atlas, b.maps, b.edit));
        touchPaint(b.id, b.target);
      }
    };
    for (const b of bound) touchPaint(b.id, b.target);
    useLayersStore().flush();
    history.push({
      label,
      targets: bound.map((b) => b.id),
      bytes: bound.reduce((n, b) => n + b.edit.bytes, 0),
      undo: swap,
      redo: swap,
      // Painted masks hold 0/1, not filaments.
      remapSlots: (lut) => bound.forEach((b) => !b.mask && remapEdit(b.edit, lut)),
    });
    refreshHistory();
  }

  /** Records some other undoable change (layer stack edits). */
  function pushEntry(e: HistoryEntry) {
    history.push(e);
    refreshHistory();
  }

  /** Notes a paint change that has no undo step of its own. */
  function bump() {
    revision.value++;
  }

  /** A finished brush stroke, line, fill or lasso. */
  function pushStroke(edits: StrokeEdit[], erased = false) {
    const t = tool.value;
    const label = !erased || t === 'eraser' ? STROKE_LABELS[t] : t === 'brush' ? 'Erase' : `Erase (${STROKE_LABELS[t].toLowerCase()})`;
    pushEdits(label, edits);
  }

  function undo() {
    useLayersStore().flush();
    if (!history.canUndo) return;
    history.undo();
    refreshHistory();
  }

  function redo() {
    useLayersStore().flush();
    if (!history.canRedo) return;
    history.redo();
    refreshHistory();
  }

  /** Forget undo steps for an object (it was removed, or its paint surface rebuilt). */
  function dropHistory(id: string) {
    history.drop(id);
    refreshHistory();
  }

  function remapHistory(lut: Uint8Array) {
    history.remapSlots(lut);
    revision.value++;
  }

  /** Clears the paint layer or painted mask that the tools paint on (undoable). Returns an error message. */
  function clearTarget(id: string): string | null {
    const o = sceneObjects.get(id);
    if (!o?.paint) return null;
    const layers = useLayersStore();
    const t = layers.paintTarget(id);
    if (typeof t === 'string') return t;
    const rec = new PaintRecorder(o.paint.atlas, t.maps);
    if (!clearMaps(t.maps, rec, o.paint.atlas)) return null;
    layers.painted(id, t.id, rec.takeDirty());
    const edit = rec.finish();
    if (edit) pushEdits(t.mask ? 'Clear mask' : 'Clear layer', [{ id, edit, target: t.id, maps: t.maps }]);
    return null;
  }

  return {
    tool,
    size,
    symmetry,
    preview,
    fillMode,
    fillAngle,
    lassoThrough,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    revision,
    setSize,
    pushStroke,
    pushEntry,
    bump,
    undo,
    redo,
    dropHistory,
    remapHistory,
    clearTarget,
  };
});
