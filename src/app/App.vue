<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import ViewportHost from './components/ViewportHost.vue';
import AboutDialog from './components/AboutDialog.vue';
import Outliner from './components/Outliner.vue';
import ObjectPanel from './components/ObjectPanel.vue';
import UnitsDialog from './components/UnitsDialog.vue';
import StepDialog from './components/StepDialog.vue';
import Toasts from './components/Toasts.vue';
import { useUiStore } from './stores/ui';
import { useSceneStore } from './stores/scene';
import { NAV_PRESETS, type NavPreset } from '@/engine/navigation';
import { getViewport } from './engine';

const ui = useUiStore();
const scene = useSceneStore();
const presets = Object.entries(NAV_PRESETS) as [NavPreset, { label: string; hint: string }][];
const hint = computed(() => NAV_PRESETS[ui.navPreset].hint);

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea, dialog[open]')) return;
  if (e.key === 'Delete' && scene.selectedId) scene.remove(scene.selectedId);
  else if (e.key === 'Escape') scene.select(null);
  else if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) getViewport()?.frame();
  else if (e.key === 'i' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void scene.openImportDialog();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="shell">
    <header class="toolbar">
      <strong class="brand">PrintPainter</strong>
      <button class="btn" title="Import models (Ctrl+I)" :disabled="!!scene.busy" @click="scene.openImportDialog()">Import…</button>
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
    </aside>

    <main class="stage">
      <ViewportHost />
    </main>

    <aside class="panel props">
      <ObjectPanel />
    </aside>

    <footer class="status">
      <span>Units: mm</span>
      <span>{{ scene.items.length }} object{{ scene.items.length === 1 ? '' : 's' }}</span>
      <span class="muted">{{ hint }}</span>
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
  padding: 0.4rem 0.75rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.brand {
  margin-right: 0.75rem;
  letter-spacing: 0.02em;
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
  background: var(--panel);
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
