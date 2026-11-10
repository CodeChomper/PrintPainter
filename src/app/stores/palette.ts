import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { MAX_SLOTS, remapSlots, slotHistogram } from '@/core/paint';
import {
  DEFAULT_PALETTE,
  parsePalette,
  serializePalette,
  SUGGESTED_COLORS,
  type PaletteSlot,
} from '@/core/palette';
import { platform } from '@/platform';
import { sceneObjects } from '../document';
import { getViewport } from '../engine';
import { usePaintStore } from './paint';
import { useUiStore } from './ui';

const CURRENT_KEY = 'pp.palette';
const LIBRARY_KEY = 'pp.paletteLibrary';
export const PALETTE_FILE_EXTENSIONS = ['json', '3mf', 'bbsflmt', 'orca_filament', 'zip'];

function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (valid(v)) return v as T;
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return fallback;
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const isSlots = (v: unknown) =>
  Array.isArray(v) && v.length >= 1 && v.length <= MAX_SLOTS && v.every((s) => typeof s?.color === 'string');

/** How many texels use each slot value, across every object. */
function usage(): Uint32Array {
  const total = new Uint32Array(256);
  for (const o of sceneObjects.values()) {
    if (!o.paint) continue;
    const h = slotHistogram(o.paint.maps);
    for (let i = 0; i < 256; i++) total[i]! += h[i]!;
  }
  return total;
}

/** Rewrites every object's paint (and the undo data) through a lookup table. */
function applyLut(lut: Uint8Array): void {
  const vp = getViewport();
  for (const o of sceneObjects.values()) {
    if (!o.paint) continue;
    remapSlots(o.paint.maps, lut);
    vp?.uploadPaint(o.id, 'all');
  }
  usePaintStore().remapHistory(lut);
}

export const usePaletteStore = defineStore('palette', () => {
  const ui = useUiStore();
  const slots = ref<PaletteSlot[]>(load(CURRENT_KEY, DEFAULT_PALETTE.map((s) => ({ ...s })), isSlots));
  /** 1-based slot the brush paints with. */
  const active = ref(Math.min(2, slots.value.length));
  const library = ref<Record<string, PaletteSlot[]>>(
    load(LIBRARY_KEY, {}, (v) => !!v && typeof v === 'object' && Object.values(v).every(isSlots)),
  );
  const colors = computed(() => slots.value.map((s) => s.color));
  const activeSlot = computed(() => slots.value[active.value - 1] ?? slots.value[0]!);

  watch(slots, (v) => save(CURRENT_KEY, v), { deep: true });
  watch(library, (v) => save(LIBRARY_KEY, v), { deep: true });
  watch(colors, (c) => getViewport()?.setPalette(c), { immediate: true });

  function select(n: number) {
    if (n >= 1 && n <= slots.value.length) active.value = n;
  }

  function add() {
    if (slots.value.length >= MAX_SLOTS) return;
    const used = new Set(slots.value.map((s) => s.color));
    const color = SUGGESTED_COLORS.find((c) => !used.has(c)) ?? '#888888';
    slots.value.push({ name: `Filament ${slots.value.length + 1}`, color, material: 'PLA' });
    active.value = slots.value.length;
  }

  function update(n: number, patch: Partial<PaletteSlot>) {
    const s = slots.value[n - 1];
    if (s) Object.assign(s, patch);
  }

  /**
   * Removes slot n. Paint in that slot goes back to unpainted (slot 1), higher slots
   * move down one. Asks first when the slot is in use.
   */
  function remove(n: number) {
    if (slots.value.length <= 1 || n < 1 || n > slots.value.length) return;
    const used = usage()[n]!;
    const s = slots.value[n - 1]!;
    if (used && !confirm(`Slot ${n} (${s.name}) is painted on the model. Remove it? That paint goes back to slot 1.`)) return;
    const lut = Uint8Array.from({ length: 256 }, (_, v) => (v === n ? 0 : v > n ? v - 1 : v));
    if (lut.some((v, i) => v !== i)) applyLut(lut);
    slots.value.splice(n - 1, 1);
    if (active.value > slots.value.length) active.value = slots.value.length;
  }

  /** Replaces the palette. Paint in slots the new palette doesn't have goes back to slot 1. */
  function replace(next: PaletteSlot[], what: string): boolean {
    const counts = usage();
    const lost = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1).filter((v) => v > next.length && counts[v]);
    if (lost.length && !confirm(`${what} has ${next.length} slot${next.length === 1 ? '' : 's'}. Paint in slot${lost.length === 1 ? '' : 's'} ${lost.join(', ')} will go back to slot 1. Continue?`)) {
      return false;
    }
    if (lost.length) applyLut(Uint8Array.from({ length: 256 }, (_, v) => (v > next.length ? 0 : v)));
    slots.value = next.map((s) => ({ ...s }));
    active.value = Math.min(Math.max(1, active.value), slots.value.length);
    return true;
  }

  async function importFiles(mode: 'replace' | 'add') {
    const files = await platform.openFiles({
      description: 'Palettes, filament presets and 3MF projects',
      extensions: PALETTE_FILE_EXTENSIONS,
      multiple: mode === 'add',
    });
    const incoming: PaletteSlot[] = [];
    for (const f of files) {
      try {
        const p = parsePalette(f.name, new Uint8Array(await f.arrayBuffer()));
        p.warnings.forEach((w) => ui.notify('warning', `${f.name}: ${w}`));
        incoming.push(...p.slots);
      } catch (e) {
        ui.notify('error', (e as Error).message);
      }
    }
    if (!incoming.length) return;
    if (mode === 'replace') {
      if (replace(incoming.slice(0, MAX_SLOTS), files.length === 1 ? files[0]!.name : 'The new palette')) {
        ui.notify('info', `Palette replaced: ${slots.value.length} filament${slots.value.length === 1 ? '' : 's'}.`);
      }
      return;
    }
    const room = MAX_SLOTS - slots.value.length;
    if (incoming.length > room) ui.notify('warning', `Only ${room} more slot${room === 1 ? '' : 's'} fit; ${incoming.length - room} skipped.`);
    slots.value.push(...incoming.slice(0, room).map((s) => ({ ...s })));
  }

  async function exportFile() {
    const name = 'PrintPainter palette';
    await platform.saveFile(new Blob([serializePalette(name, slots.value)], { type: 'application/json' }), {
      suggestedName: 'palette.json',
      description: 'PrintPainter palette',
      extension: 'json',
      mime: 'application/json',
    });
  }

  function saveToLibrary(name: string) {
    const n = name.trim();
    if (!n) return;
    library.value = { ...library.value, [n]: slots.value.map((s) => ({ ...s })) };
    ui.notify('info', `Saved palette "${n}".`);
  }

  function loadFromLibrary(name: string) {
    const p = library.value[name];
    if (p) replace(p, `"${name}"`);
  }

  function deleteFromLibrary(name: string) {
    const next = { ...library.value };
    delete next[name];
    library.value = next;
  }

  function resetToDefault() {
    replace(DEFAULT_PALETTE.map((s) => ({ ...s })), 'The default palette');
  }

  return {
    slots,
    active,
    activeSlot,
    colors,
    library,
    select,
    add,
    update,
    remove,
    importFiles,
    exportFile,
    saveToLibrary,
    loadFromLibrary,
    deleteFromLibrary,
    resetToDefault,
  };
});
