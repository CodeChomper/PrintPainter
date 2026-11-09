// Regenerates the small golden fixtures in this folder: `node tests/fixtures/make-fixtures.mjs`.
// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

// Unit cube, outward CCW triangles.
const C = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];

function binaryStl(tris, scale) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('PrintPainter fixture', 0);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    let o = 84 + i * 50 + 12; // normal left as zero (loaders recompute)
    for (const v of t) for (const c of C[v]) { buf.writeFloatLE(c * scale, o); o += 4; }
  });
  return buf;
}

// 20 mm cube, watertight.
writeFileSync(join(DIR, 'cube-20mm.stl'), binaryStl(T, 20));
// 20 mm cube with one triangle missing: 3 open edges.
writeFileSync(join(DIR, 'cube-open.stl'), binaryStl(T.slice(1), 20));

// Two cubes as separate OBJ objects, authored in centimetres (2 cm and 1 cm), no units stated.
const obj = ['# PrintPainter fixture: two objects, centimetres'];
const addObj = (name, size, dx, base) => {
  obj.push(`o ${name}`);
  for (const c of C) obj.push(`v ${c[0] * size + dx} ${c[1] * size} ${c[2] * size}`);
  for (const t of T) obj.push(`f ${t.map((v) => v + 1 + base).join(' ')}`);
};
addObj('BigCube', 2, 0, 0);
addObj('SmallCube', 1, 3, 8);
writeFileSync(join(DIR, 'two-cubes-cm.obj'), obj.join('\n') + '\n');

// ASCII PLY, 15 mm cube (units not stated).
const ply = ['ply', 'format ascii 1.0', `element vertex ${C.length}`, 'property float x', 'property float y', 'property float z',
  `element face ${T.length}`, 'property list uchar int vertex_indices', 'end_header',
  ...C.map((c) => c.map((x) => x * 15).join(' ')), ...T.map((t) => `3 ${t.join(' ')}`)];
writeFileSync(join(DIR, 'cube-15.ply'), ply.join('\n') + '\n');

console.log('fixtures written');
