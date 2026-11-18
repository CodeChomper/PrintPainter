<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PaintTool } from '@/engine/PaintTool';
import { Viewport } from '@/engine/Viewport';
import { sceneObjects } from '../document';
import { useUiStore } from '../stores/ui';
import { useSceneStore } from '../stores/scene';
import { usePaintStore } from '../stores/paint';
import { usePaletteStore } from '../stores/palette';
import { useProjectStore } from '../stores/project';
import { useLayersStore } from '../stores/layers';
import { placeDecalAt } from '../decals';
import { setViewport } from '../engine';
import PaintToolbar from './PaintToolbar.vue';

const host = ref<HTMLDivElement>();
const ui = useUiStore();
const scene = useSceneStore();
const paint = usePaintStore();
const palette = usePaletteStore();
const layers = useLayersStore();
let viewport: Viewport | null = null;
let tool: PaintTool | null = null;
let lastBlockedNotice = 0;

/** Painting a mask shows in grey: it doesn't put down a filament. */
function maskTargeted(): boolean {
  void layers.rev;
  const id = scene.selectedId;
  const a = id ? layers.selection(id) : null;
  return !!a && a.target !== 'content';
}

function pushToolSettings() {
  tool?.update({
    mode: paint.tool === 'select' ? null : paint.tool,
    radius: paint.size / 2,
    shape: paint.shapeOf(paint.tool),
    slot: palette.active,
    slotColor: maskTargeted() ? '#d8d8d8' : palette.activeSlot.color,
    symmetry: [...paint.symmetry],
    fillMode: paint.fillMode,
    fillAngle: paint.fillAngle,
    lassoThrough: paint.lassoThrough,
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
    // Placing a decal: the next click on its object sets where it goes. Registered
    // before the paint tool's listener, so it runs first.
    viewport.renderer.domElement.addEventListener('pointerdown', onPlaceDown, { capture: true });
    tool = new PaintTool(viewport);
    tool.onStrokeEnd = (edits, erased) => paint.pushStroke(edits, erased);
    tool.targetFor = (id) => layers.paintTarget(id);
    tool.onPainted = (id, target, dirty) => layers.painted(id, target, dirty);
    tool.onBlocked = (id, reason) => {
      if (performance.now() - lastBlockedNotice < 4000) return;
      lastBlockedNotice = performance.now();
      const o = sceneObjects.get(id);
      if (reason) {
        ui.notify('info', reason);
        return;
      }
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
  () => [paint.tool, paint.size, paint.shapes, paint.symmetry, palette.active, palette.activeSlot.color, paint.fillMode, paint.fillAngle, paint.lassoThrough, maskTargeted()],
  pushToolSettings,
  { deep: true },
);

function onPlaceDown(e: PointerEvent) {
  const p = layers.placing;
  if (!p || e.button !== 0 || !viewport) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  const hit = viewport.paintHit(e.clientX, e.clientY);
  if (!hit || hit.id !== p.object) {
    ui.notify('info', 'Click on the object the decal belongs to (Esc cancels).');
    return;
  }
  placeDecalAt(p.object, p.layer, p.mask, hit.point);
  layers.placing = null;
}
watch(
  () => layers.placing,
  (p) => {
    if (viewport) viewport.renderer.domElement.style.cursor = p ? 'copy' : '';
  },
);

onBeforeUnmount(() => {
  viewport?.renderer.domElement.removeEventListener('pointerdown', onPlaceDown, { capture: true });
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
  const isProject = (f: File) => f.name.toLowerCase().endsWith('.ppaint');
  const project = files.find(isProject);
  if (project) {
    if (files.length > 1) ui.notify('warning', `Opening ${project.name}. Drop models on their own to import them.`);
    void useProjectStore().openDropped(project);
    return;
  }
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
    <div v-if="dragging" class="drop-overlay">Drop to import (or a .ppaint to open it)</div>
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
  border-radius: 0;
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
  border-radius: var(--radius-pill);
  background: var(--panel-raised);
  border: 1px solid var(--border);
  font-size: 0.85rem;
  pointer-events: none;
}
</style>
