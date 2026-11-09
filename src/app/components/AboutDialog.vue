<script setup lang="ts">
import { ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { LINKS } from '../links';

const ui = useUiStore();
const dialog = ref<HTMLDialogElement>();
const version = __APP_VERSION__;

watch(
  () => ui.aboutOpen,
  (open) => (open ? dialog.value?.showModal() : dialog.value?.close()),
);
</script>

<template>
  <dialog ref="dialog" class="about" @close="ui.aboutOpen = false">
    <h2>PrintPainter <small>{{ version }}</small></h2>
    <p>Paint filaments on 3D models and export slice-ready 3MF files.</p>
    <p>Your models never leave your computer. PrintPainter has no telemetry.</p>
    <p>
      Free and open source under the
      <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener">GNU GPL v3 or later</a>.
      <template v-if="LINKS.repo">
        Source on <a :href="LINKS.repo" target="_blank" rel="noopener">GitHub</a>.
      </template>
    </p>
    <p v-if="LINKS.kofi">
      If it's useful to you, you can
      <a :href="LINKS.kofi" target="_blank" rel="noopener">support development on Ko-fi</a>.
    </p>
    <form method="dialog"><button class="btn">Close</button></form>
  </dialog>
</template>

<style scoped>
.about {
  max-width: min(32rem, calc(100vw - 2rem));
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  padding: 1.25rem 1.5rem;
}
.about::backdrop {
  background: rgb(0 0 0 / 0.5);
}
h2 {
  margin: 0 0 0.75rem;
  font-size: 1.15rem;
}
small {
  color: var(--muted);
  font-weight: normal;
  font-size: 0.8rem;
}
p {
  line-height: 1.5;
  margin: 0 0 0.75rem;
}
a {
  color: var(--accent);
}
form {
  display: flex;
  justify-content: flex-end;
}
</style>
