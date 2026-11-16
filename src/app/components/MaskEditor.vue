<script setup lang="ts">
import { computed } from 'vue';
import type { DecalMask, DecalText, Mask, MaskOp } from '@/core/layers';
import { UNIT_TO_MM } from '@/core/units';
import { sceneObjects } from '../document';
import { bitmapFromText, DECAL_FONTS, newBitmapId, placementFromView } from '../decals';
import { MASK_LABELS, useLayersStore } from '../stores/layers';
import { getViewport } from '../engine';

const props = defineProps<{ objectId: string; layerId: string; mask: Mask; first: boolean; index: number; count: number }>();
const layers = useLayersStore();

const m = computed(() => props.mask);
const mmPerUnit = computed(() => {
  const o = sceneObjects.get(props.objectId);
  return o ? UNIT_TO_MM[o.unit] : 1;
});
/** The object's size in mm (for slider ranges). */
const size = computed(() => {
  const o = sceneObjects.get(props.objectId);
  if (!o) return [10, 10, 10];
  const b = o.srcBounds, s = mmPerUnit.value;
  return [0, 1, 2].map((k) => (b.max[k]! - b.min[k]!) * s);
});
const maxSize = computed(() => Math.max(...size.value));

function upd(patch: Record<string, unknown>, coalesce?: string) {
  layers.updateMask(props.objectId, props.layerId, props.mask.id, patch as Partial<Mask>, coalesce);
}
const num = (e: Event) => Number((e.target as HTMLInputElement).value);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const ops: { id: MaskOp; label: string }[] = [
  { id: 'add', label: 'Add' },
  { id: 'subtract', label: 'Subtract' },
  { id: 'intersect', label: 'Intersect' },
];

// ---- facing ----
const DIRS: { label: string; dir: [number, number, number] }[] = [
  { label: 'Up (+Z)', dir: [0, 0, 1] },
  { label: 'Down (−Z)', dir: [0, 0, -1] },
  { label: '+X', dir: [1, 0, 0] },
  { label: '−X', dir: [-1, 0, 0] },
  { label: '+Y', dir: [0, 1, 0] },
  { label: '−Y', dir: [0, -1, 0] },
];
const dirIndex = computed(() => {
  const a = m.value;
  if (a.kind !== 'angle') return -1;
  return DIRS.findIndex((d) => d.dir.every((v, k) => Math.abs(v - a.dir[k]!) < 1e-6));
});
const PRESETS: { label: string; title: string; patch: Record<string, unknown> }[] = [
  { label: 'Tops', title: 'Flat surfaces facing up', patch: { name: 'Top surfaces', dir: [0, 0, 1], minDeg: 0, maxDeg: 10 } },
  { label: 'Overhangs', title: 'Surfaces facing down more than 45° from the walls', patch: { name: 'Overhangs', dir: [0, 0, -1], minDeg: 0, maxDeg: 45 } },
  { label: 'Walls', title: 'Near-vertical surfaces', patch: { name: 'Walls', dir: [0, 0, 1], minDeg: 80, maxDeg: 100 } },
];
function facingCamera() {
  const vp = getViewport();
  if (!vp) return;
  vp.camera.updateMatrixWorld();
  const e = vp.camera.matrixWorld.elements;
  // The camera looks along −Z of its frame; surfaces facing it have normals along +Z.
  upd({ dir: [round(e[8]!, 4), round(e[9]!, 4), round(e[10]!, 4)] });
}

// ---- decal ----
const decal = computed(() => (m.value.kind === 'decal' ? (m.value as DecalMask) : null));
function setText(patch: Partial<DecalText>, coalesce?: string) {
  const d = decal.value;
  if (!d?.text) return;
  const text = { ...d.text, ...patch };
  layers.updateMask(props.objectId, props.layerId, d.id, { text, bitmap: newBitmapId() } as Partial<Mask>, coalesce, bitmapFromText(text));
}
function aimFromView() {
  const p = placementFromView(props.objectId);
  upd({ centre: p.centre, dir: p.dir, up: p.up });
}
const placing = computed(() => layers.placing?.mask === props.mask.id);
function togglePlacing() {
  layers.placing = placing.value ? null : { object: props.objectId, layer: props.layerId, mask: props.mask.id };
}
</script>

<template>
  <div class="mask-editor">
    <div class="title">
      <input class="name" :value="m.name" aria-label="Mask name" @change="upd({ name: ($event.target as HTMLInputElement).value.trim() || MASK_LABELS[m.kind] })" />
      <span class="kind">{{ MASK_LABELS[m.kind] }} mask</span>
    </div>
    <div class="line">
      <label class="check"><input type="checkbox" :checked="m.enabled" @change="upd({ enabled: !m.enabled })" />On</label>
      <label class="check" title="Swap where the mask is on and off"><input type="checkbox" :checked="m.invert" @change="upd({ invert: !m.invert })" />Invert</label>
      <select :value="m.op" aria-label="How this mask combines with the ones before it" :title="first ? 'Add starts from nothing; Subtract starts from everything' : 'How it combines with the masks above it in the list'" @change="upd({ op: ($event.target as HTMLSelectElement).value })">
        <option v-for="o in ops" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
    </div>

    <template v-if="m.kind === 'painted'">
      <p class="hint">Paint with any paint tool: it paints this mask (Shift or the eraser removes it). {{ m.op === 'subtract' ? 'Painted areas hide the layer.' : 'The layer shows where you paint.' }}</p>
    </template>

    <template v-else-if="m.kind === 'angle'">
      <div class="line">
        <button v-for="p in PRESETS" :key="p.label" class="btn small" :title="p.title" @click="upd(p.patch)">{{ p.label }}</button>
      </div>
      <label class="field">
        <span>Facing</span>
        <select :value="dirIndex" @change="upd({ dir: DIRS[Number(($event.target as HTMLSelectElement).value)]!.dir })">
          <option v-for="(d, i) in DIRS" :key="i" :value="i">{{ d.label }}</option>
          <option v-if="dirIndex < 0" :value="-1">Custom</option>
        </select>
        <button class="btn small" title="Surfaces facing the camera" @click="facingCamera">View</button>
      </label>
      <label class="field">
        <span>From {{ round(m.minDeg, 0) }}°</span>
        <input type="range" min="0" max="180" step="1" :value="m.minDeg" @input="upd({ minDeg: Math.min(num($event), (m as any).maxDeg) }, 'min')" />
      </label>
      <label class="field">
        <span>To {{ round(m.maxDeg, 0) }}°</span>
        <input type="range" min="0" max="180" step="1" :value="m.maxDeg" @input="upd({ maxDeg: Math.max(num($event), (m as any).minDeg) }, 'max')" />
      </label>
      <p class="hint">The angle between a surface and the direction: 0° faces it straight on.</p>
    </template>

    <template v-else-if="m.kind === 'height'">
      <label class="field">
        <span>From</span>
        <input type="number" step="0.1" :value="m.fromMm" @input="upd({ fromMm: num($event) }, 'from')" />
        <em>mm</em>
      </label>
      <label class="field">
        <span>To</span>
        <input type="number" step="0.1" :value="m.toMm" @input="upd({ toMm: num($event) }, 'to')" />
        <em>mm</em>
      </label>
      <input type="range" aria-label="Band position" min="0" :max="round(size[2]!, 1)" step="0.1" :value="m.fromMm" @input="upd({ fromMm: num($event), toMm: round(num($event) + (m as any).toMm - (m as any).fromMm) }, 'slide')" />
      <label class="check"><input type="checkbox" :checked="m.repeatMm > 0" @change="upd({ repeatMm: m.repeatMm > 0 ? 0 : round(Math.max(1, ((m as any).toMm - (m as any).fromMm) * 2)) })" />Repeat (stripes)</label>
      <label v-if="m.repeatMm > 0" class="field">
        <span>Every</span>
        <input type="number" min="0.1" step="0.1" :value="m.repeatMm" @input="upd({ repeatMm: Math.max(0.1, num($event)) }, 'repeat')" />
        <em>mm</em>
      </label>
      <p class="hint">Measured from the bottom of the object ({{ round(size[2]!, 1) }} mm tall).</p>
    </template>

    <template v-else-if="m.kind === 'edge'">
      <label class="field">
        <span>Bend over {{ round(m.angleDeg, 0) }}°</span>
        <input type="range" min="5" max="150" step="1" :value="m.angleDeg" @input="upd({ angleDeg: num($event) }, 'angle')" />
      </label>
      <label class="field">
        <span>Width</span>
        <input type="number" min="0.05" step="0.1" :value="m.widthMm" @input="upd({ widthMm: Math.max(0.05, num($event)) }, 'width')" />
        <em>mm</em>
      </label>
      <label class="field">
        <span>Edges</span>
        <select :value="m.which" @change="upd({ which: ($event.target as HTMLSelectElement).value })">
          <option value="both">All</option>
          <option value="convex">Outside (convex)</option>
          <option value="concave">Inside (creases)</option>
        </select>
      </label>
    </template>

    <template v-else-if="decal">
      <template v-if="decal.text">
        <textarea class="text" rows="2" :value="decal.text.text" aria-label="Decal text" @input="setText({ text: ($event.target as HTMLTextAreaElement).value }, 'text')" />
        <div class="line">
          <select :value="decal.text.font" aria-label="Font" @change="setText({ font: ($event.target as HTMLSelectElement).value })">
            <option v-for="f in DECAL_FONTS" :key="f" :value="f">{{ f }}</option>
          </select>
          <label class="check"><input type="checkbox" :checked="decal.text.bold" @change="setText({ bold: !decal!.text!.bold })" />Bold</label>
          <label class="check"><input type="checkbox" :checked="decal.text.italic" @change="setText({ italic: !decal!.text!.italic })" />Italic</label>
        </div>
      </template>
      <div class="line">
        <button class="btn small" :class="{ 'btn-accent': placing }" title="Click on the model to put the decal there, projected along the view" @click="togglePlacing">{{ placing ? 'Click the model…' : 'Place by clicking' }}</button>
        <button class="btn small" title="Project from the current view, at the middle of the screen" @click="aimFromView">Aim from view</button>
      </div>
      <label class="field">
        <span>Width</span>
        <input type="range" min="0.5" :max="round(maxSize * 2, 0)" step="0.1" :value="decal.width * mmPerUnit" @input="upd({ width: num($event) / mmPerUnit }, 'width')" />
        <input class="short" type="number" min="0.1" step="0.5" :value="round(decal.width * mmPerUnit, 1)" @input="upd({ width: Math.max(0.1, num($event)) / mmPerUnit }, 'width')" />
        <em>mm</em>
      </label>
      <label class="field">
        <span>Rotate {{ round(decal.rotationDeg, 0) }}°</span>
        <input type="range" min="-180" max="180" step="1" :value="decal.rotationDeg" @input="upd({ rotationDeg: num($event) }, 'rot')" />
      </label>
      <label v-if="!decal.text" class="field">
        <span>Shape from</span>
        <select :value="decal.channel" @change="upd({ channel: ($event.target as HTMLSelectElement).value })">
          <option value="alpha">Opaque parts</option>
          <option value="dark">Dark parts</option>
          <option value="light">Light parts</option>
        </select>
      </label>
      <label v-if="!decal.text" class="field">
        <span>Threshold {{ Math.round(decal.threshold * 100) }}%</span>
        <input type="range" min="0.01" max="1" step="0.01" :value="decal.threshold" @input="upd({ threshold: num($event) }, 'threshold')" />
      </label>
      <label class="check"><input type="checkbox" :checked="decal.through" @change="upd({ through: !decal!.through })" />Go through the model (back side too)</label>
    </template>

    <div class="line end">
      <button class="btn small" title="Move up the mask list" :disabled="index <= 0" @click="layers.moveMask(objectId, layerId, m.id, -1)">↑</button>
      <button class="btn small" title="Move down the mask list" :disabled="index >= count - 1" @click="layers.moveMask(objectId, layerId, m.id, 1)">↓</button>
      <button class="btn small danger" @click="layers.removeMask(objectId, layerId, m.id)">Delete mask</button>
    </div>
  </div>
</template>

<style scoped>
.mask-editor {
  display: grid;
  gap: 0.45rem;
  margin-top: 0.6rem;
  padding: 0.55rem;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--bg);
  min-width: 0;
}
.mask-editor > * {
  min-width: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.name {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-weight: 600;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0;
  padding: 0.1rem 0.25rem;
}
.name:hover,
.name:focus {
  border-color: var(--border);
}
.kind {
  color: var(--muted);
  font-size: 0.75rem;
  white-space: nowrap;
}
.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.end {
  justify-content: flex-end;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.field > span {
  color: var(--muted);
  min-width: 4.8rem;
  flex: none;
}
.field input[type='range'] {
  flex: 1;
  min-width: 0;
}
.field input[type='number'] {
  width: 4.5rem;
  min-width: 0;
}
.field .short {
  width: 4rem;
}
.field em {
  color: var(--muted);
  font-style: normal;
}
input[type='number'],
.text {
  font: inherit;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 0.2rem 0.35rem;
}
.text {
  resize: vertical;
  width: 100%;
}
.small {
  padding: 0.3rem 0.5rem;
  font-size: 0.66rem;
}
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
}
.danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}
</style>
