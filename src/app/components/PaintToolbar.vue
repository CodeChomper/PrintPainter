<script setup lang="ts">
import { computed } from 'vue';
import { BRUSH_MAX, BRUSH_MIN, usePaintStore, type Tool } from '../stores/paint';
import { usePaletteStore } from '../stores/palette';

const paint = usePaintStore();
const palette = usePaletteStore();

const tools: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: 'M5 3l13 8-6 1.5L9 19z' },
  { id: 'brush', label: 'Brush', key: 'B', icon: 'M14 4l6 6-8.5 8.5a3 3 0 01-4.2 0L5.5 16.7a3 3 0 010-4.2zM4 20h5' },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: 'M8 20h12M5.6 15.6l8-8a2 2 0 012.8 0l2 2a2 2 0 010 2.8L12 18.8H8.8z' },
];

// Log-scale slider so small brushes get as much travel as big ones.
const STEPS = 1000;
const toSlider = (mm: number) => Math.round((Math.log(mm / BRUSH_MIN) / Math.log(BRUSH_MAX / BRUSH_MIN)) * STEPS);
const fromSlider = (v: number) => BRUSH_MIN * (BRUSH_MAX / BRUSH_MIN) ** (v / STEPS);
const slider = computed({
  get: () => toSlider(paint.size),
  set: (v: number) => paint.setSize(fromSlider(v)),
});

const painting = computed(() => paint.tool !== 'select');
const axes = ['X', 'Y', 'Z'] as const;
</script>

<template>
  <div class="toolbar-overlay">
    <div class="group" role="radiogroup" aria-label="Tool">
      <button
        v-for="t in tools"
        :key="t.id"
        class="tool"
        role="radio"
        :aria-checked="paint.tool === t.id"
        :class="{ on: paint.tool === t.id }"
        :title="`${t.label} (${t.key})`"
        @click="paint.tool = t.id"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="t.icon" /></svg>
        <span class="sr-only">{{ t.label }}</span>
      </button>
    </div>

    <div v-if="painting" class="group options">
      <span
        v-if="paint.tool === 'brush'"
        class="slot"
        :style="{ background: palette.activeSlot.color }"
        :title="`Painting slot ${palette.active}: ${palette.activeSlot.name}`"
        >{{ palette.active }}</span
      >
      <label class="size" title="Brush size ([ and ] to change)">
        <span class="muted">Size</span>
        <input v-model.number="slider" type="range" name="brushSize" :min="0" :max="STEPS" step="1" aria-label="Brush size" />
        <input
          class="num"
          type="number"
          name="brushSizeMm"
          :min="BRUSH_MIN"
          :max="BRUSH_MAX"
          step="0.1"
          :value="paint.size"
          aria-label="Brush size in millimetres"
          @change="paint.setSize(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="muted">mm</span>
      </label>
      <span class="sym" role="group" aria-label="Mirror">
        <span class="muted">Mirror</span>
        <button
          v-for="(a, i) in axes"
          :key="a"
          class="tog"
          :class="{ on: paint.symmetry[i] }"
          :aria-pressed="paint.symmetry[i]"
          :title="`Mirror across the object's centre on ${a}`"
          @click="paint.symmetry[i] = !paint.symmetry[i]"
        >
          {{ a }}
        </button>
      </span>
    </div>

    <div class="group">
      <button class="tool" :disabled="!paint.canUndo" :title="paint.undoLabel ? `Undo ${paint.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'" @click="paint.undo()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" /></svg>
        <span class="sr-only">Undo</span>
      </button>
      <button class="tool" :disabled="!paint.canRedo" :title="paint.redoLabel ? `Redo ${paint.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'" @click="paint.redo()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" /></svg>
        <span class="sr-only">Redo</span>
      </button>
      <button
        class="tool wide"
        :class="{ on: paint.preview }"
        :aria-pressed="paint.preview"
        title="Print preview: filament colours only (P)"
        @click="paint.preview = !paint.preview"
      >
        Preview
      </button>
    </div>
  </div>
</template>

<style scoped>
.toolbar-overlay {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  right: 0.6rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  pointer-events: none;
}
.group {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 0.15rem;
  padding: 0.2rem;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.options {
  gap: 0.6rem;
  padding: 0.2rem 0.5rem;
}
.tool,
.tog {
  display: inline-grid;
  place-items: center;
  min-width: 2rem;
  height: 2rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}
.tool.wide {
  padding: 0 0.6rem;
}
.tog {
  min-width: 1.7rem;
  height: 1.7rem;
  font-weight: 600;
}
.tool:hover:not(:disabled),
.tog:hover {
  background: var(--panel-raised);
}
.tool.on,
.tog.on {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
  border-color: var(--accent);
}
.tool:disabled {
  opacity: 0.4;
  cursor: default;
}
svg {
  width: 1.15rem;
  height: 1.15rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.slot {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 4px;
  border: 1px solid rgb(255 255 255 / 0.35);
  font-size: 0.75rem;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 0 2px #000, 0 0 2px #000;
}
.size,
.sym {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
}
.size input[type='range'] {
  width: 8rem;
  accent-color: var(--accent);
}
.num {
  width: 4rem;
  font: inherit;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.15rem 0.3rem;
}
.muted {
  color: var(--muted);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
