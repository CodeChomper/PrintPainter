<script setup lang="ts">
import { computed } from 'vue';
import ViewportHost from './components/ViewportHost.vue';
import AboutDialog from './components/AboutDialog.vue';
import { useUiStore } from './stores/ui';
import { NAV_PRESETS, type NavPreset } from '@/engine/navigation';
import { getViewport } from './engine';

const ui = useUiStore();
const presets = Object.entries(NAV_PRESETS) as [NavPreset, { label: string; hint: string }][];
const hint = computed(() => NAV_PRESETS[ui.navPreset].hint);
</script>

<template>
  <div class="shell">
    <header class="toolbar">
      <strong class="brand">PrintPainter</strong>
      <button class="btn" disabled title="Importers arrive in the next step of M1">Import…</button>
      <button class="btn" @click="getViewport()?.frame()" title="Fit view">Fit view</button>
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
      <h3>Objects</h3>
      <p class="muted">No objects yet. Import a model to start.</p>
    </aside>

    <main class="stage">
      <ViewportHost />
    </main>

    <footer class="status">
      <span>Units: mm</span>
      <span class="muted">{{ hint }}</span>
    </footer>

    <AboutDialog />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    'toolbar toolbar'
    'outliner stage'
    'status status';
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
}
.panel h3 {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.muted {
  color: var(--muted);
}

@media (max-width: 700px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto auto;
    grid-template-areas: 'toolbar' 'stage' 'outliner' 'status';
  }
  .outliner {
    border-right: none;
    border-top: 1px solid var(--border);
    max-height: 30dvh;
  }
  .toolbar {
    flex-wrap: wrap;
  }
  .status .muted {
    display: none;
  }
}
</style>
