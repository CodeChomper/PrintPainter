// Filament palette: slots 1..16 with name, colour and material type. Reads our own
// palette files, slicer filament presets (Bambu Studio / OrcaSlicer JSON, and preset
// bundles that zip them) and the filament list of a Bambu/Orca 3MF project.
//
// Pure TS, no DOM.

import { unzipSync } from 'fflate';
import { MAX_SLOTS } from './paint';

export interface PaletteSlot {
  name: string;
  /** #rrggbb */
  color: string;
  /** Filament type as the slicers write it (PLA, PETG, ...). */
  material: string;
}

export const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PLA-CF', 'PETG-CF', 'PA-CF'];

export const DEFAULT_PALETTE: readonly PaletteSlot[] = [
  { name: 'White', color: '#f2f2f2', material: 'PLA' },
  { name: 'Black', color: '#202020', material: 'PLA' },
  { name: 'Red', color: '#c8202e', material: 'PLA' },
  { name: 'Blue', color: '#1f5fbf', material: 'PLA' },
];

/** Colours given to new or colourless slots, in order. */
export const SUGGESTED_COLORS = [
  '#f2f2f2', '#202020', '#c8202e', '#1f5fbf', '#f2c230', '#2e9e4f', '#f07c1e', '#7d3fa0',
  '#8a8d91', '#e86fa8', '#4fc3d9', '#7a4a2a', '#b5d335', '#d9c7a3', '#123c69', '#9c1c1c',
];

export const PALETTE_FORMAT = 'printpainter-palette';

export interface PaletteFile {
  format: typeof PALETTE_FORMAT;
  version: 1;
  name: string;
  slots: PaletteSlot[];
}

export interface ParsedPalette {
  /** Suggested palette name (from the file). */
  name: string;
  slots: PaletteSlot[];
  warnings: string[];
}

/** '#abc', 'aabbcc', '#AABBCCDD' → '#aabbcc'; anything else → null. */
export function normalizeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (c) => c + c);
  if (/^[0-9a-f]{8}$/i.test(s)) s = s.slice(0, 6); // drop alpha
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
}

export function serializePalette(name: string, slots: readonly PaletteSlot[]): string {
  const file: PaletteFile = { format: PALETTE_FORMAT, version: 1, name, slots: slots.map((s) => ({ ...s })) };
  return JSON.stringify(file, null, 2);
}

/** "Bambu PLA Basic @BBL X1C" → "Bambu PLA Basic". */
function cleanPresetName(s: string): string {
  return s.replace(/\s*@.*$/, '').trim() || s.trim();
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Parses any supported palette/preset file. Throws Error with a user-facing message. */
export function parsePalette(fileName: string, bytes: Uint8Array): ParsedPalette {
  const base = fileName.replace(/\.[^.]+$/, '');
  const warnings: string[] = [];
  let slots: PaletteSlot[] = [];
  let name = base;

  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      throw new Error(`${fileName} is not a readable zip or 3MF file.`);
    }
    const project = Object.keys(files).find((k) => /(^|\/)project_settings\.config$/i.test(k));
    if (project) {
      slots = fromProjectConfig(parseJson(files[project]!, fileName));
      if (!slots.length) throw new Error(`${fileName} has no filament list in its project settings.`);
    } else {
      for (const [path, data] of Object.entries(files)) {
        if (!/\.json$/i.test(path)) continue;
        try {
          slots.push(...fromJson(parseJson(data, path), warnings).slots);
        } catch {
          warnings.push(`Skipped ${path}: not a filament preset.`);
        }
      }
      if (!slots.length) throw new Error(`${fileName} doesn't contain filament presets.`);
    }
  } else {
    const parsed = fromJson(parseJson(bytes, fileName), warnings);
    slots = parsed.slots;
    if (parsed.name) name = parsed.name;
    if (!slots.length) throw new Error(`${fileName} isn't a palette or filament preset.`);
  }

  // Fill missing colours with suggestions, de-duplicating against the colours already used.
  let k = 0;
  const missing = slots.filter((s) => !s.color).length;
  for (const s of slots) {
    if (s.color) continue;
    while (slots.some((o) => o.color === SUGGESTED_COLORS[k % SUGGESTED_COLORS.length]) && k < SUGGESTED_COLORS.length) k++;
    s.color = SUGGESTED_COLORS[k++ % SUGGESTED_COLORS.length]!;
  }
  if (missing) warnings.push(`${missing} preset${missing === 1 ? " doesn't" : "s don't"} store a colour; picked one, change it in the palette.`);
  if (slots.length > MAX_SLOTS) {
    warnings.push(`Only the first ${MAX_SLOTS} of ${slots.length} filaments were kept.`);
    slots = slots.slice(0, MAX_SLOTS);
  }
  return { name, slots, warnings };
}

function parseJson(bytes: Uint8Array, fileName: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, ''));
  } catch {
    throw new Error(`${fileName} is not valid JSON.`);
  }
}

function fromJson(data: unknown, warnings: string[]): { name: string | null; slots: PaletteSlot[] } {
  if (Array.isArray(data)) {
    const slots = data.flatMap((d) => fromJson(d, warnings).slots);
    return { name: null, slots };
  }
  if (!data || typeof data !== 'object') return { name: null, slots: [] };
  const o = data as Record<string, unknown>;

  if (o.format === PALETTE_FORMAT && Array.isArray(o.slots)) {
    const slots: PaletteSlot[] = [];
    for (const s of o.slots as Record<string, unknown>[]) {
      slots.push({
        name: asString(s?.name) || `Filament ${slots.length + 1}`,
        color: normalizeColor(s?.color) ?? '',
        material: asString(s?.material) || 'PLA',
      });
    }
    return { name: asString(o.name) || null, slots };
  }

  // A project config pasted as JSON, or a machine/process preset with filament arrays.
  if (Array.isArray(o.filament_colour) && o.filament_colour.length > 1) {
    return { name: null, slots: fromProjectConfig(o) };
  }

  // Single filament preset (Bambu Studio / OrcaSlicer user preset export).
  if ('filament_type' in o || o.type === 'filament') {
    const raw = asString(o.name) || asString(first(o.filament_settings_id)) || 'Filament';
    const color =
      normalizeColor(first(o.default_filament_colour)) ??
      normalizeColor(first(o.filament_colour)) ??
      normalizeColor(o.color) ??
      '';
    return {
      name: null,
      slots: [{ name: cleanPresetName(raw), color, material: asString(first(o.filament_type)) || 'PLA' }],
    };
  }
  return { name: null, slots: [] };
}

/** Bambu/Orca Metadata/project_settings.config: parallel arrays per filament. */
function fromProjectConfig(data: unknown): PaletteSlot[] {
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  const colours = Array.isArray(o.filament_colour) ? o.filament_colour : [];
  const types = Array.isArray(o.filament_type) ? o.filament_type : [];
  const ids = Array.isArray(o.filament_settings_id) ? o.filament_settings_id : [];
  const n = Math.max(colours.length, types.length);
  const slots: PaletteSlot[] = [];
  for (let i = 0; i < n; i++) {
    const type = asString(types[i]) || 'PLA';
    slots.push({
      name: ids[i] ? cleanPresetName(asString(ids[i])) : `${type} ${i + 1}`,
      color: normalizeColor(colours[i]) ?? '',
      material: type,
    });
  }
  return slots;
}
