<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { MAX_SLOTS } from '@/core/paint';
import { MATERIALS } from '@/core/palette';
import { usePaletteStore } from '../stores/palette';

const palette = usePaletteStore();
const menu = ref<HTMLDetailsElement>();
const libraryNames = computed(() => Object.keys(palette.library).sort((a, b) => a.localeCompare(b)));

function run(fn: () => unknown) {
  if (menu.value) menu.value.open = false;
  void fn();
}

function saveToLibrary() {
  const name = prompt('Save this palette as:', 'My palette');
  if (name) palette.saveToLibrary(name);
}

const field = (e: Event) => (e.target as HTMLInputElement).value;

// <details> doesn't close on outside clicks by itself.
function onOutside(e: PointerEvent) {
  if (menu.value?.open && !menu.value.contains(e.target as Node)) menu.value.open = false;
}
onMounted(() => document.addEventListener('pointerdown', onOutside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside));
</script>

<template>
  <section class="palette" aria-label="Palette">
    <header>
      <h3>Palette</h3>
      <details ref="menu" class="menu">
        <summary class="icon-btn" title="Palette options" aria-label="Palette options">⋯</summary>
        <div class="menu-list" role="menu">
          <button role="menuitem" @click="run(() => palette.importFiles('add'))">Add from presets or 3MF…</button>
          <button role="menuitem" @click="run(() => palette.importFiles('replace'))">Replace from file…</button>
          <button role="menuitem" @click="run(() => palette.exportFile())">Export palette…</button>
          <hr />
          <button role="menuitem" @click="run(saveToLibrary)">Save to my palettes…</button>
          <template v-if="libraryNames.length">
            <p class="menu-label">My palettes</p>
            <div v-for="n in libraryNames" :key="n" class="lib-row">
              <button role="menuitem" class="lib-name" :title="`Load ${n}`" @click="run(() => palette.loadFromLibrary(n))">{{ n }}</button>
              <button class="lib-del" :aria-label="`Delete ${n}`" title="Delete" @click="palette.deleteFromLibrary(n)">×</button>
            </div>
          </template>
          <hr />
          <button role="menuitem" @click="run(() => palette.resetToDefault())">Reset to default</button>
        </div>
      </details>
    </header>

    <ol role="listbox" aria-label="Filament slots">
      <li
        v-for="(s, i) in palette.slots"
        :key="i"
        role="option"
        :aria-selected="palette.active === i + 1"
        :class="{ active: palette.active === i + 1 }"
        @click="palette.select(i + 1)"
      >
        <span class="num" :title="i === 0 ? 'Slot 1 is the base: unpainted surfaces print in it' : `Slot ${i + 1} (key ${i + 1 < 10 ? i + 1 : i + 1 === 10 ? 0 : '—'})`">{{ i + 1 }}</span>
        <input
          class="swatch"
          type="color"
          :name="`slot${i + 1}Color`"
          :value="s.color"
          :aria-label="`Slot ${i + 1} colour`"
          @input="palette.update(i + 1, { color: field($event) })"
          @click.stop
        />
        <input
          class="name"
          type="text"
          :name="`slot${i + 1}Name`"
          :value="s.name"
          :aria-label="`Slot ${i + 1} name`"
          @change="palette.update(i + 1, { name: field($event) || `Filament ${i + 1}` })"
          @focus="palette.select(i + 1)"
        />
        <input
          class="mat"
          type="text"
          list="pp-materials"
          :name="`slot${i + 1}Material`"
          :value="s.material"
          :aria-label="`Slot ${i + 1} material`"
          @change="palette.update(i + 1, { material: field($event).trim().toUpperCase() || 'PLA' })"
          @focus="palette.select(i + 1)"
        />
        <button
          class="remove"
          :disabled="palette.slots.length <= 1"
          :aria-label="`Remove slot ${i + 1}`"
          title="Remove slot"
          @click.stop="palette.remove(i + 1)"
        >
          ×
        </button>
      </li>
    </ol>
    <datalist id="pp-materials">
      <option v-for="m in MATERIALS" :key="m" :value="m" />
    </datalist>
    <button class="btn add" :disabled="palette.slots.length >= MAX_SLOTS" @click="palette.add()">
      Add slot <span class="muted">({{ palette.slots.length }}/{{ MAX_SLOTS }})</span>
    </button>
  </section>
</template>

<style scoped>
.palette {
  margin-top: 1.25rem;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}
h3 {
  margin: 0;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.menu {
  position: relative;
}
.menu summary {
  list-style: none;
}
.menu summary::-webkit-details-marker {
  display: none;
}
.icon-btn {
  display: grid;
  place-items: center;
  width: 1.6rem;
  height: 1.4rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--muted);
  font-size: 1.1rem;
  line-height: 1;
}
.icon-btn:hover,
.menu[open] .icon-btn {
  background: var(--panel-raised);
  color: var(--text);
}
.menu-list {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 14rem;
  padding: 0.3rem;
  background: var(--panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
}
.menu-list button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 0.85rem;
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
}
.menu-list button:hover {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
}
.menu-list hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0.3rem 0;
}
.menu-label {
  margin: 0.3rem 0.5rem 0.1rem;
  font-size: 0.75rem;
  color: var(--muted);
}
.lib-row {
  display: flex;
}
.lib-row .lib-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lib-row .lib-del {
  width: auto;
  color: var(--muted);
}
.lib-row .lib-del:hover {
  color: var(--danger);
  background: none;
}
ol {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.3rem;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
}
li:hover {
  background: var(--panel-raised);
}
li.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.num {
  width: 1.2rem;
  text-align: right;
  font-size: 0.8rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.swatch {
  width: 1.6rem;
  height: 1.4rem;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: none;
  cursor: pointer;
}
.swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}
.swatch::-webkit-color-swatch {
  border: none;
  border-radius: 2px;
}
.name,
.mat {
  min-width: 0;
  font: inherit;
  font-size: 0.82rem;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 0.1rem 0.25rem;
}
.name {
  flex: 1;
}
.mat {
  width: 3.8rem;
  color: var(--muted);
}
.name:hover,
.mat:hover,
.name:focus,
.mat:focus {
  border-color: var(--border);
  background: var(--bg);
}
.remove {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.15rem;
  opacity: 0;
}
li:hover .remove,
li.active .remove,
.remove:focus-visible {
  opacity: 1;
}
.remove:hover:not(:disabled) {
  color: var(--danger);
}
.remove:disabled {
  visibility: hidden;
}
.add {
  width: 100%;
}
.muted {
  color: var(--muted);
}
</style>
