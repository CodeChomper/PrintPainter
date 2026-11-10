<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { STEP_QUALITY, STEP_QUALITY_ORDER } from '@/io/import';
import { useSceneStore } from '../stores/scene';

const scene = useSceneStore();
const dialog = ref<HTMLDialogElement>();
const index = ref(1);
const files = computed(() => scene.stepQuestion);
const current = computed(() => STEP_QUALITY[STEP_QUALITY_ORDER[index.value]!]);

watch(files, async (v) => {
  if (v) {
    index.value = Math.max(0, STEP_QUALITY_ORDER.indexOf(scene.stepQuality));
    await nextTick();
    dialog.value?.showModal();
  } else dialog.value?.close();
});

const submit = () => scene.answerStepQuestion(STEP_QUALITY_ORDER[index.value]!);
</script>

<template>
  <dialog ref="dialog" class="step" @cancel.prevent="scene.answerStepQuestion(null)">
    <form v-if="files" method="dialog" @submit.prevent="submit">
      <h2>STEP import quality</h2>
      <p>
        <template v-if="files.length === 1"><strong>{{ files[0] }}</strong> is a CAD model, so it's</template>
        <template v-else><strong>{{ files.length }} STEP files</strong> are CAD models, so they're</template>
        turned into triangles on import. Finer settings follow curves more closely but make bigger meshes.
        Painting follows these triangles, so choose before you start.
      </p>
      <label class="slider">
        <span class="sr-only">Quality</span>
        <input v-model.number="index" type="range" name="stepQuality" min="0" :max="STEP_QUALITY_ORDER.length - 1" step="1" list="step-ticks" />
        <datalist id="step-ticks">
          <option v-for="(q, i) in STEP_QUALITY_ORDER" :key="q" :value="i" />
        </datalist>
      </label>
      <div class="ticks" aria-hidden="true">
        <button
          v-for="(q, i) in STEP_QUALITY_ORDER"
          :key="q"
          type="button"
          :class="{ active: i === index }"
          :style="{ left: `${(i / (STEP_QUALITY_ORDER.length - 1)) * 100}%` }"
          @click="index = i"
        >
          {{ STEP_QUALITY[q].label }}
        </button>
      </div>
      <p class="detail">
        <strong>{{ current.label }}:</strong> curves stay within {{ current.deviation }} mm of the CAD surface, with at most
        {{ current.angleDeg }}° between segments.
        <span v-if="index >= 2" class="warn">Large or detailed models can produce millions of triangles.</span>
      </p>
      <div class="actions">
        <button type="button" class="btn" @click="scene.answerStepQuestion(null)">Skip STEP files</button>
        <button type="submit" class="btn btn-accent">Import</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.step {
  width: min(32rem, calc(100vw - 2rem));
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  padding: 1.25rem 1.5rem;
}
.step::backdrop {
  background: rgb(0 0 0 / 0.5);
}
h2 {
  margin: 0 0 0.6rem;
  font-size: 1.1rem;
}
p {
  line-height: 1.5;
  margin: 0 0 0.9rem;
}
.slider {
  display: block;
}
.slider input {
  width: 100%;
  accent-color: var(--accent);
}
.ticks {
  position: relative;
  height: 1.6rem;
  margin: 0.1rem 0.5rem 0.9rem; /* inset by roughly half the slider thumb */
}
.ticks button {
  position: absolute;
  translate: -50% 0;
  white-space: nowrap;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0.2rem 0;
}
.ticks button:first-child {
  translate: -0.5rem 0;
}
.ticks button:last-child {
  translate: calc(-100% + 0.5rem) 0;
}
.ticks button.active {
  color: var(--text);
  font-weight: 600;
}
.detail {
  color: var(--muted);
  font-size: 0.9rem;
}
.warn {
  display: block;
  margin-top: 0.3rem;
  color: var(--warning);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
