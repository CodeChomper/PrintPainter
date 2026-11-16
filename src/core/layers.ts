// Layers, Photoshop style. An object's paint is a stack of layers, combined top-down
// into the one slot map that the viewport shows and the export cuts.
//
// - A paint layer holds any filaments (its own slot maps; 0 = transparent).
// - A fill layer is one filament everywhere, shaped by its masks.
// - Any layer can have masks. Each mask is on (1) or off (0) per texel; the stack of
//   masks combines in order (add, subtract or intersect, each optionally inverted).
//   With no enabled masks the whole layer shows. A first mask that adds starts from
//   nothing; one that subtracts starts from everything.
//
// Printing is hard-edged, so there is no opacity: a texel shows the topmost layer that
// has paint there and whose masks let it through.
//
// Pure TS, no DOM.

import type { PaintAtlas } from './atlas';
import { buildTopology, type FillTopology } from './fill';
import { angleMask, decalMask, edgeMask, heightMask, type DecalBitmap, type DecalChannel, type EdgeKind, type SurfaceInfo, type Vec3 } from './masks';
import { createMaps, MAX_SLOTS, resampleMaps, type Rect } from './paint';

export type { DecalBitmap, DecalChannel, EdgeKind, SurfaceInfo };

export type MaskOp = 'add' | 'subtract' | 'intersect';
export type MaskKind = 'painted' | 'angle' | 'height' | 'edge' | 'decal';

interface MaskBase {
  id: string;
  name: string;
  enabled: boolean;
  invert: boolean;
  op: MaskOp;
}
/** Painted by hand with the paint tools (its own 0/1 maps). */
export interface PaintedMask extends MaskBase {
  kind: 'painted';
}
/** Surfaces whose normal is between minDeg and maxDeg from dir. */
export interface AngleMask extends MaskBase {
  kind: 'angle';
  dir: Vec3;
  minDeg: number;
  maxDeg: number;
}
/** Height above the object's bottom, optionally repeating (stripes). */
export interface HeightMask extends MaskBase {
  kind: 'height';
  fromMm: number;
  toMm: number;
  /** 0 = no repeat. */
  repeatMm: number;
}
/** A band along sharp edges. */
export interface EdgeMask extends MaskBase {
  kind: 'edge';
  angleDeg: number;
  widthMm: number;
  which: EdgeKind;
}
export interface DecalText {
  text: string;
  font: string;
  bold: boolean;
  italic: boolean;
}
/** An image, SVG or text projected onto the surface. Placement is in source units. */
export interface DecalMask extends MaskBase {
  kind: 'decal';
  /** Key of the image in the document's bitmaps. */
  bitmap: string;
  channel: DecalChannel;
  /** 0..1 */
  threshold: number;
  centre: Vec3;
  dir: Vec3;
  up: Vec3;
  width: number;
  rotationDeg: number;
  through: boolean;
  /** Set for text decals (the bitmap is rendered from it). */
  text?: DecalText;
}
export type Mask = PaintedMask | AngleMask | HeightMask | EdgeMask | DecalMask;

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  kind: 'paint' | 'fill';
  /** Fill layers: the filament (1..16). */
  slot: number;
  masks: Mask[];
}

/** An object's layer stack (bottom first) and the data behind it. */
export interface LayerDoc {
  layers: Layer[];
  /** Paint layer contents and painted masks, by layer or mask id: one map per atlas page. */
  maps: Map<string, Uint8Array[]>;
  bitmaps: Map<string, DecalBitmap>;
}

let counter = 0;
/** A fresh id (letters and digits only: ids appear in file names). */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1679616;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** One paint layer holding `maps` (pass empty maps for a new object). */
export function defaultDoc(maps: Uint8Array[]): LayerDoc {
  const id = newId('L');
  return { layers: [{ id, name: 'Layer 1', visible: true, kind: 'paint', slot: 2, masks: [] }], maps: new Map([[id, maps]]), bitmaps: new Map() };
}

export const isProcedural = (m: Mask) => m.kind !== 'painted';

/** The ids whose maps the document needs: paint layers and painted masks. */
export function mapIds(layers: Layer[]): string[] {
  const out: string[] = [];
  for (const l of layers) {
    if (l.kind === 'paint') out.push(l.id);
    for (const m of l.masks) if (m.kind === 'painted') out.push(m.id);
  }
  return out;
}

/** Whether a map id belongs to a painted mask (0/1 values, not filaments). */
export function isMaskMap(layers: Layer[], id: string): boolean {
  return layers.some((l) => l.masks.some((m) => m.id === id));
}

/** Copies the stack descriptions (not the maps). */
export function cloneLayers(layers: Layer[]): Layer[] {
  return layers.map((l) => ({
    ...l,
    masks: l.masks.map((m) => {
      const c = { ...m } as Mask;
      if (c.kind === 'decal') {
        c.centre = [...c.centre];
        c.dir = [...c.dir];
        c.up = [...c.up];
        if (c.text) c.text = { ...c.text };
      } else if (c.kind === 'angle') c.dir = [...c.dir];
      return c;
    }),
  }));
}

/** Carries every map of a document to a new atlas of the same mesh. */
export function resampleDoc(doc: LayerDoc, oldAtlas: PaintAtlas, newAtlas: PaintAtlas): LayerDoc {
  const maps = new Map<string, Uint8Array[]>();
  for (const id of mapIds(doc.layers)) {
    const m = doc.maps.get(id);
    maps.set(id, m ? resampleMaps(oldAtlas, m, newAtlas) : createMaps(newAtlas));
  }
  return { layers: cloneLayers(doc.layers), maps, bitmaps: new Map(doc.bitmaps) };
}

/** Applies a slot lookup table to paint layers and fill slots (not to masks). */
export function remapDoc(doc: LayerDoc, lut: Uint8Array): void {
  for (const l of doc.layers) {
    if (l.kind === 'fill') l.slot = Math.max(1, lut[l.slot]!);
    else for (const m of doc.maps.get(l.id) ?? []) for (let i = 0; i < m.length; i++) m[i] = lut[m[i]!]!;
  }
}

/** Texel count per slot value over the paint layers, plus fill layer slots (counted once each). */
export function docSlotUse(doc: LayerDoc): Uint32Array {
  const h = new Uint32Array(256);
  for (const l of doc.layers) {
    if (l.kind === 'fill') h[l.slot]!++;
    else for (const m of doc.maps.get(l.id) ?? []) for (let i = 0; i < m.length; i++) h[m[i]!]!++;
  }
  return h;
}

/** Bytes held by maps that one stack has and the other doesn't (undo cost). */
export function exclusiveBytes(a: LayerDoc['maps'], b: LayerDoc['maps']): number {
  let n = 0;
  for (const [id, m] of a) if (b.get(id) !== m) n += m.reduce((s, x) => s + x.byteLength, 0);
  return n;
}

// ---- parameters ------------------------------------------------------------------

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, d: string, max = 200) => (typeof v === 'string' ? v.slice(0, max) : d);
const vec = (v: unknown, d: Vec3): Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : d;
const ID = /^[A-Za-z0-9]{1,40}$/;

/** Checks a stack read from a file. Throws a message on anything unusable; clamps numbers. */
export function parseLayers(v: unknown, bitmaps: ReadonlySet<string>): Layer[] {
  if (!Array.isArray(v) || !v.length || v.length > 256) throw new Error('the layer list is broken.');
  const ids = new Set<string>();
  const id = (x: unknown) => {
    if (typeof x !== 'string' || !ID.test(x) || ids.has(x)) throw new Error('a layer or mask has a bad id.');
    ids.add(x);
    return x;
  };
  return v.map((l: Record<string, unknown>, n): Layer => {
    if (!l || typeof l !== 'object') throw new Error(`layer ${n + 1} is broken.`);
    const kind = l.kind === 'fill' ? 'fill' : l.kind === 'paint' ? 'paint' : null;
    if (!kind) throw new Error(`layer ${n + 1} has an unknown kind.`);
    if (!Array.isArray(l.masks) || l.masks.length > 64) throw new Error(`layer ${n + 1}'s masks are broken.`);
    const layer: Layer = {
      id: id(l.id),
      name: str(l.name, `Layer ${n + 1}`),
      visible: l.visible !== false,
      kind,
      slot: Math.round(clamp(l.slot, 1, MAX_SLOTS, 2)),
      masks: [],
    };
    layer.masks = l.masks.map((m: Record<string, unknown>, k): Mask => {
      const base: MaskBase = {
        id: id(m?.id),
        name: str(m?.name, `Mask ${k + 1}`),
        enabled: m.enabled !== false,
        invert: m.invert === true,
        op: m.op === 'subtract' || m.op === 'intersect' ? m.op : 'add',
      };
      switch (m.kind) {
        case 'painted':
          return { ...base, kind: 'painted' };
        case 'angle':
          return { ...base, kind: 'angle', dir: vec(m.dir, [0, 0, 1]), minDeg: clamp(m.minDeg, 0, 180, 0), maxDeg: clamp(m.maxDeg, 0, 180, 30) };
        case 'height':
          return { ...base, kind: 'height', fromMm: clamp(m.fromMm, -1e6, 1e6, 0), toMm: clamp(m.toMm, -1e6, 1e6, 1), repeatMm: clamp(m.repeatMm, 0, 1e6, 0) };
        case 'edge':
          return {
            ...base,
            kind: 'edge',
            angleDeg: clamp(m.angleDeg, 1, 179, 30),
            widthMm: clamp(m.widthMm, 0.01, 1000, 1),
            which: m.which === 'convex' || m.which === 'concave' ? m.which : 'both',
          };
        case 'decal': {
          if (typeof m.bitmap !== 'string' || !bitmaps.has(m.bitmap)) throw new Error(`mask "${base.name}" has no image.`);
          const t = m.text as Record<string, unknown> | undefined;
          return {
            ...base,
            kind: 'decal',
            bitmap: m.bitmap,
            channel: m.channel === 'dark' || m.channel === 'light' ? m.channel : 'alpha',
            threshold: clamp(m.threshold, 0, 1, 0.5),
            centre: vec(m.centre, [0, 0, 0]),
            dir: vec(m.dir, [0, 0, -1]),
            up: vec(m.up, [0, 1, 0]),
            width: clamp(m.width, 1e-6, 1e9, 10),
            rotationDeg: clamp(m.rotationDeg, -360, 360, 0),
            through: m.through === true,
            text: t && typeof t === 'object' ? { text: str(t.text, '', 1000), font: str(t.font, 'sans-serif', 100), bold: t.bold === true, italic: t.italic === true } : undefined,
          };
        }
        default:
          throw new Error(`mask "${base.name}" has an unknown kind.`);
      }
    });
    return layer;
  });
}

/** What a procedural mask's result depends on (same key = same maps). */
function maskKey(m: Mask): string {
  switch (m.kind) {
    case 'painted':
      return 'p';
    case 'angle':
      return `a|${m.dir.join()}|${m.minDeg}|${m.maxDeg}`;
    case 'height':
      return `h|${m.fromMm}|${m.toMm}|${m.repeatMm}`;
    case 'edge':
      return `e|${m.angleDeg}|${m.widthMm}|${m.which}`;
    case 'decal':
      return `d|${m.bitmap}|${m.channel}|${m.threshold}|${m.centre.join()}|${m.dir.join()}|${m.up.join()}|${m.width}|${m.rotationDeg}|${m.through}`;
  }
}

// ---- compositing -----------------------------------------------------------------

/**
 * Keeps an object's composite slot map (`out`) in step with its layer document.
 * Procedural masks and each layer's combined mask are cached and only rebuilt when
 * their inputs change.
 */
export class Composer {
  private masks = new Map<string, { key: string; maps: Uint8Array[] }>();
  /** Per layer: combined mask (null = the whole layer shows). */
  private cover = new Map<string, { key: string; maps: Uint8Array[] | null }>();
  private topo: FillTopology | null = null;

  constructor(
    readonly atlas: PaintAtlas,
    readonly info: SurfaceInfo,
    public doc: LayerDoc,
    readonly out: Uint8Array[],
  ) {}

  private topology(): FillTopology {
    return (this.topo ??= buildTopology(this.atlas));
  }

  /** The maps of one mask (painted or procedural), building them if needed. */
  maskMaps(m: Mask): Uint8Array[] {
    if (m.kind === 'painted') {
      let maps = this.doc.maps.get(m.id);
      if (!maps) this.doc.maps.set(m.id, (maps = createMaps(this.atlas)));
      return maps;
    }
    const key = maskKey(m);
    const c = this.masks.get(m.id);
    if (c && c.key === key) return c.maps;
    const maps = this.evaluate(m);
    this.masks.set(m.id, { key, maps });
    return maps;
  }

  private evaluate(m: Exclude<Mask, PaintedMask>): Uint8Array[] {
    const a = this.atlas;
    switch (m.kind) {
      case 'angle':
        return angleMask(a, this.topology(), m.dir, m.minDeg, m.maxDeg);
      case 'height':
        return heightMask(a, this.info, m.fromMm, m.toMm, m.repeatMm);
      case 'edge':
        return edgeMask(a, this.info, this.topology(), m.angleDeg, m.widthMm, m.which);
      case 'decal': {
        const bmp = this.doc.bitmaps.get(m.bitmap);
        if (!bmp) return createMaps(a);
        return decalMask(a, bmp, m, m.channel, m.threshold);
      }
    }
  }

  private coverKey(l: Layer): string {
    return l.masks
      .filter((m) => m.enabled)
      .map((m) => `${m.id}:${m.op}:${m.invert}:${maskKey(m)}`)
      .join(';');
  }

  /** Rebuilds what changed and recomposites everything. */
  refresh(): void {
    const live = new Set<string>();
    for (const l of this.doc.layers) {
      live.add(l.id);
      for (const m of l.masks) live.add(m.id);
      const key = this.coverKey(l);
      const c = this.cover.get(l.id);
      if (c && c.key === key) continue;
      let maps: Uint8Array[] | null = null;
      if (key) {
        maps = c?.maps ?? createMaps(this.atlas);
        for (let p = 0; p < maps.length; p++) this.combine(l, p, null, maps);
      }
      this.cover.set(l.id, { key, maps });
    }
    for (const id of [...this.masks.keys()]) if (!live.has(id)) this.masks.delete(id);
    for (const id of [...this.cover.keys()]) if (!live.has(id)) this.cover.delete(id);
    for (let p = 0; p < this.out.length; p++) this.composite(p, null);
  }

  /** After painting into a layer's or painted mask's maps: recomposites the changed rectangles. */
  painted(id: string, dirty: (Rect | null)[]): void {
    const owner = this.doc.layers.find((l) => l.masks.some((m) => m.id === id && m.enabled));
    const c = owner && this.cover.get(owner.id);
    dirty.forEach((r, p) => {
      if (!r) return;
      if (owner && c?.maps) this.combine(owner, p, r, c.maps);
      this.composite(p, r);
    });
  }

  /** Writes a layer's combined mask for one page (or a rectangle of it). */
  private combine(l: Layer, p: number, r: Rect | null, into: Uint8Array[]): void {
    const masks = l.masks.filter((m) => m.enabled);
    const W = this.atlas.pages[p]!.width, H = this.atlas.pages[p]!.height;
    const dst = into[p]!;
    const x0 = r?.x0 ?? 0, x1 = r?.x1 ?? W, y0 = r?.y0 ?? 0, y1 = r?.y1 ?? H;
    const start = masks[0]?.op === 'subtract' ? 1 : 0;
    for (let y = y0; y < y1; y++) dst.fill(start, y * W + x0, y * W + x1);
    masks.forEach((m, k) => {
      const src = this.maskMaps(m)[p]!;
      const inv = m.invert ? 1 : 0;
      // The first mask sets the start value (add/intersect from nothing, subtract from everything).
      const op = k === 0 && m.op === 'intersect' ? 'add' : m.op;
      for (let y = y0; y < y1; y++) {
        for (let i = y * W + x0, e = y * W + x1; i < e; i++) {
          const s = (src[i]! ? 1 : 0) ^ inv;
          if (op === 'add') dst[i] = dst[i]! | s;
          else if (op === 'subtract') dst[i] = dst[i]! & (s ^ 1);
          else dst[i] = dst[i]! & s;
        }
      }
    });
  }

  private composite(p: number, r: Rect | null): void {
    const W = this.atlas.pages[p]!.width, H = this.atlas.pages[p]!.height;
    const out = this.out[p]!;
    const x0 = r?.x0 ?? 0, x1 = r?.x1 ?? W, y0 = r?.y0 ?? 0, y1 = r?.y1 ?? H;
    for (let y = y0; y < y1; y++) out.fill(0, y * W + x0, y * W + x1);
    for (const l of this.doc.layers) {
      if (!l.visible) continue;
      const cov = this.cover.get(l.id)?.maps?.[p] ?? null;
      if (l.kind === 'fill') {
        const v = l.slot;
        for (let y = y0; y < y1; y++) for (let i = y * W + x0, e = y * W + x1; i < e; i++) if (!cov || cov[i]) out[i] = v;
        continue;
      }
      const src = this.doc.maps.get(l.id)?.[p];
      if (!src) continue;
      for (let y = y0; y < y1; y++) {
        for (let i = y * W + x0, e = y * W + x1; i < e; i++) {
          const v = src[i]!;
          if (v && (!cov || cov[i])) out[i] = v;
        }
      }
    }
  }

  /** A layer's combined mask, or null when the whole layer shows (for display). */
  coverage(layerId: string): Uint8Array[] | null {
    return this.cover.get(layerId)?.maps ?? null;
  }
}
