<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Viewport } from '@/engine/Viewport';
import { useUiStore } from '../stores/ui';
import { setViewport } from '../engine';

const host = ref<HTMLDivElement>();
const ui = useUiStore();
let viewport: Viewport | null = null;
const error = ref('');

onMounted(() => {
  try {
    viewport = new Viewport(host.value!);
    viewport.setNavPreset(ui.navPreset);
    setViewport(viewport);
  } catch (e) {
    error.value = `Could not start the 3D view (WebGL): ${(e as Error).message}`;
  }
});

watch(() => ui.navPreset, (p) => viewport?.setNavPreset(p));

onBeforeUnmount(() => {
  setViewport(null);
  viewport?.dispose();
  viewport = null;
});
</script>

<template>
  <div ref="host" class="viewport" @contextmenu.prevent>
    <p v-if="error" class="viewport-error">{{ error }}</p>
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
</style>
