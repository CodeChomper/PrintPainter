<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { formatDims, UNIT_LABELS, UNIT_TO_MM, type LengthUnit } from '@/core/units';
import { useSceneStore } from '../stores/scene';

const scene = useSceneStore();
const dialog = ref<HTMLDialogElement>();
const choice = ref<LengthUnit>('mm');
const q = computed(() => scene.unitQuestion);
const options: LengthUnit[] = ['mm', 'cm', 'm', 'in'];

watch(q, async (v) => {
  if (v) {
    choice.value = v.guess.unit;
    await nextTick();
    dialog.value?.showModal();
  } else dialog.value?.close();
});

const sizeIn = (u: LengthUnit) => formatDims(q.value!.size.map((s) => s * UNIT_TO_MM[u]));
</script>

<template>
  <dialog ref="dialog" class="units" @cancel.prevent="scene.answerUnitQuestion(null)">
    <form v-if="q" method="dialog" @submit.prevent="scene.answerUnitQuestion(choice)">
      <h2>Which units is this file in?</h2>
      <p>
        <strong>{{ q.fileName }}</strong> doesn't store its units. {{ q.guess.reason }} You can change this later
        in the object's properties.
      </p>
      <fieldset>
        <legend class="sr-only">Units</legend>
        <label v-for="u in options" :key="u" :class="{ active: choice === u }">
          <input v-model="choice" type="radio" name="unit" :value="u" />
          <span class="unit">{{ UNIT_LABELS[u] }}</span>
          <span class="size">{{ sizeIn(u) }}</span>
          <span v-if="u === q.guess.unit" class="tag">suggested</span>
        </label>
      </fieldset>
      <div class="actions">
        <button type="button" class="btn" @click="scene.answerUnitQuestion(null)">Cancel import</button>
        <button type="submit" class="btn btn-accent">Import</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.units {
  width: min(30rem, calc(100vw - 2rem));
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  padding: 1.25rem 1.5rem;
}
.units::backdrop {
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
fieldset {
  border: none;
  padding: 0;
  margin: 0 0 1rem;
  display: grid;
  gap: 0.35rem;
}
label {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.15rem 0.6rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
label.active {
  border-color: var(--accent);
}
.unit {
  font-weight: 600;
}
.size {
  grid-column: 2;
  color: var(--muted);
  font-size: 0.85rem;
}
.tag {
  grid-row: 1;
  grid-column: 3;
  font-size: 0.75rem;
  color: var(--accent);
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
