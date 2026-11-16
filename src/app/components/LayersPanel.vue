<script setup lang="ts">
import { computed, ref } from 'vue';
import { newId, type Mask, type MaskKind } from '@/core/layers';
import { sceneObjects } from '../document';
import { bitmapFromFile, bitmapFromText, newBitmapId, newDecalMask } from '../decals';
import { MASK_LABELS, useLayersStore } from '../stores/layers';
import { usePaletteStore } from '../stores/palette';
import { useSceneStore } from '../stores/scene';
import { useUiStore } from '../stores/ui';
import MaskEditor from './MaskEditor.vue';

const scene = useSceneStore();
const layers = useLayersStore();
const palette = usePaletteStore();
const ui = useUiStore();

const o = computed(() => scene.selected);
const ready = computed(() => o.value?.paintState === 'ready');
const stack = computed(() => (ready.value ? layers.view(o.value!.id) : []));
/** Top first, as layer panels show them. */
const shown = computed(() => [...stack.value].reverse());
const sel = computed(() => {
  void layers.rev;
  return o.value && ready.value ? layers.selection(o.value.id) : null;
});
const layer = computed(() => stack.value.find((l) => l.id === sel.value?.layer) ?? null);
const mask = computed(() => layer.value?.masks.find((m) => m.id === sel.value?.target) ?? null);
const layerIndex = computed(() => stack.value.findIndex((l) => l.id === layer.value?.id));

const renaming = ref<string | null>(null);
const fileInput = ref<HTMLInputElement>();

const slotColor = (s: number) => palette.slots[s - 1]?.color ?? '#888';
const opSign = (m: Mask) => (m.op === 'subtract' ? '−' : m.op === 'intersect' ? '∩' : '+');

const MASK_ICONS: Record<MaskKind, string> = {
  painted: 'M14 4l6 6-8.5 8.5a3 3 0 01-4.2 0L5.5 16.7a3 3 0 010-4.2z',
  angle: 'M4 20h16M4 20L18 6M10 20a6 6 0 00-1.8-4.2',
  height: 'M4 6h16M4 12h16M4 18h16',
  edge: 'M4 18L12 6l8 12',
  decal: 'M5 5h14v14H5zM8 15l3-4 2 3 2-2 2 3',
};

function addLayer(kind: 'paint' | 'fill') {
  if (o.value) layers.addLayer(o.value.id, kind, palette.active);
}

function rename(id: string, name: string) {
  renaming.value = null;
  const n = name.trim();
  if (o.value && n) layers.setLayer(o.value.id, id, { name: n }, 'Rename layer');
}

function objectHeightMm(): number {
  return o.value?.dims[2] ?? 10;
}

async function addMask(kind: string) {
  const ob = o.value, l = layer.value;
  if (!ob || !l) return;
  const base = { id: newId('M'), enabled: true, invert: false, op: 'add' as const };
  switch (kind as MaskKind | 'text' | 'image') {
    case 'painted':
      // On a paint layer, painting usually hides; on a fill layer it shows where the fill goes.
      layers.addMask(ob.id, l.id, { ...base, name: l.kind === 'fill' ? 'Painted' : 'Painted (hides)', kind: 'painted', op: l.kind === 'fill' || l.masks.length ? 'add' : 'subtract' });
      break;
    case 'angle':
      layers.addMask(ob.id, l.id, { ...base, name: 'Top surfaces', kind: 'angle', dir: [0, 0, 1], minDeg: 0, maxDeg: 10 });
      break;
    case 'height': {
      const h = objectHeightMm();
      layers.addMask(ob.id, l.id, { ...base, name: 'Height', kind: 'height', fromMm: 0, toMm: Math.round(Math.min(5, h / 2) * 10) / 10, repeatMm: 0 });
      break;
    }
    case 'edge':
      layers.addMask(ob.id, l.id, { ...base, name: 'Sharp edges', kind: 'edge', angleDeg: 30, widthMm: 1, which: 'both' });
      break;
    case 'text': {
      const text = { text: 'Text', font: 'sans-serif', bold: true, italic: false };
      const bid = newBitmapId();
      layers.addMask(ob.id, l.id, newDecalMask(ob.id, bid, 'alpha', 'Text', text), bitmapFromText(text));
      break;
    }
    case 'image':
      fileInput.value?.click();
      break;
  }
}

async function onImage(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const ob = o.value, l = layer.value;
  if (!file || !ob || !l) return;
  try {
    const { bmp, channel } = await bitmapFromFile(file);
    if (!sceneObjects.has(ob.id)) return;
    const bid = newBitmapId();
    layers.addMask(ob.id, l.id, newDecalMask(ob.id, bid, channel, file.name.replace(/\.[^.]+$/, '') || 'Image'), bmp);
  } catch (err) {
    ui.notify('error', (err as Error).message);
  }
}

function clear() {
  if (!o.value) return;
  const msg = layers.clearTarget(o.value.id);
  if (msg) ui.notify('info', msg);
}

const targetIsPaintable = computed(() => (layer.value?.kind === 'paint' && !mask.value) || mask.value?.kind === 'painted');
</script>

<template>
  <section class="layers" aria-label="Layers">
    <div class="head">
      <h3 class="section-title">Layers</h3>
      <template v-if="ready">
        <button class="btn small" title="New paint layer above the selected one" @click="addLayer('paint')">+ Layer</button>
        <button class="btn small" title="New fill layer (one filament everywhere, shaped by masks)" @click="addLayer('fill')">+ Fill</button>
      </template>
    </div>
    <p v-if="!o" class="muted">Select an object to see its layers.</p>
    <p v-else-if="!ready" class="muted">Preparing the paint surface…</p>
    <template v-else>
      <ul class="stack" role="listbox" aria-label="Layer stack">
        <li
          v-for="l in shown"
          :key="l.id"
          class="layer"
          :class="{ on: l.id === layer?.id, off: !l.visible }"
          role="option"
          :aria-selected="l.id === layer?.id"
        >
          <div class="row" @click="layers.select(o!.id, l.id)">
            <button
              class="icon"
              :title="l.visible ? 'Hide layer' : 'Show layer'"
              @click.stop="layers.setLayer(o!.id, l.id, { visible: !l.visible }, l.visible ? 'Hide layer' : 'Show layer')"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path v-if="l.visible" d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z" />
                <path v-else d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 005.4-1.6" />
              </svg>
            </button>
            <span
              class="thumb"
              :class="{ fill: l.kind === 'fill', target: sel?.target === 'content' && l.id === layer?.id }"
              :style="l.kind === 'fill' ? { background: slotColor(l.slot) } : undefined"
              :title="l.kind === 'fill' ? `Fill: ${palette.slots[l.slot - 1]?.name ?? ''}` : 'Paint layer'"
              @click.stop="layers.select(o!.id, l.id, 'content')"
            >
              <svg v-if="l.kind === 'paint'" viewBox="0 0 24 24" aria-hidden="true"><path :d="MASK_ICONS.painted" /></svg>
            </span>
            <input
              v-if="renaming === l.id"
              class="name-input"
              :value="l.name"
              aria-label="Layer name"
              autofocus
              @click.stop
              @keydown.enter="rename(l.id, ($event.target as HTMLInputElement).value)"
              @keydown.esc="renaming = null"
              @blur="rename(l.id, ($event.target as HTMLInputElement).value)"
            />
            <span v-else class="name" :title="`${l.name} (double-click to rename)`" @dblclick.stop="renaming = l.id">{{ l.name }}</span>
          </div>
          <div v-if="l.masks.length" class="masks">
            <button
              v-for="m in l.masks"
              :key="m.id"
              class="chip"
              :class="{ on: sel?.target === m.id, disabled: !m.enabled }"
              :title="`${m.name}: ${MASK_LABELS[m.kind]} mask (${m.op}${m.invert ? ', inverted' : ''})`"
              @click.stop="layers.select(o!.id, l.id, m.id)"
            >
              <span class="op">{{ opSign(m) }}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="MASK_ICONS[m.kind]" /></svg>
              <span class="chip-name">{{ m.name }}</span>
            </button>
          </div>
        </li>
      </ul>

      <div v-if="layer" class="actions">
        <button class="btn small" title="Move up" :disabled="layerIndex >= stack.length - 1" @click="layers.moveLayer(o!.id, layer.id, 1)">↑</button>
        <button class="btn small" title="Move down" :disabled="layerIndex <= 0" @click="layers.moveLayer(o!.id, layer.id, -1)">↓</button>
        <button class="btn small" title="Duplicate layer" @click="layers.duplicateLayer(o!.id, layer.id)">Duplicate</button>
        <button
          class="btn small"
          title="Bake this layer (through its masks) into the paint layer below. The layer below must be a visible paint layer without masks."
          :disabled="!layers.canMergeDown(o!.id, layer.id)"
          @click="layers.mergeDown(o!.id, layer.id)"
        >
          Merge down
        </button>
        <button class="btn small danger" title="Delete layer" :disabled="stack.length <= 1" @click="layers.removeLayer(o!.id, layer.id)">Delete</button>
      </div>

      <div v-if="layer" class="settings">
        <div v-if="layer.kind === 'fill'" class="slots" role="radiogroup" aria-label="Fill filament">
          <span class="label">Filament</span>
          <button
            v-for="(s, i) in palette.slots"
            :key="i"
            class="slot"
            role="radio"
            :aria-checked="layer.slot === i + 1"
            :class="{ on: layer.slot === i + 1 }"
            :style="{ background: s.color }"
            :title="`${i + 1}: ${s.name}`"
            @click="layers.setLayer(o!.id, layer.id, { slot: i + 1 }, 'Change fill filament')"
          />
        </div>
        <div class="add-mask">
          <select name="addMask" aria-label="Add a mask" @change="addMask(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
            <option value="">Add mask…</option>
            <option value="painted">Painted (paint where it shows or hides)</option>
            <option value="angle">Facing (tops, overhangs, walls)</option>
            <option value="height">Height bands and stripes</option>
            <option value="edge">Sharp edges</option>
            <option value="image">Decal: image or SVG…</option>
            <option value="text">Decal: text</option>
          </select>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg" hidden @change="onImage" />
        </div>
        <p v-if="targetIsPaintable" class="hint">
          The paint tools paint {{ mask ? `the mask "${mask.name}"` : `"${layer.name}"` }}.
          <button class="link" @click="clear">Clear it</button>
        </p>
        <p v-else-if="layer.kind === 'fill' && !mask" class="hint">A fill layer covers everything its masks let through. Add a mask to shape it.</p>
      </div>

      <MaskEditor v-if="layer && mask" :key="mask.id" :object-id="o!.id" :layer-id="layer.id" :mask="mask" :first="layer.masks[0]?.id === mask.id" :count="layer.masks.length" :index="layer.masks.findIndex((m) => m.id === mask!.id)" />
    </template>
  </section>
</template>

<style scoped>
.layers {
  margin-bottom: 1rem;
}
.head {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.5rem;
}
h3 {
  margin: 0 auto 0 0;
}
.muted {
  color: var(--muted);
}
.small {
  padding: 0.3rem 0.5rem;
  font-size: 0.66rem;
}
.stack {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 0;
  overflow: hidden;
}
.layer {
  border-bottom: 1px solid var(--border);
}
.layer:last-child {
  border-bottom: none;
}
.layer.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
}
.layer.off .name,
.layer.off .thumb {
  opacity: 0.45;
}
.row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.4rem;
  cursor: pointer;
}
.icon {
  background: none;
  border: none;
  padding: 0.1rem;
  color: var(--muted);
  cursor: pointer;
  display: grid;
}
.icon svg,
.thumb svg,
.chip svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.thumb {
  width: 22px;
  height: 22px;
  border-radius: 0;
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--panel-raised);
  flex: none;
}
.thumb.target {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 0;
  padding: 0 0.25rem;
}
.masks {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0 0.4rem 0.35rem 2rem;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  max-width: 100%;
  font: inherit;
  font-size: 0.75rem;
  color: var(--text);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 0.05rem 0.45rem 0.05rem 0.3rem;
  cursor: pointer;
}
.chip svg {
  width: 13px;
  height: 13px;
}
.chip.on {
  border-color: var(--accent);
  color: var(--accent);
}
.chip.disabled {
  opacity: 0.5;
  text-decoration: line-through;
}
.op {
  font-weight: 600;
  width: 0.7rem;
  text-align: center;
}
.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0.45rem 0;
}
.danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}
.settings {
  display: grid;
  gap: 0.45rem;
}
.slots {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
}
.label {
  color: var(--muted);
  font-size: 0.85rem;
  margin-right: 0.25rem;
}
.slot {
  width: 18px;
  height: 18px;
  border-radius: 0;
  border: 1px solid var(--border);
  padding: 0;
  cursor: pointer;
}
.slot.on {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.add-mask select {
  width: 100%;
}
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
}
.link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}
</style>
