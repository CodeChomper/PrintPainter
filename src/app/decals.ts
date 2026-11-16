// Decal images: turning image files, SVGs and text into grey+alpha bitmaps, and
// placing decals from the current view. Needs the DOM (canvas), so it lives in app/.

import { Vector3 } from 'three';
import { newId, type DecalBitmap, type DecalChannel, type DecalMask, type DecalText } from '@/core/layers';
import { UNIT_TO_MM } from '@/core/units';
import { sceneObjects } from './document';
import { getViewport } from './engine';
import { useLayersStore } from './stores/layers';

/** Longest side of a decal bitmap, in pixels. */
const MAX_SIDE = 2048;

export const DECAL_FONTS = ['sans-serif', 'serif', 'monospace', 'Arial Black', 'Impact', 'Georgia', 'Verdana', 'Courier New'];

function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! };
}

function toBitmap(ctx: CanvasRenderingContext2D, w: number, h: number): { bmp: DecalBitmap; transparent: boolean } {
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const la = new Uint8Array(w * h * 2);
  let clear = 0;
  for (let i = 0, n = w * h; i < n; i++) {
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!, a = rgba[i * 4 + 3]!;
    la[i * 2] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    la[i * 2 + 1] = a;
    if (a < 250) clear++;
  }
  return { bmp: { width: w, height: h, la }, transparent: clear > w * h * 0.01 };
}

/**
 * Reads a PNG, JPEG, WebP, GIF or SVG into a decal bitmap. Images with transparency
 * use their alpha as the shape; opaque ones use their dark parts.
 */
export async function bitmapFromFile(file: File): Promise<{ bmp: DecalBitmap; channel: DecalChannel }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error(`${file.name} isn't an image this browser can read.`);
    }
    const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
    // SVGs scale cleanly, so draw them at full size; photos only shrink.
    const k = svg ? MAX_SIDE / Math.max(w, h) : Math.min(1, MAX_SIDE / Math.max(w, h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const { ctx } = canvasOf(w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const { bmp, transparent } = toBitmap(ctx, w, h);
    return { bmp, channel: transparent ? 'alpha' : 'dark' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Renders text (several lines allowed) into a decal bitmap; the letters are the shape. */
export function bitmapFromText(t: DecalText): DecalBitmap {
  const lines = (t.text || ' ').split('\n');
  let size = 160;
  const fontOf = (px: number) => `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${px}px ${/\s/.test(t.font) ? `"${t.font}"` : t.font}`;
  const probe = canvasOf(1, 1).ctx;
  probe.font = fontOf(size);
  let widest = Math.max(1, ...lines.map((l) => probe.measureText(l).width));
  if (widest > MAX_SIDE * 0.9) {
    size = Math.floor((size * MAX_SIDE * 0.9) / widest);
    probe.font = fontOf(size);
    widest = Math.max(1, ...lines.map((l) => probe.measureText(l).width));
  }
  const pad = Math.ceil(size * 0.1);
  const lineH = Math.ceil(size * 1.2);
  const w = Math.ceil(widest) + pad * 2, h = lineH * lines.length + pad * 2;
  const { ctx } = canvasOf(w, h);
  ctx.font = fontOf(size);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, w / 2, pad + lineH * (i + 0.5)));
  return toBitmap(ctx, w, h).bmp;
}

/** World → the object's source units. */
function toLocal(objId: string, p: Vector3): [number, number, number] {
  const o = sceneObjects.get(objId)!;
  const s = UNIT_TO_MM[o.unit];
  return [(p.x - o.offset[0]) / s, (p.y - o.offset[1]) / s, (p.z - o.offset[2]) / s];
}

/** The camera's view direction and screen-up vector. */
function viewAxes(): { dir: [number, number, number]; up: [number, number, number] } | null {
  const vp = getViewport();
  if (!vp) return null;
  vp.camera.updateMatrixWorld();
  const up = new Vector3().setFromMatrixColumn(vp.camera.matrixWorld, 1).normalize();
  const dir = new Vector3().setFromMatrixColumn(vp.camera.matrixWorld, 2).negate().normalize();
  return { dir: [dir.x, dir.y, dir.z], up: [up.x, up.y, up.z] };
}

/** A placement looking the way the camera does, at what is in the middle of the view. */
export function placementFromView(objId: string): Pick<DecalMask, 'centre' | 'dir' | 'up' | 'width'> {
  const o = sceneObjects.get(objId)!;
  const b = o.srcBounds;
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  let centre: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const vp = getViewport();
  const r = vp?.renderer.domElement.getBoundingClientRect();
  const hit = vp && r ? vp.paintHit(r.left + r.width / 2, r.top + r.height / 2) : null;
  if (hit && hit.id === objId) centre = toLocal(objId, hit.point);
  const axes = viewAxes() ?? { dir: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
  return { centre, ...axes, width: size * 0.5 };
}

/** A new decal mask for an object, placed from the view. */
export function newDecalMask(objId: string, bitmap: string, channel: DecalChannel, name: string, text?: DecalText): DecalMask {
  return {
    id: newId('M'),
    name,
    enabled: true,
    invert: false,
    op: 'add',
    kind: 'decal',
    bitmap,
    channel,
    threshold: 0.5,
    ...placementFromView(objId),
    rotationDeg: 0,
    through: false,
    text,
  };
}

export const newBitmapId = () => newId('B');

/** Moves a decal to a clicked point (world), projecting along the current view. */
export function placeDecalAt(objId: string, layerId: string, maskId: string, world: Vector3): void {
  const axes = viewAxes();
  if (!axes) return;
  useLayersStore().updateMask(objId, layerId, maskId, { centre: toLocal(objId, world), ...axes } as Partial<DecalMask>);
}
