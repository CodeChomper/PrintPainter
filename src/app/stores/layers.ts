import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import {
  cloneLayers,
  Composer,
  exclusiveBytes,
  isMaskMap,
  newId,
  type DecalBitmap,
  type DecalMask,
  type Layer,
  type LayerDoc,
  type Mask,
  type MaskKind,
} from '@/core/layers';
import { createMaps, type Rect } from '@/core/paint';
import { UNIT_TO_MM } from '@/core/units';
import { sceneObjects, touchPaint, type ObjectPaint, type SceneObject } from '../document';
import { getViewport } from '../engine';
import { usePaintStore } from './paint';

const composers = new WeakMap<ObjectPaint, Composer>();

/** The composer for an object's current paint surface (made on first use). */
export function composerOf(o: SceneObject): Composer | null {
  const p = o.paint;
  if (!p) return null;
  let c = composers.get(p);
  if (!c) {
    c = new Composer(p.atlas, { mmPerUnit: UNIT_TO_MM[o.unit], minZ: o.srcBounds.min[2] }, p.doc, p.maps);
    composers.set(p, c);
  }
  return c;
}

/** Recomposites an object's paint from its layers and shows it. */
export function recomposite(id: string): void {
  const o = sceneObjects.get(id);
  const c = o && composerOf(o);
  if (!c) return;
  c.refresh();
  getViewport()?.uploadPaint(id, 'all');
}

/** What the paint tools write into: a paint layer's maps or a painted mask's. */
export interface PaintTarget {
  /** Layer or mask id (the map id). */
  id: string;
  maps: Uint8Array[];
  /** Painted mask: write 1, not the slot. */
  mask: boolean;
}

interface Snapshot {
  layers: Layer[];
  maps: LayerDoc['maps'];
  bitmaps: LayerDoc['bitmaps'];
}
const snap = (d: LayerDoc): Snapshot => ({ layers: cloneLayers(d.layers), maps: new Map(d.maps), bitmaps: new Map(d.bitmaps) });

/** Set while the palette remaps slots, so maps shared by several undo steps are remapped once. */
let remapSeen: WeakSet<Uint8Array> | null = null;
function remapOnce(maps: Uint8Array[], lut: Uint8Array) {
  for (const m of maps) {
    if (remapSeen?.has(m)) continue;
    remapSeen?.add(m);
    for (let i = 0; i < m.length; i++) m[i] = lut[m[i]!]!;
  }
}

export const MASK_LABELS: Record<MaskKind, string> = {
  painted: 'Painted',
  angle: 'Facing',
  height: 'Height',
  edge: 'Edges',
  decal: 'Decal',
};

/** The layer stacks' UI state, and every change to them (undoable). */
export const useLayersStore = defineStore('layers', () => {
  /** Bumped on any layer change, so views re-read the (non-reactive) documents. */
  const rev = ref(0);
  /** Per object: the selected layer and what painting writes to ('content' or a mask id). */
  const active = reactive<Record<string, { layer: string; target: string }>>({});
  /** A decal waiting for a click on the model to place it. */
  const placing = ref<{ object: string; layer: string; mask: string } | null>(null);

  const docOf = (id: string | null) => (id ? sceneObjects.get(id)?.paint?.doc ?? null : null);

  function selection(id: string): { layer: string; target: string } | null {
    const doc = docOf(id);
    if (!doc?.layers.length) return null;
    let a = active[id];
    const layer = a && doc.layers.find((l) => l.id === a!.layer);
    if (!a || !layer) {
      const top = doc.layers[doc.layers.length - 1]!;
      a = active[id] = { layer: top.id, target: 'content' };
    } else if (a.target !== 'content' && !layer.masks.some((m) => m.id === a!.target)) a.target = 'content';
    return a;
  }

  /** A copy of an object's stack for display (bottom first). */
  function view(id: string | null): Layer[] {
    void rev.value;
    const doc = docOf(id);
    return doc ? cloneLayers(doc.layers) : [];
  }

  function select(id: string, layer: string, target = 'content') {
    active[id] = { layer, target };
    rev.value++;
  }

  /** Where the paint tools write on this object, or why they can't. */
  function paintTarget(id: string): PaintTarget | string {
    const o = sceneObjects.get(id);
    const doc = o?.paint?.doc;
    const a = selection(id);
    if (!o || !doc || !a) return 'This object has no paint surface yet.';
    const layer = doc.layers.find((l) => l.id === a.layer)!;
    if (!layer.visible) return `"${layer.name}" is hidden. Show it to paint on it.`;
    if (a.target === 'content') {
      if (layer.kind === 'fill') return `"${layer.name}" is a fill layer. Add a painted mask to shape it, or pick a paint layer.`;
      let maps = doc.maps.get(layer.id);
      if (!maps) doc.maps.set(layer.id, (maps = createMaps(o.paint!.atlas)));
      return { id: layer.id, maps, mask: false };
    }
    const m = layer.masks.find((k) => k.id === a.target)!;
    if (m.kind !== 'painted') return `The ${MASK_LABELS[m.kind].toLowerCase()} mask "${m.name}" comes from its settings, so it can't be painted. Add a painted mask to paint one.`;
    return { id: m.id, maps: composerOf(o)!.maskMaps(m), mask: true };
  }

  /** After paint tools (or undo) changed a layer map: recomposite those rectangles and show them. */
  function painted(id: string, mapId: string, dirty: (Rect | null)[]) {
    const o = sceneObjects.get(id);
    const c = o && composerOf(o);
    if (!c) return;
    c.painted(mapId, dirty);
    getViewport()?.uploadPaint(id, dirty);
  }

  // ---- changes and undo ----------------------------------------------------------

  /** A run of quick changes to one setting (a slider drag), recorded as one undo step. */
  let pending: { key: string; id: string; label: string; before: Snapshot; timer: ReturnType<typeof setTimeout> } | null = null;
  const soon = new Set<string>();
  let frame = 0;

  function recompositeSoon(id: string) {
    soon.add(id);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const o of soon) recomposite(o);
      soon.clear();
      usePaintStore().bump();
    });
  }

  function restore(id: string, s: Snapshot) {
    const doc = docOf(id);
    if (!doc) return;
    doc.layers = cloneLayers(s.layers);
    doc.maps = new Map(s.maps);
    doc.bitmaps = new Map(s.bitmaps);
    for (const k of doc.maps.keys()) touchPaint(id, k);
    rev.value++;
    recomposite(id);
  }

  function commit(id: string, label: string, before: Snapshot) {
    const doc = docOf(id);
    if (!doc) return;
    const after = snap(doc);
    const remapFills = (s: Snapshot, lut: Uint8Array) => {
      for (const l of s.layers) {
        if (l.kind === 'fill') l.slot = Math.max(1, lut[l.slot]!);
        else {
          const m = s.maps.get(l.id);
          if (m) remapOnce(m, lut);
        }
      }
    };
    usePaintStore().pushEntry({
      label,
      targets: [id],
      bytes: 4096 + exclusiveBytes(before.maps, after.maps) + exclusiveBytes(after.maps, before.maps),
      undo: () => restore(id, before),
      redo: () => restore(id, after),
      remapSlots: (lut) => {
        remapFills(before, lut);
        remapFills(after, lut);
      },
    });
  }

  /** Ends a run of slider changes now (before undo, or another change). */
  function flush() {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    commit(p.id, p.label, p.before);
  }

  /**
   * Changes an object's stack. With `coalesce`, quick repeats with the same key
   * (dragging a slider) become one undo step.
   */
  function change(id: string, label: string, fn: (doc: LayerDoc) => void, coalesce?: string) {
    const doc = docOf(id);
    if (!doc) return;
    if (pending && (!coalesce || pending.key !== `${id}|${coalesce}`)) flush();
    const before = pending ? pending.before : snap(doc);
    fn(doc);
    rev.value++;
    recompositeSoon(id);
    if (coalesce) {
      if (pending) clearTimeout(pending.timer);
      pending = { key: `${id}|${coalesce}`, id, label, before, timer: setTimeout(flush, 700) };
    } else commit(id, label, before);
  }

  const findLayer = (doc: LayerDoc, layerId: string) => doc.layers.find((l) => l.id === layerId);
  const nextName = (doc: LayerDoc, base: string) => {
    let n = doc.layers.length + 1;
    while (doc.layers.some((l) => l.name === `${base} ${n}`)) n++;
    return `${base} ${n}`;
  };
  /** Index just above the selected layer. */
  const insertAt = (id: string, doc: LayerDoc) => {
    const a = selection(id);
    const i = a ? doc.layers.findIndex((l) => l.id === a.layer) : -1;
    return i < 0 ? doc.layers.length : i + 1;
  };

  function addLayer(id: string, kind: 'paint' | 'fill', slot: number) {
    const o = sceneObjects.get(id);
    if (!o?.paint) return;
    const lid = newId('L');
    change(id, kind === 'fill' ? 'Add fill layer' : 'Add layer', (doc) => {
      const layer: Layer = { id: lid, name: nextName(doc, kind === 'fill' ? 'Fill' : 'Layer'), visible: true, kind, slot, masks: [] };
      if (kind === 'paint') doc.maps.set(lid, createMaps(o.paint!.atlas));
      doc.layers.splice(insertAt(id, doc), 0, layer);
    });
    select(id, lid);
  }

  function duplicateLayer(id: string, layerId: string) {
    const nid = newId('L');
    change(id, 'Duplicate layer', (doc) => {
      const i = doc.layers.findIndex((l) => l.id === layerId);
      if (i < 0) return;
      const [copy] = cloneLayers([doc.layers[i]!]);
      copy!.id = nid;
      copy!.name = `${copy!.name} copy`;
      const src = doc.maps.get(layerId);
      if (src) doc.maps.set(nid, src.map((m) => m.slice()));
      for (const m of copy!.masks) {
        const old = m.id;
        m.id = newId('M');
        const mm = doc.maps.get(old);
        if (mm) doc.maps.set(m.id, mm.map((x) => x.slice()));
      }
      doc.layers.splice(i + 1, 0, copy!);
    });
    select(id, nid);
  }

  function removeLayer(id: string, layerId: string) {
    const doc = docOf(id);
    if (!doc || doc.layers.length <= 1) return;
    const name = findLayer(doc, layerId)?.name ?? 'layer';
    change(id, `Delete ${name}`, (d) => {
      const l = findLayer(d, layerId);
      if (!l) return;
      d.layers = d.layers.filter((x) => x !== l);
      d.maps.delete(l.id);
      for (const m of l.masks) d.maps.delete(m.id);
    });
    rev.value++;
  }

  function moveLayer(id: string, layerId: string, by: number) {
    change(id, 'Move layer', (doc) => {
      const i = doc.layers.findIndex((l) => l.id === layerId);
      const j = i + by;
      if (i < 0 || j < 0 || j >= doc.layers.length) return;
      const [l] = doc.layers.splice(i, 1);
      doc.layers.splice(j, 0, l!);
    });
  }

  function setLayer(id: string, layerId: string, patch: Partial<Pick<Layer, 'name' | 'visible' | 'slot'>>, label: string) {
    change(id, label, (doc) => {
      const l = findLayer(doc, layerId);
      if (l) Object.assign(l, patch);
    });
  }

  /** Whether a layer can be merged into the one below (a paint layer without masks). */
  function canMergeDown(id: string, layerId: string): boolean {
    void rev.value;
    const doc = docOf(id);
    const i = doc ? doc.layers.findIndex((l) => l.id === layerId) : -1;
    const below = i > 0 ? doc!.layers[i - 1]! : null;
    return !!below && below.kind === 'paint' && !below.masks.length && below.visible;
  }

  /** Bakes a layer (through its masks) into the paint layer below, and removes it. */
  function mergeDown(id: string, layerId: string) {
    const o = sceneObjects.get(id);
    const c = o && composerOf(o);
    if (!c || !canMergeDown(id, layerId)) return;
    c.refresh(); // coverage is current
    const doc0 = docOf(id)!;
    const belowId = doc0.layers[doc0.layers.findIndex((l) => l.id === layerId) - 1]!.id;
    change(id, 'Merge down', (doc) => {
      const i = doc.layers.findIndex((l) => l.id === layerId);
      const top = doc.layers[i]!, below = doc.layers[i - 1]!;
      const cov = c.coverage(top.id);
      const base = doc.maps.get(below.id)!;
      const merged = base.map((m) => m.slice());
      if (top.visible) {
        const src = top.kind === 'paint' ? doc.maps.get(top.id) : null;
        merged.forEach((m, p) => {
          const cv = cov?.[p];
          const s = src?.[p];
          for (let k = 0; k < m.length; k++) {
            const v = s ? s[k]! : top.slot;
            if (v && (!cv || cv[k])) m[k] = v;
          }
        });
      }
      doc.maps.set(below.id, merged);
      doc.layers.splice(i, 1);
      doc.maps.delete(top.id);
      for (const m of top.masks) doc.maps.delete(m.id);
      touchPaint(id, below.id);
    });
    select(id, belowId);
  }

  // ---- masks ---------------------------------------------------------------------

  function addMask(id: string, layerId: string, mask: Mask, bitmap?: DecalBitmap) {
    change(id, `Add ${MASK_LABELS[mask.kind].toLowerCase()} mask`, (doc) => {
      const l = findLayer(doc, layerId);
      if (!l) return;
      if (bitmap && mask.kind === 'decal') doc.bitmaps.set(mask.bitmap, bitmap);
      l.masks.push(mask);
    });
    select(id, layerId, mask.id);
  }

  function removeMask(id: string, layerId: string, maskId: string) {
    change(id, 'Delete mask', (doc) => {
      const l = findLayer(doc, layerId);
      if (!l) return;
      const m = l.masks.find((k) => k.id === maskId);
      l.masks = l.masks.filter((k) => k.id !== maskId);
      doc.maps.delete(maskId);
      if (m?.kind === 'decal' && !doc.layers.some((x) => x.masks.some((k) => k.kind === 'decal' && k.bitmap === m.bitmap))) doc.bitmaps.delete(m.bitmap);
    });
    select(id, layerId);
  }

  function moveMask(id: string, layerId: string, maskId: string, by: number) {
    change(id, 'Move mask', (doc) => {
      const l = findLayer(doc, layerId);
      if (!l) return;
      const i = l.masks.findIndex((m) => m.id === maskId);
      const j = i + by;
      if (i < 0 || j < 0 || j >= l.masks.length) return;
      const [m] = l.masks.splice(i, 1);
      l.masks.splice(j, 0, m!);
    });
  }

  /** Changes a mask's settings. Slider drags pass `coalesce` (the setting's name). */
  function updateMask(id: string, layerId: string, maskId: string, patch: Partial<Mask>, coalesce?: string, bitmap?: DecalBitmap) {
    change(
      id,
      'Change mask',
      (doc) => {
        const m = findLayer(doc, layerId)?.masks.find((k) => k.id === maskId);
        if (!m) return;
        if (bitmap && m.kind === 'decal') {
          const old = m.bitmap;
          doc.bitmaps.set((patch as Partial<DecalMask>).bitmap!, bitmap);
          Object.assign(m, patch);
          if (!doc.layers.some((x) => x.masks.some((k) => k.kind === 'decal' && k.bitmap === old))) doc.bitmaps.delete(old);
        } else Object.assign(m, patch);
      },
      coalesce && `${maskId}|${coalesce}`,
    );
  }

  /** Clears the paint layer or painted mask being painted on (undoable like a stroke). */
  function clearTarget(id: string): string | null {
    return usePaintStore().clearTarget(id);
  }

  /** Palette slots removed or reordered: rewrite paint layers, fill slots and the undo data. */
  function remapSlots(lut: Uint8Array) {
    flush();
    remapSeen = new WeakSet();
    try {
      for (const o of sceneObjects.values()) {
        const doc = o.paint?.doc;
        if (!doc) continue;
        for (const l of doc.layers) {
          if (l.kind === 'fill') l.slot = Math.max(1, lut[l.slot]!);
          else {
            const m = doc.maps.get(l.id);
            if (m) remapOnce(m, lut);
          }
        }
        for (const k of doc.maps.keys()) if (!isMaskMap(doc.layers, k)) touchPaint(o.id, k);
        recomposite(o.id);
      }
      usePaintStore().remapHistory(lut);
    } finally {
      remapSeen = null;
    }
    rev.value++;
  }

  /** Forget UI state for objects that are gone. */
  function forget(id: string) {
    delete active[id];
    if (placing.value?.object === id) placing.value = null;
  }

  return {
    rev,
    active,
    placing,
    view,
    selection,
    select,
    paintTarget,
    painted,
    flush,
    addLayer,
    duplicateLayer,
    removeLayer,
    moveLayer,
    setLayer,
    canMergeDown,
    mergeDown,
    addMask,
    removeMask,
    moveMask,
    updateMask,
    clearTarget,
    remapSlots,
    forget,
  };
});

/** Whether a slot map id is a painted mask's on this object (its values aren't filaments). */
export function isMaskTarget(o: SceneObject, mapId: string): boolean {
  return !!o.paint && isMaskMap(o.paint.doc.layers, mapId);
}
