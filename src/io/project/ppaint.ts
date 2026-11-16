// .ppaint project files: a zip with project.json plus the heavy data as raw
// little-endian typed arrays (one file per array). The same entries are used for the
// OPFS autosave, which stores them as separate files so unchanged ones aren't rewritten.
//
// What is stored: the cleaned mesh (not the original file: re-importing gives the same
// mesh, and STEP face IDs are kept), the cleanup report, units and placement, the paint
// atlas (it depends on the GPU texture limit of the machine that built it, so it is
// saved rather than rebuilt), the layer stack (version 2: descriptions in project.json,
// one map per atlas page for each paint layer and painted mask, decal images as grey +
// alpha bytes), the combined slot maps, and the palette. Version 1 files have only the
// combined maps; they open as one paint layer.
// Maps are raw bytes, not PNGs: deflate packs them as well and needs no encoder.
//
// Everything read from a file is checked (lengths, index ranges, sizes) before use,
// so a damaged or hand-made file is rejected with a message instead of crashing later.
//
// Pure TS, no DOM.

import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { AtlasPage, PaintAtlas } from '@/core/atlas';
import type { CleanupReport } from '@/core/cleanup';
import { defaultDoc, mapIds, parseLayers, type DecalBitmap, type Layer, type LayerDoc } from '@/core/layers';
import type { IndexedMesh } from '@/core/mesh';
import { MAX_SLOTS } from '@/core/paint';
import { normalizeColor, type PaletteSlot } from '@/core/palette';
import { UNIT_TO_MM, type LengthUnit } from '@/core/units';
import type { ImportFormat } from '@/io/import/types';

export const PROJECT_FORMAT = 'printpainter-project';
export const PROJECT_VERSION = 2;
export const PROJECT_EXTENSION = 'ppaint';
export const PROJECT_MIME = 'application/x-printpainter-project';
export const MANIFEST = 'project.json';

const FORMATS: readonly ImportFormat[] = ['stl', 'obj', '3mf', 'gltf', 'ply', 'fbx', 'step'];
/** Larger than any page the atlas makes (8192), smaller than anything absurd. */
const MAX_PAGE = 16384;
/** Largest decal image side. */
const MAX_BITMAP = 8192;
/** No single entry may unpack to more than this. */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error('PrintPainter project files need a little-endian platform.');
}

export class ProjectError extends Error {}

export interface ProjectPaint {
  atlas: PaintAtlas;
  /** The layers combined. */
  maps: Uint8Array[];
  doc: LayerDoc;
  texelMm: number;
  /**
   * False when the atlas was built for other units and still has to be rebuilt
   * (the paint is carried over when it is).
   */
  current: boolean;
}

export interface ProjectObject {
  id: string;
  name: string;
  fileName: string;
  format: ImportFormat;
  importId: string;
  unit: LengthUnit;
  offset: [number, number, number];
  hidden: boolean;
  mesh: IndexedMesh;
  report: CleanupReport;
  paint: ProjectPaint | null;
  /**
   * Change counters for the autosave, which skips entries whose tag hasn't changed.
   * Not written to the file.
   */
  revs?: { surface: number; paint: number; maps?: ReadonlyMap<string, number> };
}

export interface ProjectData {
  palette: PaletteSlot[];
  objects: ProjectObject[];
}

export interface ProjectEntry {
  path: string;
  /** Same tag as last time means same bytes. */
  tag: string;
  data(): Uint8Array;
}

interface ManifestPaint {
  texelMm: number;
  texelSize: number;
  charts: number;
  pages: AtlasPage[];
  current: boolean;
  /** Version 2. */
  layers?: Layer[];
  bitmaps?: { id: string; width: number; height: number }[];
}

interface ManifestObject {
  id: string;
  name: string;
  fileName: string;
  format: ImportFormat;
  importId: string;
  unit: LengthUnit;
  offset: [number, number, number];
  hidden: boolean;
  faceIds: boolean;
  report: Omit<CleanupReport, 'openEdges' | 'nonManifoldEdges'>;
  paint: ManifestPaint | null;
}

interface Manifest {
  format: typeof PROJECT_FORMAT;
  version: number;
  application: string;
  palette: PaletteSlot[];
  objects: ManifestObject[];
}

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const dir = (id: string) => `objects/${id}/`;

/** The project's files. The heavy ones are produced lazily, so unchanged ones cost nothing. */
export function projectEntries(p: ProjectData, application: string): { manifest: string; entries: ProjectEntry[] } {
  const entries: ProjectEntry[] = [];
  const objects: ManifestObject[] = p.objects.map((o) => {
    const d = dir(o.id);
    const surface = `s${o.revs?.surface ?? 0}`;
    const paintTag = `${surface}.p${o.revs?.paint ?? 0}`;
    const add = (name: string, tag: string, a: ArrayBufferView) => entries.push({ path: d + name, tag, data: () => bytesOf(a) });
    // The mesh never changes for an object id.
    add('mesh.positions.f32', 'g', o.mesh.positions);
    add('mesh.indices.u32', 'g', o.mesh.indices);
    if (o.mesh.faceIds) add('mesh.faceIds.i32', 'g', o.mesh.faceIds);
    add('report.openEdges.u32', 'g', o.report.openEdges);
    add('report.nonManifoldEdges.u32', 'g', o.report.nonManifoldEdges);
    let paint: ManifestPaint | null = null;
    if (o.paint) {
      const a = o.paint.atlas;
      add('atlas.indices.u32', surface, a.indices);
      add('atlas.uvs.f32', surface, a.uvs);
      add('atlas.xref.u32', surface, a.xref);
      add('atlas.triSource.u32', surface, a.triSource);
      o.paint.maps.forEach((m, i) => add(`paint.${i}.u8`, paintTag, m));
      const doc = o.paint.doc;
      for (const id of mapIds(doc.layers)) {
        const tag = `${surface}.m${o.revs?.maps?.get(id) ?? 0}`;
        doc.maps.get(id)?.forEach((m, i) => add(`layer.${id}.${i}.u8`, tag, m));
      }
      const used = new Set(doc.layers.flatMap((l) => l.masks.flatMap((m) => (m.kind === 'decal' ? [m.bitmap] : []))));
      const bitmaps: { id: string; width: number; height: number }[] = [];
      for (const id of used) {
        const b = doc.bitmaps.get(id);
        if (!b) continue;
        add(`bitmap.${id}.u8`, 'b', b.la); // an image never changes under one id
        bitmaps.push({ id, width: b.width, height: b.height });
      }
      paint = {
        texelMm: o.paint.texelMm,
        texelSize: a.texelSize,
        charts: a.charts,
        pages: a.pages.map((pg) => ({ ...pg })),
        current: o.paint.current,
        layers: doc.layers,
        bitmaps,
      };
    }
    const { openEdges: _o, nonManifoldEdges: _n, ...report } = o.report;
    return {
      id: o.id,
      name: o.name,
      fileName: o.fileName,
      format: o.format,
      importId: o.importId,
      unit: o.unit,
      offset: [...o.offset],
      hidden: o.hidden,
      faceIds: !!o.mesh.faceIds,
      report,
      paint,
    };
  });
  const manifest: Manifest = { format: PROJECT_FORMAT, version: PROJECT_VERSION, application, palette: p.palette.map((s) => ({ ...s })), objects };
  return { manifest: JSON.stringify(manifest, null, 1), entries };
}

/** Zips a project's files. */
export function packProject(manifest: string, files: Record<string, Uint8Array>): Uint8Array {
  const z: Zippable = { [MANIFEST]: [new TextEncoder().encode(manifest), { level: 6 }] };
  // Paint maps are mostly runs of one value; meshes barely compress. Level 1 is a good trade.
  for (const [path, data] of Object.entries(files)) z[path] = [data, { level: 1 }];
  return zipSync(z);
}

export function writeProject(p: ProjectData, application: string): Uint8Array {
  const { manifest, entries } = projectEntries(p, application);
  return packProject(manifest, Object.fromEntries(entries.map((e) => [e.path, e.data()])));
}

/** Unzips a .ppaint. */
export function unpackProject(bytes: Uint8Array): { manifest: string; files: Record<string, Uint8Array> } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.originalSize > MAX_ENTRY_BYTES) throw new ProjectError(`${f.name} is too large.`);
        return f.name === MANIFEST || /^objects\/[^/]+\/[\w.]+$/.test(f.name);
      },
    });
  } catch (e) {
    if (e instanceof ProjectError) throw e;
    throw new ProjectError("This isn't a PrintPainter project (it isn't a zip file).");
  }
  const m = files[MANIFEST];
  if (!m) throw new ProjectError("This isn't a PrintPainter project (project.json is missing).");
  delete files[MANIFEST];
  return { manifest: new TextDecoder().decode(m), files };
}

export function readProject(bytes: Uint8Array): ProjectData {
  const { manifest, files } = unpackProject(bytes);
  return parseProject(manifest, files);
}

// ---- reading -------------------------------------------------------------------

function fail(msg: string): never {
  throw new ProjectError(`The project file is damaged: ${msg}`);
}

type Ctor<T> = { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number };

function arr<T>(files: Record<string, Uint8Array>, path: string, C: Ctor<T>): T {
  const u = files[path];
  if (!u) fail(`${path} is missing.`);
  if (u.byteLength % C.BYTES_PER_ELEMENT) fail(`${path} has a partial value at the end.`);
  // A copy: it gets its own aligned buffer, and doesn't keep the whole zip alive.
  return new C(u.slice().buffer);
}

function maxOf(a: Uint32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return a.length ? m : -1;
}

function checkIndices(a: Uint32Array, count: number, what: string) {
  if (a.length && maxOf(a) >= count) fail(`${what} points past the end.`);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isStr = (v: unknown): v is string => typeof v === 'string';

function parsePaletteSlots(v: unknown): PaletteSlot[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SLOTS) fail('the palette is missing.');
  return v.map((s: Partial<PaletteSlot>, i) => {
    const color = normalizeColor(s?.color);
    if (!color) fail(`palette slot ${i + 1} has no colour.`);
    return { name: isStr(s.name) ? s.name : `Filament ${i + 1}`, color, material: isStr(s.material) ? s.material : 'PLA' };
  });
}

function parseReport(r: unknown, openEdges: Uint32Array, nonManifoldEdges: Uint32Array): CleanupReport {
  const x = (r ?? {}) as Record<string, unknown>;
  const n = (k: string) => (isNum(x[k]) ? (x[k] as number) : 0);
  return {
    inputTriangles: n('inputTriangles'),
    outputTriangles: n('outputTriangles'),
    mergedVertices: n('mergedVertices'),
    removedDegenerate: n('removedDegenerate'),
    removedDuplicate: n('removedDuplicate'),
    flippedTriangles: n('flippedTriangles'),
    components: n('components'),
    weldTolerance: n('weldTolerance'),
    openEdges,
    nonManifoldEdges,
    inconsistentEdges: n('inconsistentEdges'),
    watertight: x.watertight === true,
  };
}

/** Builds the project from its manifest and files, checking everything. */
export function parseProject(manifestText: string, files: Record<string, Uint8Array>): ProjectData {
  let m: Manifest;
  try {
    m = JSON.parse(manifestText) as Manifest;
  } catch {
    fail('project.json is not valid JSON.');
  }
  if (m?.format !== PROJECT_FORMAT) throw new ProjectError("This isn't a PrintPainter project.");
  if (!isInt(m.version, 1, Infinity)) fail('the version is missing.');
  if (m.version > PROJECT_VERSION) {
    throw new ProjectError('This project was saved by a newer version of PrintPainter. Reload the page to update, then open it again.');
  }
  const palette = parsePaletteSlots(m.palette);
  if (!Array.isArray(m.objects)) fail('the object list is missing.');
  const seen = new Set<string>();

  const objects = m.objects.map((o, n): ProjectObject => {
    const label = isStr(o?.name) ? `"${o.name}"` : `object ${n + 1}`;
    if (!isStr(o?.id) || !/^[\w-]+$/.test(o.id) || seen.has(o.id)) fail(`${label} has a bad id.`);
    seen.add(o.id);
    if (!FORMATS.includes(o.format)) fail(`${label} has an unknown format.`);
    if (!(o.unit in UNIT_TO_MM)) fail(`${label} has unknown units.`);
    if (!Array.isArray(o.offset) || o.offset.length !== 3 || !o.offset.every(isNum)) fail(`${label} has a bad position.`);
    const d = dir(o.id);

    const positions = arr(files, d + 'mesh.positions.f32', Float32Array);
    const indices = arr(files, d + 'mesh.indices.u32', Uint32Array);
    if (positions.length % 3 || indices.length % 3 || !indices.length) fail(`${label} has a broken mesh.`);
    for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]!)) fail(`${label} has invalid coordinates.`);
    const V = positions.length / 3;
    const T = indices.length / 3;
    checkIndices(indices, V, `${label}'s mesh`);
    const mesh: IndexedMesh = { positions, indices };
    if (o.faceIds) {
      mesh.faceIds = arr(files, d + 'mesh.faceIds.i32', Int32Array);
      if (mesh.faceIds.length !== T) fail(`${label}'s face IDs don't match its triangles.`);
    }
    const openEdges = arr(files, d + 'report.openEdges.u32', Uint32Array);
    const nonManifoldEdges = arr(files, d + 'report.nonManifoldEdges.u32', Uint32Array);
    if (openEdges.length % 2 || nonManifoldEdges.length % 2) fail(`${label}'s edge lists are broken.`);
    checkIndices(openEdges, V, `${label}'s open edge list`);
    checkIndices(nonManifoldEdges, V, `${label}'s non-manifold edge list`);
    const report = parseReport(o.report, openEdges, nonManifoldEdges);
    report.outputTriangles = T;

    let paint: ProjectPaint | null = null;
    if (o.paint) paint = parsePaint(o.paint, files, d, label, mesh);
    return {
      id: o.id,
      name: isStr(o.name) ? o.name : `Object ${n + 1}`,
      fileName: isStr(o.fileName) ? o.fileName : '',
      format: o.format,
      importId: isStr(o.importId) ? o.importId : o.id,
      unit: o.unit,
      offset: [o.offset[0], o.offset[1], o.offset[2]],
      hidden: o.hidden === true,
      mesh,
      report,
      paint,
    };
  });
  return { palette, objects };
}

function parsePaint(p: ManifestPaint, files: Record<string, Uint8Array>, d: string, label: string, mesh: IndexedMesh): ProjectPaint {
  if (!isNum(p.texelMm) || p.texelMm <= 0 || !isNum(p.texelSize) || p.texelSize <= 0) fail(`${label} has a bad paint detail.`);
  if (!Array.isArray(p.pages) || !p.pages.length) fail(`${label} has no paint pages.`);
  const V = mesh.positions.length / 3;
  const T = mesh.indices.length / 3;
  const indices = arr(files, d + 'atlas.indices.u32', Uint32Array);
  const uvs = arr(files, d + 'atlas.uvs.f32', Float32Array);
  const xref = arr(files, d + 'atlas.xref.u32', Uint32Array);
  const triSource = arr(files, d + 'atlas.triSource.u32', Uint32Array);
  const PV = xref.length;
  const AT = indices.length / 3;
  if (indices.length % 3 || uvs.length !== PV * 2 || triSource.length !== AT) fail(`${label}'s paint surface is broken.`);
  checkIndices(xref, V, `${label}'s paint surface`);
  checkIndices(indices, PV, `${label}'s paint surface`);
  checkIndices(triSource, T, `${label}'s paint surface`);
  for (let i = 0; i < uvs.length; i++) if (!Number.isFinite(uvs[i]!)) fail(`${label}'s paint surface has invalid coordinates.`);

  let next = 0;
  const pages: AtlasPage[] = p.pages.map((pg, i) => {
    if (!isInt(pg?.width, 1, MAX_PAGE) || !isInt(pg.height, 1, MAX_PAGE) || pg.triStart !== next || !isInt(pg.triCount, 0, AT)) {
      fail(`${label}'s paint page ${i + 1} is broken.`);
    }
    next += pg.triCount;
    return { width: pg.width, height: pg.height, triStart: pg.triStart, triCount: pg.triCount };
  });
  if (next !== AT) fail(`${label}'s paint pages don't cover its surface.`);

  const maps = pages.map((pg, i) => {
    const map = files[`${d}paint.${i}.u8`];
    if (!map) fail(`${label}'s paint page ${i + 1} is missing.`);
    if (map.length !== pg.width * pg.height) fail(`${label}'s paint page ${i + 1} is the wrong size.`);
    const out = map.slice();
    for (let k = 0; k < out.length; k++) if (out[k]! > MAX_SLOTS) out[k] = 0;
    return out;
  });

  const doc = p.layers === undefined ? defaultDoc(maps.map((m) => m.slice())) : parseDoc(p, files, d, label, pages);

  const positions = new Float32Array(PV * 3);
  for (let i = 0; i < PV; i++) {
    const s = xref[i]! * 3;
    positions[i * 3] = mesh.positions[s]!;
    positions[i * 3 + 1] = mesh.positions[s + 1]!;
    positions[i * 3 + 2] = mesh.positions[s + 2]!;
  }
  const atlas: PaintAtlas = {
    positions,
    indices,
    uvs,
    xref,
    triSource,
    pages,
    texelSize: p.texelSize,
    charts: isInt(p.charts, 0, Infinity) ? p.charts : 0,
  };
  if (mesh.faceIds) {
    const f = mesh.faceIds;
    atlas.faceIds = Int32Array.from(triSource, (t) => f[t]!);
  }
  return { atlas, maps, doc, texelMm: p.texelMm, current: p.current !== false };
}

function parseDoc(p: ManifestPaint, files: Record<string, Uint8Array>, d: string, label: string, pages: AtlasPage[]): LayerDoc {
  const bitmaps = new Map<string, DecalBitmap>();
  if (p.bitmaps !== undefined && !Array.isArray(p.bitmaps)) fail(`${label}'s decal images are broken.`);
  for (const b of p.bitmaps ?? []) {
    if (!isStr(b?.id) || !/^[A-Za-z0-9]{1,40}$/.test(b.id) || !isInt(b.width, 1, MAX_BITMAP) || !isInt(b.height, 1, MAX_BITMAP)) {
      fail(`${label} has a broken decal image.`);
    }
    const la = files[`${d}bitmap.${b.id}.u8`];
    if (!la || la.length !== b.width * b.height * 2) fail(`${label}'s decal image ${b.id} is missing or the wrong size.`);
    bitmaps.set(b.id, { width: b.width, height: b.height, la: la.slice() });
  }
  let layers: Layer[];
  try {
    layers = parseLayers(p.layers, new Set(bitmaps.keys()));
  } catch (e) {
    fail(`${label}: ${(e as Error).message}`);
  }
  const maps = new Map<string, Uint8Array[]>();
  const masks = new Set(layers.flatMap((l) => l.masks.map((m) => m.id)));
  for (const id of mapIds(layers)) {
    maps.set(
      id,
      pages.map((pg, i) => {
        const m = files[`${d}layer.${id}.${i}.u8`];
        if (!m || m.length !== pg.width * pg.height) fail(`${label}'s layer data ${id} (page ${i + 1}) is missing or the wrong size.`);
        const out = m.slice();
        if (masks.has(id)) for (let k = 0; k < out.length; k++) out[k] = out[k] ? 1 : 0;
        else for (let k = 0; k < out.length; k++) if (out[k]! > MAX_SLOTS) out[k] = 0;
        return out;
      }),
    );
  }
  return { layers, maps, bitmaps };
}

/** Every buffer a project holds, for transferring it between threads. */
export function projectBuffers(p: ProjectData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView | undefined) => a && out.add(a.buffer as ArrayBuffer);
  for (const o of p.objects) {
    add(o.mesh.positions);
    add(o.mesh.indices);
    add(o.mesh.faceIds);
    add(o.report.openEdges);
    add(o.report.nonManifoldEdges);
    if (!o.paint) continue;
    const a = o.paint.atlas;
    [a.positions, a.indices, a.uvs, a.xref, a.triSource, a.faceIds, ...o.paint.maps].forEach(add);
    for (const m of o.paint.doc.maps.values()) m.forEach(add);
    for (const b of o.paint.doc.bitmaps.values()) add(b.la);
  }
  return [...out];
}
