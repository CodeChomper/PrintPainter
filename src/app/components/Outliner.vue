<script setup lang="ts">
import { useSceneStore } from '../stores/scene';

const scene = useSceneStore();
</script>

<template>
  <section class="outliner" aria-label="Objects">
    <h3>Objects</h3>
    <p v-if="!scene.items.length" class="muted">
      No objects yet. Use <strong>Import…</strong> or drop STL, OBJ, 3MF, STEP, glTF, PLY or FBX files on the view.
    </p>
    <ul v-else role="listbox" aria-label="Scene objects">
      <li
        v-for="item in scene.items"
        :key="item.id"
        role="option"
        :aria-selected="item.id === scene.selectedId"
        :class="{ selected: item.id === scene.selectedId }"
        tabindex="0"
        @click="scene.select(item.id)"
        @keydown.enter="scene.select(item.id)"
      >
        <span class="name" :title="item.name">{{ item.name }}</span>
        <span
          v-if="!item.watertight"
          class="badge warn"
          :title="`Not watertight: ${item.openEdges} open, ${item.nonManifoldEdges} non-manifold edges`"
          >!</span
        >
        <button class="remove" :aria-label="`Remove ${item.name}`" title="Remove" @click.stop="scene.remove(item.id)">×</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
h3 {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.muted {
  color: var(--muted);
  line-height: 1.5;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
}
li:hover {
  background: var(--panel-raised);
}
li.selected {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge.warn {
  display: inline-grid;
  place-items: center;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: var(--warning);
  color: #1b1d22;
  font-weight: 700;
  font-size: 0.75rem;
}
.remove {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.2rem;
  opacity: 0;
}
li:hover .remove,
li.selected .remove,
.remove:focus-visible {
  opacity: 1;
}
.remove:hover {
  color: var(--danger);
}
</style>
