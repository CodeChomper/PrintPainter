import { defineStore } from 'pinia';
import { ref, shallowRef, watch } from 'vue';
import { History } from '@/core/history';
import { clearMaps, PaintRecorder, remapEdit, swapTiles, type TileEdit } from '@/core/paint';
import type { StrokeEdit } from '@/engine/PaintTool';
import { sceneObjects } from '../document';
import { getViewport } from '../engine';

export type Tool = 'select' | 'brush' | 'eraser';

const SIZE_KEY = 'pp.brushSize';
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

  const history = new History();
  const canUndo = ref(false);
  const canRedo = ref(false);
  const undoLabel = shallowRef<string | null>(null);
  const redoLabel = shallowRef<string | null>(null);
  function refreshHistory() {
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

  function setSize(mm: number) {
    size.value = Math.round(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, mm)) * 10) / 10;
  }

  /** Records tile edits (already applied) for some objects as one undo step. */
  function pushEdits(label: string, edits: { id: string; edit: TileEdit }[]) {
    // Bind to the paint data as it is now; a rebuilt atlas drops these entries.
    const bound = edits
      .map(({ id, edit }) => ({ id, edit, paint: sceneObjects.get(id)?.paint }))
      .filter((b): b is { id: string; edit: TileEdit; paint: NonNullable<typeof b.paint> } => !!b.paint);
    if (!bound.length) return;
    const swap = () => {
      const vp = getViewport();
      for (const b of bound) vp?.uploadPaint(b.id, swapTiles(b.paint.atlas, b.paint.maps, b.edit));
    };
    history.push({
      label,
      targets: bound.map((b) => b.id),
      bytes: bound.reduce((n, b) => n + b.edit.bytes, 0),
      undo: swap,
      redo: swap,
      remapSlots: (lut) => bound.forEach((b) => remapEdit(b.edit, lut)),
    });
    refreshHistory();
  }

  function pushStroke(edits: StrokeEdit[]) {
    pushEdits(tool.value === 'eraser' ? 'Erase' : 'Paint stroke', edits);
  }

  function undo() {
    history.undo();
    refreshHistory();
  }

  function redo() {
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
  }

  /** Removes all paint from an object (undoable). */
  function clearObject(id: string) {
    const o = sceneObjects.get(id);
    if (!o?.paint) return;
    const rec = new PaintRecorder(o.paint.atlas, o.paint.maps);
    if (!clearMaps(o.paint.maps, rec, o.paint.atlas)) return;
    getViewport()?.uploadPaint(id, rec.takeDirty());
    const edit = rec.finish();
    if (edit) pushEdits(`Clear paint on ${o.name}`, [{ id, edit }]);
  }

  return {
    tool,
    size,
    symmetry,
    preview,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    setSize,
    pushStroke,
    undo,
    redo,
    dropHistory,
    remapHistory,
    clearObject,
  };
});
