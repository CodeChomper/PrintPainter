<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import ViewportHost from './components/ViewportHost.vue';
import AboutDialog from './components/AboutDialog.vue';
import Outliner from './components/Outliner.vue';
import PalettePanel from './components/PalettePanel.vue';
import ObjectPanel from './components/ObjectPanel.vue';
import LayersPanel from './components/LayersPanel.vue';
import ExportPanel from './components/ExportPanel.vue';
import UnitsDialog from './components/UnitsDialog.vue';
import StepDialog from './components/StepDialog.vue';
import Toasts from './components/Toasts.vue';
import { useUiStore } from './stores/ui';
import { useSceneStore } from './stores/scene';
import { usePaintStore } from './stores/paint';
import { usePaletteStore } from './stores/palette';
import { useExportStore } from './stores/export';
import { useProjectStore } from './stores/project';
import { useLayersStore } from './stores/layers';
import { NAV_PRESETS, type NavPreset } from '@/engine/navigation';
import { getViewport } from './engine';

const ui = useUiStore();
const scene = useSceneStore();
const paint = usePaintStore();
const palette = usePaletteStore();
const ex = useExportStore();
const project = useProjectStore();
const layers = useLayersStore();
const presets = Object.entries(NAV_PRESETS) as [NavPreset, { label: string; hint: string }][];
const hint = computed(() => NAV_PRESETS[ui.navPreset].hint);
const toolHint = computed(() => {
  if (layers.placing) return 'Click on the model to place the decal, projected along the view · Esc cancels';
  switch (paint.tool) {
    case 'brush':
      return `Left drag on the model: paint (Shift erases) · [ ]: size · ${hint.value}`;
    case 'eraser':
      return `Left drag on the model: erase · [ ]: size · ${hint.value}`;
    case 'fill':
      return `Click the model: fill the highlighted area (Shift erases it) · ${hint.value}`;
    case 'line':
      return `Drag on the model: paint a straight line (Shift erases) · [ ]: width · ${hint.value}`;
    case 'lasso':
      return `Drag: draw around what to paint (Shift erases) · Alt+drag or the other buttons move the view`;
    default:
      return hint.value;
  }
});

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea, dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const plain = !mod && !e.altKey;
  if (mod && key === 's') {
    e.preventDefault();
    void (e.shiftKey ? project.saveAs() : project.save());
  } else if (mod && key === 'o') {
    e.preventDefault();
    void project.open();
  } else if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) paint.redo();
    else paint.undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    paint.redo();
  } else if (mod && key === 'i') {
    e.preventDefault();
    void scene.openImportDialog();
  } else if (e.key === 'Delete' && scene.selectedId) scene.remove(scene.selectedId);
  else if (e.key === 'Escape') {
    if (layers.placing) layers.placing = null;
    else if (ex.open) ex.close();
    else if (paint.tool !== 'select') paint.tool = 'select';
    else scene.select(null);
  } else if (key === 'h' && e.altKey && !mod) {
    e.preventDefault();
    scene.showAll();
  } else if (e.key === '/' && !mod && !e.altKey) {
    // Any layout: some keyboards need Shift for "/".
    e.preventDefault();
    scene.toggleIsolate();
  } else if (key === 'h' && !mod && scene.selectedId) {
    if (e.shiftKey) scene.isolate(scene.selectedId);
    else scene.setHidden(scene.selectedId, true);
  } else if (!plain || e.shiftKey) return;
  else if (key === 'f') getViewport()?.frame();
  else if (key === 'v') paint.tool = 'select';
  else if (key === 'b') paint.tool = 'brush';
  else if (key === 'e') paint.tool = 'eraser';
  else if (key === 'g') paint.tool = 'fill';
  else if (key === 'u') paint.tool = 'line';
  else if (key === 'l') paint.tool = 'lasso';
  else if (key === 'p') paint.preview = !paint.preview;
  else if (e.key === '[') paint.setSize(paint.size / 1.25);
  else if (e.key === ']') paint.setSize(paint.size * 1.25);
  else if (/^[0-9]$/.test(e.key)) palette.select(e.key === '0' ? 10 : Number(e.key));
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  void project.start();
});

const autosaveText = computed(() => {
  switch (project.autosave) {
    case 'saving':
      return 'Autosaving…';
    case 'on':
      return project.lastAutosave ? 'Autosaved' : 'Autosave on';
    case 'other-tab':
      return 'Autosave off: open in another tab';
    case 'failed':
      return 'Autosave failed';
    case 'off':
      return 'Autosave unavailable in this browser';
    default:
      return '';
  }
});
const autosaveTitle = computed(() =>
  project.lastAutosave
    ? `Kept in this browser at ${new Date(project.lastAutosave).toLocaleTimeString()}. It comes back after a reload; use Save to keep a file.`
    : 'Your work is kept in this browser and comes back after a reload. Use Save to keep a file.',
);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="shell">
    <header class="toolbar">
      <strong class="brand"><span>Print</span>Painter</strong>
      <span class="project" :title="project.dirty ? 'Unsaved changes' : 'Saved'">{{ project.name }}<span v-if="project.dirty" class="dot" aria-label="unsaved changes">•</span></span>
      <button class="btn" title="Start an empty project" :disabled="!!project.busy" @click="project.newProject()">New</button>
      <button class="btn" title="Open a .ppaint project (Ctrl+O)" :disabled="!!project.busy" @click="project.open()">Open…</button>
      <button class="btn" title="Save the project (Ctrl+S)" :disabled="!!project.busy || !scene.items.length" @click="project.save()">Save</button>
      <button class="btn" title="Save the project as a new file (Ctrl+Shift+S)" :disabled="!!project.busy || !scene.items.length" @click="project.saveAs()">Save as…</button>
      <span class="sep" />
      <button class="btn" title="Import models (Ctrl+I)" :disabled="!!scene.busy" @click="scene.openImportDialog()">Import…</button>
      <button
        class="btn"
        :class="{ 'btn-accent': ex.open }"
        title="Cut the painted objects and export a 3MF for Bambu Studio or OrcaSlicer"
        :disabled="!scene.items.length"
        @click="ex.open ? ex.close() : ex.show()"
      >
        Export…
      </button>
      <button class="btn" title="Fit view (F)" @click="getViewport()?.frame()">Fit view</button>
      <span class="spacer" />
      <button v-if="ui.updateAvailable" class="btn btn-accent" @click="ui.update()">Update available: reload</button>
      <label class="field">
        Navigation
        <select v-model="ui.navPreset" name="navPreset">
          <option v-for="[id, p] in presets" :key="id" :value="id">{{ p.label }}</option>
        </select>
      </label>
      <button class="btn" @click="ui.aboutOpen = true">About</button>
    </header>

    <aside class="panel outliner">
      <Outliner />
      <PalettePanel />
    </aside>

    <main class="stage">
      <ViewportHost />
    </main>

    <aside class="panel props">
      <ExportPanel v-if="ex.open" />
      <template v-else>
        <LayersPanel />
        <ObjectPanel />
      </template>
    </aside>

    <footer class="status">
      <span>Units: mm</span>
      <span>{{ scene.items.length }} object{{ scene.items.length === 1 ? '' : 's' }}</span>
      <span v-if="project.busy">{{ project.busy }}</span>
      <span v-else-if="autosaveText" :class="{ warn: project.autosave === 'failed' }" :title="autosaveTitle">{{ autosaveText }}</span>
      <span class="muted">{{ toolHint }}</span>
    </footer>

    <AboutDialog />
    <UnitsDialog />
    <StepDialog />
    <Toasts />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 240px 1fr 280px;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    'toolbar toolbar toolbar'
    'outliner stage props'
    'status status status';
  height: 100dvh;
}
.toolbar {
  grid-area: toolbar;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.brand {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 1rem;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-right: 0.25rem;
}
.brand span {
  color: var(--accent);
}
.project {
  color: var(--muted);
  font-size: 0.85rem;
  margin-right: 0.5rem;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  color: var(--accent);
  margin-left: 0.2rem;
}
.sep {
  width: 1px;
  align-self: stretch;
  background: var(--border);
  margin: 0 0.25rem;
}
.warn {
  color: var(--warning);
}
.spacer {
  flex: 1;
}
.field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--muted);
  font-size: 0.85rem;
}
.outliner {
  grid-area: outliner;
  border-right: 1px solid var(--border);
}
.props {
  grid-area: props;
  border-left: 1px solid var(--border);
}
.stage {
  grid-area: stage;
  min-width: 0;
  min-height: 0;
}
.status {
  grid-area: status;
  display: flex;
  gap: 1.5rem;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  background: var(--bg);
  border-top: 1px solid var(--border);
}
.panel {
  background: var(--panel);
  padding: 0.75rem;
  overflow: auto;
  min-height: 0;
}
.muted {
  color: var(--muted);
}

@media (max-width: 900px) {
  .shell {
    grid-template-columns: 200px 1fr;
    grid-template-rows: auto 1fr auto auto;
    grid-template-areas: 'toolbar toolbar' 'outliner stage' 'props props' 'status status';
  }
  .props {
    border-left: none;
    border-top: 1px solid var(--border);
    max-height: 35dvh;
  }
}

@media (max-width: 700px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto auto auto;
    grid-template-areas: 'toolbar' 'stage' 'outliner' 'props' 'status';
  }
  .outliner {
    border-right: none;
    border-top: 1px solid var(--border);
    max-height: 25dvh;
  }
  .toolbar {
    flex-wrap: wrap;
  }
  .status .muted {
    display: none;
  }
}
</style>
