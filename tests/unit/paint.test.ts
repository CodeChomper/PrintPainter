import { describe, expect, it } from 'vitest';
import { buildAtlas, type PaintAtlas } from '@/core/atlas';
import {
  createMaps,
  paintDab,
  PaintRecorder,
  remapSlots,
  resampleMaps,
  slotHistogram,
  swapTiles,
  triPages,
  type Dab,
} from '@/core/paint';
import { History } from '@/core/history';
import { box, plane } from './meshes';

const all = (a: PaintAtlas) => Uint32Array.from({ length: a.indices.length / 3 }, (_, i) => i);

function setup(mesh = plane(10, 10), texelSize = 0.1) {
  const atlas = buildAtlas(mesh, { texelSize });
  const maps = createMaps(atlas);
  const pages = triPages(atlas);
  const rec = new PaintRecorder(atlas, maps);
  const dab = (d: Dab) => paintDab(atlas, maps, pages, rec, d, all(atlas));
  return { atlas, maps, rec, dab };
}

/** Value at surface point (x, y, z) of a z-up plane: finds the triangle in the paint mesh and samples. */
function sampleAt(atlas: PaintAtlas, maps: Uint8Array[], x: number, y: number): number {
  const I = atlas.indices, P = atlas.positions, U = atlas.uvs;
  const pages = triPages(atlas);
  for (let t = 0; t < I.length / 3; t++) {
    const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
    const det = (P[b * 3]! - P[a * 3]!) * (P[c * 3 + 1]! - P[a * 3 + 1]!) - (P[c * 3]! - P[a * 3]!) * (P[b * 3 + 1]! - P[a * 3 + 1]!);
    const lb = ((x - P[a * 3]!) * (P[c * 3 + 1]! - P[a * 3 + 1]!) - (P[c * 3]! - P[a * 3]!) * (y - P[a * 3 + 1]!)) / det;
    const lc = ((P[b * 3]! - P[a * 3]!) * (y - P[a * 3 + 1]!) - (x - P[a * 3]!) * (P[b * 3 + 1]! - P[a * 3 + 1]!)) / det;
    if (lb < 0 || lc < 0 || lb + lc > 1) continue;
    const la = 1 - lb - lc;
    const u = la * U[a * 2]! + lb * U[b * 2]! + lc * U[c * 2]!;
    const v = la * U[a * 2 + 1]! + lb * U[b * 2 + 1]! + lc * U[c * 2 + 1]!;
    const pg = atlas.pages[pages[t]!]!;
    return maps[pages[t]!]![Math.floor(v) * pg.width + Math.floor(u)]!;
  }
  throw new Error('point not on mesh');
}

const down = (x: number, y: number, radius: number, value: number): Dab => ({
  origin: [x, y, 100],
  dir: [0, 0, -1],
  radius,
  value,
});

describe('paintDab', () => {
  it('paints a disc of the brush radius in mm', () => {
    const { atlas, maps, dab } = setup();
    const changed = dab(down(5, 5, 2, 3));
    // π r² at 0.1 mm per texel = 1257 texels.
    expect(changed).toBeGreaterThan(1257 * 0.95);
    expect(changed).toBeLessThan(1257 * 1.05);
    expect(sampleAt(atlas, maps, 5, 5)).toBe(3);
    expect(sampleAt(atlas, maps, 6.8, 5)).toBe(3);
    expect(sampleAt(atlas, maps, 7.3, 5)).toBe(0);
    expect(sampleAt(atlas, maps, 5, 2.7)).toBe(0);
  });

  it('ignores faces turned away from the brush', () => {
    const { dab } = setup();
    expect(dab({ origin: [5, 5, -100], dir: [0, 0, 1], radius: 3, value: 2 })).toBe(0);
  });

  it('respects the visibility test', () => {
    const { atlas, maps, dab } = setup();
    dab({ ...down(5, 5, 3, 2), visible: (x) => x > 5 });
    expect(sampleAt(atlas, maps, 6, 5)).toBe(2);
    expect(sampleAt(atlas, maps, 4, 5)).toBe(0);
  });

  it('erases with value 0 and reports no change when repainting the same slot', () => {
    const { atlas, maps, dab } = setup();
    dab(down(5, 5, 2, 4));
    expect(dab(down(5, 5, 2, 4))).toBe(0);
    dab(down(5, 5, 1, 0));
    expect(sampleAt(atlas, maps, 5, 5)).toBe(0);
    expect(sampleAt(atlas, maps, 6.5, 5)).toBe(4);
  });

  it('covers every texel a fragment can sample, including chart edges', () => {
    // Look at a cube corner so three faces (three charts) face the brush, and paint it all.
    const { atlas, maps, dab } = setup(box(10), 0.25);
    const dir: [number, number, number] = [-1, -1, -1].map((v) => v / Math.sqrt(3)) as [number, number, number];
    dab({ origin: [50, 50, 50], dir, radius: 100, value: 5 });
    const I = atlas.indices, U = atlas.uvs, P = atlas.positions;
    const pages = triPages(atlas);
    let checked = 0;
    for (let t = 0; t < I.length / 3; t++) {
      const [a, b, c] = [I[t * 3]!, I[t * 3 + 1]!, I[t * 3 + 2]!];
      // Front-facing?
      const e1 = [0, 1, 2].map((k) => P[b * 3 + k]! - P[a * 3 + k]!);
      const e2 = [0, 1, 2].map((k) => P[c * 3 + k]! - P[a * 3 + k]!);
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      if (n[0]! * dir[0] + n[1]! * dir[1] + n[2]! * dir[2] >= 0) continue;
      const W = atlas.pages[pages[t]!]!.width;
      // Fragment sample points: a fine grid of barycentrics, including the edges.
      for (let i = 0; i <= 40; i++) {
        for (let j = 0; i + j <= 40; j++) {
          const lb = i / 40, lc = j / 40, la = 1 - lb - lc;
          const u = la * U[a * 2]! + lb * U[b * 2]! + lc * U[c * 2]!;
          const v = la * U[a * 2 + 1]! + lb * U[b * 2 + 1]! + lc * U[c * 2 + 1]!;
          expect(maps[pages[t]!]![Math.min(Math.floor(v), 1e9) * W + Math.floor(u)]).toBe(5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('undo tiles', () => {
  it('records touched tiles and swaps them back and forth', () => {
    const { atlas, maps, rec, dab } = setup();
    dab(down(5, 5, 2, 3));
    const after = maps[0]!.slice();
    const edit = rec.finish()!;
    expect(edit).not.toBeNull();
    expect(edit.bytes).toBeGreaterThan(0);
    swapTiles(atlas, maps, edit);
    expect(slotHistogram(maps)[3]).toBe(0);
    swapTiles(atlas, maps, edit);
    expect(maps[0]).toEqual(after);
  });

  it('returns no edit when a stroke changed nothing', () => {
    const { rec } = setup();
    expect(rec.finish()).toBeNull();
  });

  it('reports dirty rectangles for upload', () => {
    const { rec, dab } = setup();
    dab(down(5, 5, 1, 2));
    const d = rec.takeDirty()[0]!;
    expect(d.x1 - d.x0).toBeGreaterThan(15);
    expect(d.x1 - d.x0).toBeLessThan(25);
    expect(rec.takeDirty()[0]).toBeNull();
  });
});

describe('resampleMaps', () => {
  it('keeps paint at the same surface points in a finer atlas', () => {
    const { atlas, maps, dab } = setup(box(10), 0.2);
    dab({ origin: [5, 5, 100], dir: [0, 0, -1], radius: 3, value: 2 });
    const before = slotHistogram(maps)[2]!;
    const fine = buildAtlas(box(10), { texelSize: 0.1 });
    const fineMaps = resampleMaps(atlas, maps, fine);
    const after = slotHistogram(fineMaps)[2]!;
    expect(after / before).toBeGreaterThan(3.5);
    expect(after / before).toBeLessThan(4.5);
  });
});

describe('remapSlots', () => {
  it('maps values through a lookup table', () => {
    const maps = [new Uint8Array([0, 1, 2, 3])];
    const lut = Uint8Array.from({ length: 256 }, (_, i) => (i === 2 ? 0 : i > 2 ? i - 1 : i));
    remapSlots(maps, lut);
    expect([...maps[0]!]).toEqual([0, 1, 0, 2]);
  });
});

describe('History', () => {
  const entry = (log: string[], label: string, bytes = 10) => ({
    label,
    bytes,
    targets: [label[0]!],
    undo: () => log.push(`undo ${label}`),
    redo: () => log.push(`redo ${label}`),
  });

  it('undoes and redoes in order, and a new action clears redo', () => {
    const log: string[] = [];
    const h = new History();
    h.push(entry(log, 'a1'));
    h.push(entry(log, 'a2'));
    h.undo();
    h.undo();
    h.redo();
    expect(log).toEqual(['undo a2', 'undo a1', 'redo a1']);
    h.push(entry(log, 'a3'));
    expect(h.canRedo).toBe(false);
    expect(h.undoLabel).toBe('a3');
  });

  it('drops the oldest entries past the memory budget', () => {
    const h = new History(25);
    const log: string[] = [];
    h.push(entry(log, 'a1'));
    h.push(entry(log, 'a2'));
    h.push(entry(log, 'a3'));
    expect(h.size).toBe(20);
    h.undo();
    h.undo();
    expect(h.canUndo).toBe(false);
  });

  it('drops entries for a removed target', () => {
    const h = new History();
    const log: string[] = [];
    h.push(entry(log, 'a1'));
    h.push(entry(log, 'b1'));
    h.drop('a');
    expect(h.undoLabel).toBe('b1');
    h.undo();
    expect(h.canUndo).toBe(false);
  });
});
