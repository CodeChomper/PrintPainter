import { describe, expect, it } from 'vitest';
import { buildAtlas, type PaintAtlas } from '@/core/atlas';
import { buildTopology } from '@/core/fill';
import { Composer, defaultDoc, parseLayers, remapDoc, type Layer, type LayerDoc } from '@/core/layers';
import { angleMask, decalMask, edgeMask, heightMask, type DecalBitmap } from '@/core/masks';
import { createMaps } from '@/core/paint';
import { box } from './meshes';

/** Every texel whose centre is inside a triangle: page, index, triangle and surface point. */
function texels(atlas: PaintAtlas) {
  const out: { p: number; i: number; t: number; x: number; y: number; z: number }[] = [];
  const I = atlas.indices, U = atlas.uvs, P = atlas.positions;
  atlas.pages.forEach(({ width: W, height: H, triStart, triCount }, p) => {
    for (let t = triStart; t < triStart + triCount; t++) {
      const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
      const [ua, va, ub, vb, uc, vc] = [U[a * 2]!, U[a * 2 + 1]!, U[b * 2]!, U[b * 2 + 1]!, U[c * 2]!, U[c * 2 + 1]!];
      const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const lb = ((x + 0.5 - ua) * (vc - va) - (uc - ua) * (y + 0.5 - va)) / det;
          const lc = ((ub - ua) * (y + 0.5 - va) - (x + 0.5 - ua) * (vb - va)) / det;
          if (!(lb > 1e-6 && lc > 1e-6 && lb + lc < 1 - 1e-6)) continue;
          const at = (k: number) => P[a * 3 + k]! + lb * (P[b * 3 + k]! - P[a * 3 + k]!) + lc * (P[c * 3 + k]! - P[a * 3 + k]!);
          out.push({ p, i: y * W + x, t, x: at(0), y: at(1), z: at(2) });
        }
      }
    }
  });
  return out;
}

const atlas = buildAtlas(box(10), { texelSize: 0.25 });
const topo = buildTopology(atlas);
const info = { mmPerUnit: 1, minZ: 0 };
const all = texels(atlas);
const normalZ = (t: number) => topo.normals[t * 3 + 2]!;

describe('procedural masks', () => {
  it('angle: picks the faces turned up', () => {
    const m = angleMask(atlas, topo, [0, 0, 1], 0, 10);
    for (const s of all) expect(m[s.p]![s.i]).toBe(normalZ(s.t) > 0.99 ? 1 : 0);
  });

  it('height: repeating bands measured from the bottom', () => {
    const m = heightMask(atlas, { mmPerUnit: 1, minZ: 0 }, 1, 2, 3);
    for (const s of all) {
      const ph = (((s.z - 1) % 3) + 3) % 3;
      if (Math.abs(ph) < 0.2 || Math.abs(ph - 1) < 0.2 || Math.abs(ph - 3) < 0.2) continue; // near a band edge
      expect(m[s.p]![s.i], `z=${s.z}`).toBe(ph < 1 ? 1 : 0);
    }
  });

  it('edge: a band along the sharp box edges', () => {
    const m = edgeMask(atlas, info, topo, 30, 1, 'both');
    for (const s of all) {
      // Distance to the nearest box edge, measured on the face.
      const d = [s.x, s.y, s.z].map((v) => Math.min(v, 10 - v)).sort((a, b) => a - b);
      const toEdge = Math.hypot(d[0]!, d[1]!); // the coordinate on the face is ~0; the next is the distance
      if (Math.abs(toEdge - 1) < 0.2) continue;
      expect(m[s.p]![s.i], `${s.x},${s.y},${s.z}`).toBe(toEdge < 1 ? 1 : 0);
    }
    // A box has only convex edges.
    expect(edgeMask(atlas, info, topo, 30, 1, 'concave').every((p) => p.every((v) => v === 0))).toBe(true);
  });

  it('decal: projects an image straight down, onto what it sees first', () => {
    // 2×2 image: left column inked, right column clear.
    const bmp: DecalBitmap = { width: 2, height: 2, la: Uint8Array.from([0, 255, 0, 0, 0, 255, 0, 0]) };
    const place = { centre: [5, 5, 10], dir: [0, 0, -1], up: [0, 1, 0], width: 10, rotationDeg: 0, through: false };
    const m = decalMask(atlas, bmp, place, 'alpha', 0.5);
    for (const s of all) {
      if (Math.abs(s.x - 5) < 0.2) continue;
      const top = normalZ(s.t) > 0.99;
      expect(m[s.p]![s.i], `${s.x},${s.y},${s.z}`).toBe(top && s.x < 5 ? 1 : 0);
    }
    // Through: the bottom face gets it too.
    const t = decalMask(atlas, bmp, { ...place, through: true }, 'alpha', 0.5);
    const bottom = all.filter((s) => normalZ(s.t) < -0.99 && s.x < 4.8);
    expect(bottom.length).toBeGreaterThan(0);
    for (const s of bottom) expect(t[s.p]![s.i]).toBe(1);
    // Rotated 180°: the other half.
    const r = decalMask(atlas, bmp, { ...place, rotationDeg: 180 }, 'alpha', 0.5);
    for (const s of all.filter((q) => normalZ(q.t) > 0.99 && Math.abs(q.x - 5) > 0.2)) expect(r[s.p]![s.i]).toBe(s.x > 5 ? 1 : 0);
  });
});

describe('Composer', () => {
  function setup() {
    const doc: LayerDoc = defaultDoc(createMaps(atlas));
    doc.maps.get(doc.layers[0]!.id)!.forEach((m) => m.fill(2));
    const out = createMaps(atlas);
    return { doc, out, c: new Composer(atlas, info, doc, out) };
  }
  const fillTop = (): Layer => ({
    id: 'F1',
    name: 'Top',
    visible: true,
    kind: 'fill',
    slot: 3,
    masks: [{ id: 'M1', name: 'Up', enabled: true, invert: false, op: 'add', kind: 'angle', dir: [0, 0, 1], minDeg: 0, maxDeg: 10 }],
  });

  it('combines layers top-down through their masks', () => {
    const { doc, out, c } = setup();
    doc.layers.push(fillTop());
    c.refresh();
    for (const s of all) expect(out[s.p]![s.i]).toBe(normalZ(s.t) > 0.99 ? 3 : 2);
    // Hidden: only the paint layer.
    doc.layers[1]!.visible = false;
    c.refresh();
    expect(all.every((s) => out[s.p]![s.i] === 2)).toBe(true);
    // Inverted: everything but the top.
    doc.layers[1]!.visible = true;
    (doc.layers[1]!.masks[0]!).invert = true;
    c.refresh();
    for (const s of all) expect(out[s.p]![s.i]).toBe(normalZ(s.t) > 0.99 ? 2 : 3);
  });

  it('subtracts a painted mask and recomposites only what was painted', () => {
    const { doc, out, c } = setup();
    const l = fillTop();
    l.masks.push({ id: 'M2', name: 'Paint', enabled: true, invert: false, op: 'subtract', kind: 'painted' });
    doc.layers.push(l);
    c.refresh();
    // Paint the mask over the whole of page 0, then report only a rectangle.
    const pm = doc.maps.get('M2')!;
    pm[0]!.fill(1);
    const W = atlas.pages[0]!.width;
    c.painted('M2', [{ x0: 0, y0: 0, x1: W, y1: 4 }]);
    for (const s of all) {
      if (normalZ(s.t) < 0.99) continue;
      const inRect = s.p === 0 && s.i < 4 * W;
      expect(out[s.p]![s.i]).toBe(inRect ? 2 : 3);
    }
  });

  it('an empty paint layer is transparent, and slot remaps skip masks', () => {
    const { doc, out, c } = setup();
    doc.layers.push({ id: 'P2', name: 'Empty', visible: true, kind: 'paint', slot: 2, masks: [] });
    doc.maps.set('P2', createMaps(atlas));
    c.refresh();
    expect(all.every((s) => out[s.p]![s.i] === 2)).toBe(true);
    const l = fillTop();
    l.masks.push({ id: 'M3', name: 'P', enabled: true, invert: false, op: 'add', kind: 'painted' });
    doc.layers.push(l);
    doc.maps.set('M3', createMaps(atlas).map((m) => m.fill(1)));
    const lut = Uint8Array.from({ length: 256 }, (_, i) => (i === 2 ? 5 : i === 3 ? 4 : i));
    remapDoc(doc, lut);
    expect(doc.layers[2]!.slot).toBe(4);
    expect(doc.maps.get('M3')![0]![0]).toBe(1);
    expect(doc.maps.get(doc.layers[0]!.id)![0]!.every((v) => v === 5)).toBe(true);
  });
});

describe('parseLayers', () => {
  it('keeps a valid stack and clamps numbers', () => {
    const l = parseLayers(
      [{ id: 'A1', name: 'x', kind: 'fill', slot: 99, masks: [{ id: 'B2', kind: 'height', fromMm: 0, toMm: 5, repeatMm: -3 }] }],
      new Set(),
    );
    expect(l[0]!.slot).toBe(16);
    expect(l[0]!.masks[0]).toMatchObject({ kind: 'height', repeatMm: 0, op: 'add', enabled: true });
  });

  it('rejects bad ids, duplicates and decals without an image', () => {
    expect(() => parseLayers([{ id: '../x', kind: 'paint', masks: [] }], new Set())).toThrow();
    expect(() => parseLayers([{ id: 'A', kind: 'paint', masks: [] }, { id: 'A', kind: 'paint', masks: [] }], new Set())).toThrow();
    expect(() => parseLayers([{ id: 'A', kind: 'paint', masks: [{ id: 'B', kind: 'decal', bitmap: 'nope' }] }], new Set())).toThrow();
  });
});
