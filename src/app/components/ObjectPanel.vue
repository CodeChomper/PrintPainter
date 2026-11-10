<script setup lang="ts">
import { computed } from 'vue';
import { formatDims, UNIT_LABELS, type LengthUnit } from '@/core/units';
import { useSceneStore } from '../stores/scene';
import { usePaintStore } from '../stores/paint';

const scene = useSceneStore();
const paint = usePaintStore();
const o = computed(() => scene.selected);
const units = Object.entries(UNIT_LABELS) as [LengthUnit, string][];

const cleanupLines = computed(() => {
  const s = o.value;
  if (!s) return [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return [
    s.mergedVertices && `Merged ${plural(s.mergedVertices, 'duplicate vertex', 'duplicate vertices')}`,
    s.removedDegenerate && `Removed ${plural(s.removedDegenerate, 'degenerate triangle')}`,
    s.removedDuplicate && `Removed ${plural(s.removedDuplicate, 'duplicate triangle')}`,
    s.flippedTriangles && `Flipped ${plural(s.flippedTriangles, 'inverted triangle')}`,
  ].filter((x): x is string => !!x);
});
</script>

<template>
  <section class="props" aria-label="Object properties">
    <h3>Properties</h3>
    <p v-if="!o" class="muted">Select an object to see its details.</p>
    <template v-else>
      <dl>
        <dt>Name</dt>
        <dd :title="o.name">{{ o.name }}</dd>
        <dt>File</dt>
        <dd :title="o.fileName">{{ o.fileName }}</dd>
        <dt>Size</dt>
        <dd>{{ formatDims(o.dims) }}</dd>
        <dt>Triangles</dt>
        <dd>{{ o.triangles.toLocaleString() }}</dd>
        <dt v-if="o.cadFaces !== null">CAD faces</dt>
        <dd v-if="o.cadFaces !== null">{{ o.cadFaces.toLocaleString() }}</dd>
        <dt v-if="o.components > 1">Pieces</dt>
        <dd v-if="o.components > 1">{{ o.components }}</dd>
      </dl>

      <label class="field">
        <span>File units</span>
        <select name="unit" :value="o.unit" @change="scene.setUnit(o.id, ($event.target as HTMLSelectElement).value as LengthUnit)">
          <option v-for="[id, label] in units" :key="id" :value="id">{{ label }}</option>
        </select>
      </label>
      <p v-if="o.siblings > 1" class="hint">Applies to all {{ o.siblings }} objects from this file.</p>

      <h4>Mesh check</h4>
      <p v-if="o.watertight" class="ok">Watertight</p>
      <div v-else class="warn-box">
        <p><strong>Not watertight.</strong> PrintPainter doesn't repair meshes.</p>
        <ul>
          <li v-if="o.openEdges"><span class="swatch open" />{{ o.openEdges.toLocaleString() }} open edges</li>
          <li v-if="o.nonManifoldEdges"><span class="swatch nm" />{{ o.nonManifoldEdges.toLocaleString() }} non-manifold edges</li>
          <li v-if="o.inconsistentEdges">{{ o.inconsistentEdges.toLocaleString() }} edges with mixed winding</li>
        </ul>
        <label class="check">
          <input type="checkbox" name="showEdges" :checked="scene.showEdges" @change="scene.setShowEdges(($event.target as HTMLInputElement).checked)" />
          Highlight problem edges
        </label>
      </div>
      <ul v-if="cleanupLines.length" class="cleanup">
        <li v-for="l in cleanupLines" :key="l">{{ l }}</li>
      </ul>

      <h4>Paint</h4>
      <p v-if="o.paintState === 'preparing'" class="muted">Preparing the paint surface…</p>
      <p v-else-if="o.paintState === 'failed'" class="warn-box">Couldn't prepare this object for painting: {{ o.paintError }}</p>
      <template v-else>
        <dl>
          <dt>Detail</dt>
          <dd>{{ o.texelMm?.toFixed(2) }} mm</dd>
          <dt>Texture{{ o.paintPages.length === 1 ? '' : 's' }}</dt>
          <dd>{{ o.paintPages.join(', ') }}</dd>
        </dl>
        <button class="btn" @click="paint.clearObject(o.id)">Clear paint</button>
      </template>

      <div class="row">
        <button class="btn" :title="o.hidden ? 'Show' : 'Hide (H)'" @click="scene.setHidden(o.id, !o.hidden)">{{ o.hidden ? 'Show' : 'Hide' }}</button>
        <button class="btn" title="Hide everything else (Shift+H)" @click="scene.isolate(o.id)">Isolate</button>
      </div>
      <button class="btn danger" @click="scene.remove(o.id)">Remove object</button>
    </template>
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
h4 {
  margin: 1rem 0 0.4rem;
  font-size: 0.85rem;
}
.muted {
  color: var(--muted);
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 0.75rem;
  margin: 0 0 0.75rem;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.field span {
  color: var(--muted);
}
.hint {
  margin: 0.3rem 0 0;
  color: var(--muted);
  font-size: 0.8rem;
}
.ok {
  color: var(--accent);
  margin: 0;
}
.warn-box {
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
}
.warn-box p {
  margin: 0 0 0.4rem;
}
.warn-box ul,
.cleanup {
  margin: 0 0 0.4rem;
  padding-left: 1.1rem;
  line-height: 1.6;
}
.warn-box ul {
  list-style: none;
  padding-left: 0;
}
.swatch {
  display: inline-block;
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 2px;
  margin-right: 0.4rem;
  vertical-align: -1px;
}
.swatch.open {
  background: #ff4d4d;
}
.swatch.nm {
  background: #ffa53d;
}
.check {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.cleanup {
  margin-top: 0.75rem;
  color: var(--muted);
  font-size: 0.85rem;
}
.row {
  display: flex;
  gap: 0.4rem;
  margin-top: 1rem;
}
.row .btn {
  flex: 1;
}
.danger {
  margin-top: 0.5rem;
  width: 100%;
}
.danger:hover {
  border-color: var(--danger);
  color: var(--danger);
}
</style>
