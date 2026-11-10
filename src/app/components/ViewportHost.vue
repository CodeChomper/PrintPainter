<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PaintTool } from '@/engine/PaintTool';
import { Viewport } from '@/engine/Viewport';
import { sceneObjects } from '../document';
import { useUiStore } from '../stores/ui';
import { useSceneStore } from '../stores/scene';
import { usePaintStore } from '../stores/paint';
import { usePaletteStore } from '../stores/palette';
import { setViewport } from '../engine';
import PaintToolbar from './PaintToolbar.vue';

const host = ref<HTMLDivElement>();
const ui = useUiStore();
const scene = useSceneStore();
const paint = usePaintStore();
const palette = usePaletteStore();
let viewport: Viewport | null = null;
let tool: PaintTool | null = null;
let lastBlockedNotice = 0;

function pushToolSettings() {
  tool?.update({
    mode: paint.tool === 'select' ? null : paint.tool,
    radius: paint.size / 2,
    slot: palette.active,
    slotColor: palette.activeSlot.color,
    symmetry: [...paint.symmetry],
  });
}
const error = ref('');
const dragging = ref(false);
let dragDepth = 0;

onMounted(() => {
  try {
    viewport = new Viewport(host.value!);
    viewport.setNavPreset(ui.navPreset);
    viewport.onPick = (id) => scene.select(id);
    setViewport(viewport);
    scene.syncViewport();
    tool = new PaintTool(viewport);
    tool.onStrokeEnd = (edits) => paint.pushStroke(edits);
    tool.onBlocked = (id) => {
      if (performance.now() - lastBlockedNotice < 4000) return;
      lastBlockedNotice = performance.now();
      const o = sceneObjects.get(id);
      ui.notify(
        'info',
        o?.paintState === 'failed'
          ? `${o.name} can't be painted: ${o.paintError ?? 'preparing it failed'}.`
          : `Still preparing ${o?.name ?? 'this object'} for painting…`,
      );
    };
    pushToolSettings();
  } catch (e) {
    error.value = `Could not start the 3D view (WebGL): ${(e as Error).message}`;
  }
});

watch(() => ui.navPreset, (p) => viewport?.setNavPreset(p));
watch(
  () => [paint.tool, paint.size, paint.symmetry, palette.active, palette.activeSlot.color],
  pushToolSettings,
  { deep: true },
);
watch(() => paint.preview, (on) => viewport?.setPreview(on));

onBeforeUnmount(() => {
  tool?.dispose();
  tool = null;
  setViewport(null);
  viewport?.dispose();
  viewport = null;
});

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return;
  dragDepth++;
  dragging.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragging.value = false;
}
function onDrop(e: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) void scene.importFiles(files);
}
</script>

<template>
  <div
    ref="host"
    class="viewport"
    @contextmenu.prevent
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <p v-if="error" class="viewport-error">{{ error }}</p>
    <PaintToolbar v-else />
    <div v-if="dragging" class="drop-overlay">Drop to import</div>
    <div v-if="scene.busy" class="busy" role="status">{{ scene.busy }}</div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
}
.viewport-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 2rem;
  color: var(--danger);
  text-align: center;
}
.drop-overlay {
  position: absolute;
  inset: 0.75rem;
  display: grid;
  place-items: center;
  border: 2px dashed var(--accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  font-size: 1.2rem;
  pointer-events: none;
}
.busy {
  position: absolute;
  bottom: 0.75rem;
  left: 50%;
  translate: -50% 0;
  padding: 0.35rem 0.8rem;
  border-radius: 999px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  font-size: 0.85rem;
  pointer-events: none;
}
</style>
