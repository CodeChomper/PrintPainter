// PrintPainter M0 format spike.
// Hand-builds minimal multi-colour 3MF files to learn which file set each slicer needs.
// No dependencies: run with `node spikes/m0-3mf/build.mjs`. Output goes to spikes/m0-3mf/out/.
// SPDX-License-Identifier: GPL-3.0-or-later

import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

// ---------------------------------------------------------------------------
// Palette (16 slots max). Slot 1 = base.
const PALETTE = [
  ['White', '#FFFFFF'], ['Red', '#E53935'], ['Green', '#43A047'], ['Blue', '#1E88E5'],
  ['Yellow', '#FDD835'], ['Black', '#212121'], ['Orange', '#FB8C00'], ['Purple', '#8E24AA'],
  ['Cyan', '#00ACC1'], ['Pink', '#EC407A'], ['Brown', '#6D4C41'], ['Grey', '#9E9E9E'],
  ['Lime', '#C0CA33'], ['Navy', '#283593'], ['Teal', '#00897B'], ['Gold', '#FFB300'],
];

// ---------------------------------------------------------------------------
// Triangle state encoding (shared by Bambu/Orca `paint_color` and Prusa
// `slic3rpe:mmu_segmentation`). A leaf triangle is a bit stream:
//   2 bits split-sides (0 = leaf), then 2 bits state if state < 3,
//   else bits 1,1 followed by (state - 3) in 4-bit groups (15 = "continue").
// Bits are packed 4 per hex digit (first bit = LSB) and digits are written in
// reverse order. Whole-triangle results: 1="4", 2="8", 3="0C", 4="1C", ... 16="DC".
export function encodeState(state) {
  if (state === 0) return '';
  const bits = [0, 0];
  if (state < 3) bits.push(state & 1, (state >> 1) & 1);
  else {
    bits.push(1, 1);
    let n = state - 3;
    while (n >= 15) { bits.push(1, 1, 1, 1); n -= 15; }
    for (let i = 0; i < 4; i++) bits.push((n >> i) & 1);
  }
  let out = '';
  for (let o = 0; o < bits.length; o += 4) {
    let v = 0;
    for (let i = 3; i >= 0; i--) v = (v << 1) | (bits[o + i] ?? 0);
    out = v.toString(16).toUpperCase() + out;
  }
  return out;
}
assert.equal(encodeState(1), '4');
assert.equal(encodeState(2), '8');
assert.equal(encodeState(3), '0C');
assert.equal(encodeState(4), '1C');
assert.equal(encodeState(16), 'DC');

// ---------------------------------------------------------------------------
// Geometry: 20 mm cube, each face split into a 2x2 grid of quads (8 tris/face,
// 48 tris total), welded so the mesh is watertight. Local origin at the bottom
// centre so the cube sits on the plate.
const SIZE = 20;
const FACES = [ // name, origin, u, v  (u x v = outward normal, CCW from outside)
  ['+Z', [-10, -10, 20], [1, 0, 0], [0, 1, 0]],
  ['-Z', [-10, 10, 0], [1, 0, 0], [0, -1, 0]],
  ['+X', [10, -10, 0], [0, 1, 0], [0, 0, 1]],
  ['-X', [-10, 10, 0], [0, -1, 0], [0, 0, 1]],
  ['+Y', [10, 10, 0], [-1, 0, 0], [0, 0, 1]],
  ['-Y', [-10, -10, 0], [1, 0, 0], [0, 0, 1]],
];

function buildCube(slotFor /* (faceName, qi, qj, quadIndex) => slot */) {
  const verts = [];
  const index = new Map();
  const vid = (p) => {
    const k = p.map((c) => c.toFixed(4)).join(',');
    if (!index.has(k)) { index.set(k, verts.length); verts.push(p); }
    return index.get(k);
  };
  const tris = []; // [a, b, c, slot]
  let quad = 0;
  for (const [name, o, u, v] of FACES) {
    const P = (i, j) => o.map((c, k) => c + (u[k] * i + v[k] * j) * (SIZE / 2));
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++, quad++) {
        const a = vid(P(i, j)), b = vid(P(i + 1, j)), c = vid(P(i + 1, j + 1)), d = vid(P(i, j + 1));
        const slot = slotFor(name, i, j, quad);
        tris.push([a, b, c, slot], [a, c, d, slot]);
      }
    }
  }
  // Watertight check: every directed edge appears once, and its reverse once.
  const edges = new Map();
  for (const [a, b, c] of tris) for (const [x, y] of [[a, b], [b, c], [c, a]]) edges.set(`${x}>${y}`, (edges.get(`${x}>${y}`) ?? 0) + 1);
  for (const [k, n] of edges) {
    const [x, y] = k.split('>');
    assert.equal(n, 1, `edge ${k} used ${n} times`);
    assert.equal(edges.get(`${y}>${x}`), 1, `edge ${k} has no twin`);
  }
  return { verts, tris };
}

// Paint layouts -------------------------------------------------------------
const LAYOUTS = {
  // Top face slot 2, everything else base.
  c2: { colours: 2, slot: (f) => (f === '+Z' ? 2 : 1) },
  // Top face quadrants 1..4; sides -Y=2, +X=3, +Y=4, -X=1; bottom 1.
  c4: {
    colours: 4,
    slot: (f, i, j) => ({ '+Z': 1 + i + 2 * j, '-Y': 2, '+X': 3, '+Y': 4, '-X': 1, '-Z': 1 })[f],
  },
  // 24 quads cycle through all 16 slots.
  c16: { colours: 16, slot: (_f, _i, _j, q) => (q % 16) + 1 },
};

// ---------------------------------------------------------------------------
// XML pieces
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const NS_PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
const NS_SLIC3R = 'http://schemas.slic3r.org/3mf/2017/06';
const REL_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>
`;
const rels = (targets) => `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${targets.map((t, i) => ` <Relationship Target="${t}" Id="rel-${i + 1}" Type="${REL_MODEL}"/>`).join('\n')}
</Relationships>
`;

function meshXml(mesh, paintAttr, mat = false) {
  const v = mesh.verts.map((p) => `     <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('\n');
  const t = mesh.tris.map(([a, b, c, s]) => {
    const code = encodeState(s);
    const m = mat ? ` pid="1" p1="${s - 1}"` : '';
    return `     <triangle v1="${a}" v2="${b}" v3="${c}"${m}${paintAttr && code ? ` ${paintAttr}="${code}"` : ''}/>`;
  }).join('\n');
  return `    <mesh>\n     <vertices>\n${v}\n     </vertices>\n     <triangles>\n${t}\n     </triangles>\n    </mesh>`;
}

const meta = (pairs) => pairs.map(([k, v]) => ` <metadata name="${esc(k)}">${esc(v)}</metadata>`).join('\n');

// Single-file model: mesh lives in 3D/3dmodel.model.
function flatModel({ mesh, paintAttr, nsExtra = '', metadata = [], tx, ty, app = 'PrintPainter-M0-spike', materials = 0 }) {
  // materials > 0: core-spec <basematerials> (one per slot); triangles reference them via pid/p1.
  const oid = materials ? 2 : 1;
  const mats = materials
    ? ` <basematerials id="1">
${PALETTE.slice(0, materials).map(([nm, col]) => `   <base name="${nm}" displaycolor="${col}FF"/>`).join('\n')}
  </basematerials>
 `
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}"${nsExtra}>
${meta([['Application', app], ...metadata])}
 <resources>
 ${mats} <object id="${oid}" type="model" name="cube"${materials ? ' pid="1" pindex="0"' : ''}>
${meshXml(mesh, paintAttr, materials > 0)}
  </object>
 </resources>
 <build>
  <item objectid="${oid}" transform="1 0 0 0 1 0 0 0 1 ${tx} ${ty} 0"/>
 </build>
</model>
`;
}

// Production-extension layout (what Bambu Studio itself writes): root model
// holds a component that points at 3D/Objects/object_1.model.
function productionModels({ mesh, paintAttr, metadata = [], tx, ty }) {
  const root = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" xmlns:BambuStudio="${NS_BAMBU}" xmlns:p="${NS_PROD}" requiredextensions="p">
${meta([['Application', 'PrintPainter-M0-spike'], ...metadata])}
 <resources>
  <object id="2" p:UUID="${randomUUID()}" type="model">
   <components>
    <component p:path="/3D/Objects/object_1.model" objectid="1" p:UUID="${randomUUID()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build p:UUID="${randomUUID()}">
  <item objectid="2" p:UUID="${randomUUID()}" transform="1 0 0 0 1 0 0 0 1 ${tx} ${ty} 0" printable="1"/>
 </build>
</model>
`;
  const obj = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" xmlns:BambuStudio="${NS_BAMBU}" xmlns:p="${NS_PROD}" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="1" p:UUID="${randomUUID()}" type="model">
${meshXml(mesh, paintAttr)}
  </object>
 </resources>
</model>
`;
  return { root, obj };
}

const bambuProjectSettings = (n) => JSON.stringify({
  filament_colour: PALETTE.slice(0, n).map((p) => p[1]),
  filament_type: Array(n).fill('PLA'),
}, null, 4);

const bambuModelSettings = (objectId) => `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${objectId}">
    <metadata key="name" value="cube"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="cube"/>
      <metadata key="extruder" value="1"/>
    </part>
  </object>
</config>
`;

const prusaConfig = (n) => {
  const cols = PALETTE.slice(0, n).map((p) => p[1]);
  return [
    '; generated by PrintPainter M0 spike',
    '',
    '; printer_technology = FFF',
    `; nozzle_diameter = ${Array(n).fill('0.4').join(',')}`,
    `; extruder_colour = ${cols.join(';')}`,
    `; filament_colour = ${cols.join(';')}`,
    `; filament_type = ${Array(n).fill('PLA').join(';')}`,
    '',
  ].join('\n');
};

// ---------------------------------------------------------------------------
// Variants
const BAMBU_XY = [128, 128];
const PRUSA_XY = [125, 105];

const VARIANTS = [
  {
    id: 'A', desc: 'Core 3MF + paint_color only (no metadata, no filament colours)',
    files: ({ mesh }) => ({ '3D/3dmodel.model': flatModel({ mesh, paintAttr: 'paint_color', tx: BAMBU_XY[0], ty: BAMBU_XY[1] }) }),
  },
  {
    id: 'B', desc: 'A + Metadata/project_settings.config (filament_colour, filament_type)',
    files: ({ mesh, n }) => ({
      '3D/3dmodel.model': flatModel({ mesh, paintAttr: 'paint_color', tx: BAMBU_XY[0], ty: BAMBU_XY[1] }),
      'Metadata/project_settings.config': bambuProjectSettings(n),
    }),
  },
  {
    id: 'C', desc: 'B + BambuStudio:3mfVersion metadata + Metadata/model_settings.config',
    files: ({ mesh, n }) => ({
      '3D/3dmodel.model': flatModel({
        mesh, paintAttr: 'paint_color', nsExtra: ` xmlns:BambuStudio="${NS_BAMBU}"`,
        metadata: [['BambuStudio:3mfVersion', '1']], tx: BAMBU_XY[0], ty: BAMBU_XY[1],
      }),
      'Metadata/project_settings.config': bambuProjectSettings(n),
      'Metadata/model_settings.config': bambuModelSettings(1),
    }),
  },
  {
    id: 'D', desc: 'C but in the production-extension layout Bambu Studio writes (3D/Objects/object_1.model)',
    files: ({ mesh, n }) => {
      const { root, obj } = productionModels({
        mesh, paintAttr: 'paint_color', metadata: [['BambuStudio:3mfVersion', '1']], tx: BAMBU_XY[0], ty: BAMBU_XY[1],
      });
      return {
        '3D/3dmodel.model': root,
        '3D/Objects/object_1.model': obj,
        '3D/_rels/3dmodel.model.rels': rels(['/3D/Objects/object_1.model']),
        'Metadata/project_settings.config': bambuProjectSettings(n),
        'Metadata/model_settings.config': bambuModelSettings(2),
      };
    },
  },
  {
    id: 'E', desc: 'C with Application = "BambuStudio-02.09.01.70" (tests the "from Bambu Lab" check)',
    files: ({ mesh, n }) => ({
      '3D/3dmodel.model': flatModel({
        mesh, paintAttr: 'paint_color', nsExtra: ` xmlns:BambuStudio="${NS_BAMBU}"`,
        metadata: [['BambuStudio:3mfVersion', '1']], tx: BAMBU_XY[0], ty: BAMBU_XY[1],
        app: 'BambuStudio-02.09.01.70',
      }),
      'Metadata/project_settings.config': bambuProjectSettings(n),
      'Metadata/model_settings.config': bambuModelSettings(1),
    }),
  },
  {
    id: 'F', desc: 'A + core <basematerials> colours per slot (triangles pid/p1) + paint_color',
    files: ({ mesh, n }) => ({
      '3D/3dmodel.model': flatModel({ mesh, paintAttr: 'paint_color', tx: BAMBU_XY[0], ty: BAMBU_XY[1], materials: n }),
    }),
  },
  {
    id: 'G', desc: 'Core <basematerials> colours only, no paint_color (pure 3MF spec)',
    files: ({ mesh, n }) => ({
      '3D/3dmodel.model': flatModel({ mesh, paintAttr: null, tx: BAMBU_XY[0], ty: BAMBU_XY[1], materials: n }),
    }),
  },
  {
    id: 'P', desc: 'Prusa: slic3rpe:mmu_segmentation + Metadata/Slic3r_PE.config',
    files: ({ mesh, n }) => ({
      '3D/3dmodel.model': flatModel({
        mesh, paintAttr: 'slic3rpe:mmu_segmentation', nsExtra: ` xmlns:slic3rpe="${NS_SLIC3R}"`,
        metadata: [['slic3rpe:Version3mf', '1'], ['slic3rpe:MmPaintingVersion', '1']],
        tx: PRUSA_XY[0], ty: PRUSA_XY[1],
      }),
      'Metadata/Slic3r_PE.config': prusaConfig(n),
    }),
  },
];

// Which layouts to build per variant (keeps the manual test list short).
const MATRIX = { A: ['c2', 'c4'], B: ['c4'], C: ['c4', 'c16'], D: ['c4', 'c16'], E: ['c4', 'c16'], F: ['c4', 'c16'], G: ['c4', 'c16'], P: ['c4', 'c16'] };

// ---------------------------------------------------------------------------
// Minimal zip writer (deflate, no zip64, no data descriptors).
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | 11 << 5 | 8;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const variant of VARIANTS) {
  for (const layoutId of MATRIX[variant.id]) {
    const layout = LAYOUTS[layoutId];
    const mesh = buildCube(layout.slot);
    const files = {
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': rels(['/3D/3dmodel.model']),
      ...variant.files({ mesh, n: layout.colours }),
    };
    const name = `${variant.id}-${layoutId}.3mf`;
    writeFileSync(join(OUT, name), zip(Object.entries(files)));
    console.log(`${name.padEnd(12)} ${String(mesh.tris.length).padStart(3)} tris  ${variant.desc}`);
  }
}
