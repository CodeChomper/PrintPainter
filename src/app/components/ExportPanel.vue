<script setup lang="ts">
import { computed } from 'vue';
import { SMOOTH_MAX, useExportStore } from '../stores/export';
import { usePaletteStore } from '../stores/palette';

const ex = useExportStore();
const palette = usePaletteStore();

const slots = computed(() => ex.usedSlots.map((n) => ({ n, slot: palette.slots[n - 1] })));
const missing = computed(() => ex.usedSlots.filter((n) => n > palette.slots.length));
const hiddenNote = computed(() => !ex.summaries.length);

function pct(f: number) {
  return `${Math.round(f * 100)}%`;
}
</script>

<template>
  <section class="export" aria-label="Export">
    <header>
      <h3 class="section-title">Export 3MF</h3>
      <button class="icon-btn" title="Close export (Esc)" aria-label="Close export" @click="ex.close()">×</button>
    </header>
    <p class="muted">For Bambu Studio and OrcaSlicer. Painted areas are cut into separate triangles, one filament each.</p>

    <label class="slider">
      <span>Edge smoothing</span>
      <input v-model.number="ex.smoothMm" type="range" name="smoothMm" min="0" :max="SMOOTH_MAX" step="0.01" aria-label="Edge smoothing" />
      <output>{{ ex.smoothMm ? `${ex.smoothMm.toFixed(2)} mm` : 'Off' }}</output>
    </label>
    <p class="hint">How far boundaries may move to smooth the texel steps. Off follows the painted texels exactly.</p>

    <label class="check">
      <input v-model="ex.showCut" type="checkbox" name="showCut" />
      Show the cut mesh
    </label>

    <h4>Objects</h4>
    <p v-if="hiddenNote" class="muted">Nothing to export. Hidden objects are left out.</p>
    <ul class="objects">
      <li v-for="s in ex.summaries" :key="s.id">
        <span class="name" :title="s.name">{{ s.name }}</span>
        <span v-if="s.state === 'cutting'" class="muted">Cutting {{ pct(s.progress) }}</span>
        <span v-else-if="s.state === 'waiting'" class="muted">Waiting…</span>
        <span v-else-if="s.state === 'error'" class="bad" :title="s.error ?? ''">Failed</span>
        <span v-else class="muted">{{ s.triangles.toLocaleString() }} tris</span>
        <span v-if="s.state === 'done' || s.state === 'uncut'" :class="s.watertight ? 'ok' : 'warn'" :title="s.watertight ? 'Watertight' : s.sourceWatertight ? 'Cutting opened the mesh: please report this' : 'The imported mesh isn\'t watertight'">
          {{ s.watertight ? '✓' : '!' }}
        </span>
        <p v-if="s.state === 'uncut'" class="hint">Not painted (paint surface failed): exports in slot 1.</p>
        <p v-if="s.fallbacks" class="hint">{{ s.fallbacks }} triangle{{ s.fallbacks === 1 ? '' : 's' }} couldn't be cut exactly and use one filament.</p>
      </li>
    </ul>
    <p v-if="ex.summaries.length && !ex.busy" class="muted total">
      {{ ex.totalTriangles.toLocaleString() }} triangles{{ ex.allWatertight ? ', watertight' : '' }}
    </p>

    <h4>Filaments</h4>
    <ol class="filaments">
      <li v-for="f in slots" :key="f.n">
        <span class="num">{{ f.n }}</span>
        <span class="swatch" :style="{ background: f.slot?.color ?? '#888' }" />
        <span class="fname">{{ f.slot?.name ?? 'Missing slot' }}</span>
        <span class="muted">{{ f.slot?.material }}</span>
      </li>
    </ol>
    <p v-if="missing.length" class="warn-box">Paint uses slots that no longer exist in the palette.</p>
    <p class="hint">
      The slicer keeps your printer and filament settings. Filament N in the file is palette slot N: set each filament's colour and
      type to match before slicing.
    </p>

    <button class="btn btn-accent wide" :disabled="!ex.ready" @click="ex.exportFile()">
      {{ ex.writing ? 'Writing…' : ex.busy ? 'Cutting…' : 'Export 3MF…' }}
    </button>
  </section>
</template>

<style scoped>
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}
h3 {
  margin: 0;
}
h4 {
  margin: 1rem 0 0.4rem;
}
p {
  margin: 0 0 0.5rem;
}
.muted {
  color: var(--muted);
}
.hint {
  color: var(--muted);
  font-size: 0.8rem;
  margin: 0.25rem 0 0.5rem;
}
.icon-btn {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.25rem;
}
.icon-btn:hover {
  color: var(--text);
}
.slider {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.slider span {
  color: var(--muted);
}
.slider input {
  min-width: 0;
  accent-color: var(--accent);
}
.slider output {
  font-variant-numeric: tabular-nums;
  min-width: 4.2rem;
  text-align: right;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}
.objects,
.filaments {
  list-style: none;
  margin: 0;
  padding: 0;
}
.objects li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.2rem 0;
  font-size: 0.85rem;
}
.objects .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.objects .hint {
  flex-basis: 100%;
  margin: 0;
}
.total {
  font-size: 0.8rem;
  margin-top: 0.3rem;
}
.ok {
  color: var(--accent);
}
.warn {
  color: var(--warning);
  font-weight: 700;
}
.bad {
  color: var(--danger);
}
.filaments li {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.15rem 0;
  font-size: 0.85rem;
}
.num {
  width: 1.2rem;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.swatch {
  width: 1rem;
  height: 1rem;
  border-radius: 0;
  border: 1px solid var(--border);
}
.fname {
  flex: 1;
}
.warn-box {
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-radius: 0;
  padding: 0.5rem 0.6rem;
  font-size: 0.85rem;
}
.wide {
  width: 100%;
  margin-top: 0.75rem;
}
</style>
