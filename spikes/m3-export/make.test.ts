// Builds sample 3MF exports through the real pipeline (atlas → paint → cut → writer)
// for the OrcaSlicer / Bambu Studio checks. `npm run spike:export`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { buildAtlas, RASTER_REACH } from '@/core/atlas';
import { cutMesh } from '@/core/export/cut';
import type { IndexedMesh } from '@/core/mesh';
import { closestOnTriangle, createMaps, triPages } from '@/core/paint';
import type { PaletteSlot } from '@/core/palette';
import { write3mfBambu } from '@/io/export/3mf/bambu';
import { box, uvSphere } from '../../tests/unit/meshes';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
type Fn = (x: number, y: number, z: number) => number;

const PALETTE: PaletteSlot[] = [
  ['White', '#FFFFFF'], ['Red', '#E53935'], ['Green', '#43A047'], ['Blue', '#1E88E5'],
  ['Yellow', '#FDD835'], ['Black', '#212121'], ['Orange', '#FB8C00'], ['Purple', '#8E24AA'],
  ['Cyan', '#00ACC1'], ['Pink', '#EC407A'], ['Brown', '#6D4C41'], ['Grey', '#9E9E9E'],
  ['Lime', '#C0CA33'], ['Navy', '#283593'], ['Teal', '#00897B'], ['Gold', '#FFB300'],
].map(([name, color]) => ({ name: name!, color: color!, material: 'PLA' }));

function paintBy(mesh: IndexedMesh, fn: Fn) {
  const atlas = buildAtlas(mesh, { texelSize: 0.1 });
  const maps = createMaps(atlas);
  const pageOf = triPages(atlas);
  const I = atlas.indices, U = atlas.uvs, X = atlas.positions;
  for (let t = 0; t < I.length / 3; t++) {
    const ia = I[t * 3]!, ib = I[t * 3 + 1]!, ic = I[t * 3 + 2]!;
    const ua = U[ia * 2]!, va = U[ia * 2 + 1]!, ub = U[ib * 2]!, vb = U[ib * 2 + 1]!, uc = U[ic * 2]!, vc = U[ic * 2 + 1]!;
    const det = (ub - ua) * (vc - va) - (uc - ua) * (vb - va);
    const page = atlas.pages[pageOf[t]!]!, map = maps[pageOf[t]!]!;
    for (let y = Math.max(0, Math.ceil(Math.min(va, vb, vc) - 1.25)); y <= Math.min(page.height - 1, Math.floor(Math.max(va, vb, vc) + 0.25)); y++) {
      for (let x = Math.max(0, Math.ceil(Math.min(ua, ub, uc) - 1.25)); x <= Math.min(page.width - 1, Math.floor(Math.max(ua, ub, uc) + 0.25)); x++) {
        let su = x + 0.5, sv = y + 0.5;
        let lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) / det, lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) / det;
        if (lb < 0 || lc < 0 || lb + lc > 1) {
          const q = closestOnTriangle(su, sv, ua, va, ub, vb, uc, vc);
          if ((q[0] - su) ** 2 + (q[1] - sv) ** 2 > RASTER_REACH ** 2) continue;
          [su, sv] = q;
          lb = ((su - ua) * (vc - va) - (uc - ua) * (sv - va)) / det;
          lc = ((ub - ua) * (sv - va) - (su - ua) * (vb - va)) / det;
        }
        const p = (k: number) => X[ia * 3 + k]! + lb * (X[ib * 3 + k]! - X[ia * 3 + k]!) + lc * (X[ic * 3 + k]! - X[ia * 3 + k]!);
        map[y * page.width + x] = fn(p(0), p(1), p(2));
      }
    }
  }
  return { atlas, maps };
}

function sample(name: string, mesh: IndexedMesh, fn: Fn, colours: number, centre: [number, number, number], filamentSettings = false) {
  const { atlas, maps } = paintBy(mesh, fn);
  const c = cutMesh(mesh, atlas, maps, { smoothMm: 0.05, texelMm: 0.1 });
  const positions = c.positions.map((v, i) => v - centre[i % 3]!);
  const bytes = write3mfBambu([{ name, positions, indices: c.indices, slots: c.slots }], {
    application: 'PrintPainter-M3-spike',
    palette: PALETTE.slice(0, colours),
    plateCentre: [128, 128],
    filamentSettings,
  });
  writeFileSync(join(OUT, `${name}.3mf`), bytes);
  const used = c.stats.slotTriangles.flatMap((n, s) => (n ? [s] : []));
  console.log(`${name.padEnd(22)} ${String(c.stats.triangles).padStart(6)} tris  watertight=${c.stats.watertight}  slots ${used.join(',')}`);
}

it('writes sample exports', () => {
  mkdirSync(OUT, { recursive: true });
  // 30 mm cube: a red disc on the front, a blue ball cut out of one top corner, a green band around the middle.
  const cube: Fn = (x, y, z) =>
    (x - 30) ** 2 + (y - 30) ** 2 + (z - 30) ** 2 < 12 ** 2 ? 4 : (x - 15) ** 2 + (z - 18) ** 2 < 36 && y < 0.01 ? 2 : Math.abs(z - 8) < 2.5 ? 3 : 1;
  sample('X-cube-4c', box(30), cube, 4, [15, 15, 0]);
  sample('X-cube-4c-settings', box(30), cube, 4, [15, 15, 0], true);
  // 40 mm sphere in 16 latitude bands with wavy edges: every filament 1..16.
  const sphere: Fn = (x, y, z) => Math.min(16, Math.max(1, 1 + Math.floor(((z + 20) / 40) * 16 + 0.6 * Math.sin(Math.atan2(y, x) * 4))));
  sample('X-sphere-16c', uvSphere(20, 96, 48), sphere, 16, [0, 0, -20]);
});
