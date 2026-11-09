<script setup lang="ts">
import { useUiStore } from '../stores/ui';

const ui = useUiStore();
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <div v-for="n in ui.notices" :key="n.id" class="toast" :class="n.kind">
      <span>{{ n.text }}</span>
      <button aria-label="Dismiss" @click="ui.dismiss(n.id)">×</button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 1rem;
  bottom: 2.25rem;
  display: grid;
  gap: 0.5rem;
  width: min(26rem, calc(100vw - 2rem));
  z-index: 10;
  pointer-events: none;
}
.toast {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-left: 4px solid var(--muted);
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
  line-height: 1.45;
  pointer-events: auto;
}
.toast span {
  flex: 1;
}
.toast.warning {
  border-left-color: var(--warning);
}
.toast.error {
  border-left-color: var(--danger);
}
.toast.info {
  border-left-color: var(--accent);
}
button {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}
</style>
