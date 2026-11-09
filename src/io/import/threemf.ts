// 3MF reader written from the 3MF core spec (and the production extension's p:path,
// which Bambu Studio uses to put each object in its own 3D/Objects/*.model file).
// Painting attributes are ignored for now. Uses DOMParser, so it runs on the main thread.

import { unzipSync } from 'fflate';
import type { IndexedMesh } from '@/core/mesh';
import { unitFrom3mf, type LengthUnit } from '@/core/units';
import { ImportError, type ImportedPart } from './types';

const REL_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

/** Row-vector affine transform: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32] (3MF order). */
type Transform = number[];
const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(attr: string | null): Transform {
  if (!attr) return IDENTITY;
  const v = attr.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
}

/** Returns the transform that applies `a` first, then `b`. */
function compose(a: Transform, b: Transform): Transform {
  const r = new Array<number>(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
    }
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9]! * b[j]! + a[10]! * b[3 + j]! + a[11]! * b[6 + j]! + b[9 + j]!;
  return r;
}

function determinant(t: Transform): number {
  return (
    t[0]! * (t[4]! * t[8]! - t[5]! * t[7]!) -
    t[1]! * (t[3]! * t[8]! - t[5]! * t[6]!) +
    t[2]! * (t[3]! * t[7]! - t[4]! * t[6]!)
  );
}

interface ObjectDef {
  name: string;
  type: string;
  mesh?: IndexedMesh;
  components: { path: string; id: string; transform: Transform }[];
}

interface ModelFile {
  unit: LengthUnit;
  objects: Map<string, ObjectDef>;
  build: { id: string; transform: Transform; name: string }[];
}

const normPath = (p: string) => p.replace(/^\/+/, '');
const children = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);
const child = (el: Element, name: string) => children(el, name)[0];

/** Reads an attribute by local name, ignoring its namespace prefix (e.g. p:path). */
function attr(el: Element, local: string): string | null {
  // Matching the name suffix as well covers DOM implementations that report "p:path" as the local name.
  for (const a of Array.from(el.attributes)) if (a.localName === local || a.name.endsWith(`:${local}`)) return a.value;
  return null;
}

function parseXml(text: string, path: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new ImportError(`${path} is not valid XML.`);
  return doc;
}

function parseMesh(meshEl: Element): IndexedMesh {
  const vertsEl = child(meshEl, 'vertices');
  const trisEl = child(meshEl, 'triangles');
  const verts = vertsEl ? children(vertsEl, 'vertex') : [];
  const tris = trisEl ? children(trisEl, 'triangle') : [];
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => {
    positions[i * 3] = Number(v.getAttribute('x'));
    positions[i * 3 + 1] = Number(v.getAttribute('y'));
    positions[i * 3 + 2] = Number(v.getAttribute('z'));
  });
  const indices = new Uint32Array(tris.length * 3);
  let n = 0;
  for (const t of tris) {
    const a = Number(t.getAttribute('v1')), b = Number(t.getAttribute('v2')), c = Number(t.getAttribute('v3'));
    if (![a, b, c].every((x) => Number.isInteger(x) && x >= 0 && x < verts.length)) continue;
    indices[n++] = a;
    indices[n++] = b;
    indices[n++] = c;
  }
  return { positions, indices: indices.slice(0, n) };
}

function parseModel(text: string, path: string): ModelFile {
  const doc = parseXml(text, path);
  const root = doc.documentElement;
  if (root.localName !== 'model') throw new ImportError(`${path} has no <model> element.`);
  const objects = new Map<string, ObjectDef>();
  const resources = child(root, 'resources');
  for (const o of resources ? children(resources, 'object') : []) {
    const id = o.getAttribute('id');
    if (!id) continue;
    const meshEl = child(o, 'mesh');
    const compsEl = child(o, 'components');
    objects.set(id, {
      name: o.getAttribute('name') ?? '',
      type: o.getAttribute('type') ?? 'model',
      mesh: meshEl ? parseMesh(meshEl) : undefined,
      components: compsEl
        ? children(compsEl, 'component').map((c) => ({
            path: normPath(attr(c, 'path') ?? path),
            id: c.getAttribute('objectid') ?? '',
            transform: parseTransform(c.getAttribute('transform')),
          }))
        : [],
    });
  }
  const buildEl = child(root, 'build');
  const build = (buildEl ? children(buildEl, 'item') : []).map((it) => ({
    id: it.getAttribute('objectid') ?? '',
    transform: parseTransform(it.getAttribute('transform')),
    name: it.getAttribute('partnumber') ?? '',
  }));
  return { unit: unitFrom3mf(root.getAttribute('unit')), objects, build };
}

export interface ThreeMfResult {
  parts: ImportedPart[];
  unit: LengthUnit;
  warnings: string[];
}

export function read3mf(data: ArrayBuffer | Uint8Array): ThreeMfResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
  } catch {
    throw new ImportError('This 3MF file is not a valid zip archive.');
  }
  const text = (p: string) => {
    const f = files[p];
    return f ? new TextDecoder().decode(f) : null;
  };

  // Root model from the package relationships, falling back to the usual path.
  let rootPath = '3D/3dmodel.model';
  const rels = text('_rels/.rels');
  if (rels) {
    const doc = parseXml(rels, '_rels/.rels');
    for (const r of Array.from(doc.getElementsByTagName('Relationship'))) {
      if (r.getAttribute('Type') === REL_MODEL && r.getAttribute('Target')) {
        rootPath = normPath(r.getAttribute('Target')!);
        break;
      }
    }
  }

  const models = new Map<string, ModelFile>();
  const load = (path: string): ModelFile | null => {
    if (!models.has(path)) {
      const t = text(path);
      if (t === null) return null;
      models.set(path, parseModel(t, path));
    }
    return models.get(path)!;
  };

  const root = load(rootPath);
  if (!root) throw new ImportError(`The 3MF has no model file (${rootPath}).`);
  const warnings: string[] = [];
  const skippedTypes = new Set<string>();

  // Flattens an object (and its components) into world-space triangles.
  const collect = (path: string, id: string, t: Transform, out: { pos: number[]; idx: number[] }, depth: number) => {
    if (depth > 32) throw new ImportError('The 3MF has components nested too deeply (or a cycle).');
    const model = load(path);
    const obj = model?.objects.get(id);
    if (!obj) {
      warnings.push(`Missing object ${id} in ${path}.`);
      return;
    }
    if (obj.type !== 'model' && obj.type !== 'solidsupport') {
      skippedTypes.add(obj.type);
      return;
    }
    if (obj.mesh) {
      const base = out.pos.length / 3;
      const p = obj.mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
        out.pos.push(
          x * t[0]! + y * t[3]! + z * t[6]! + t[9]!,
          x * t[1]! + y * t[4]! + z * t[7]! + t[10]!,
          x * t[2]! + y * t[5]! + z * t[8]! + t[11]!,
        );
      }
      const mirror = determinant(t) < 0;
      const ix = obj.mesh.indices;
      for (let i = 0; i < ix.length; i += 3) {
        if (mirror) out.idx.push(base + ix[i]!, base + ix[i + 2]!, base + ix[i + 1]!);
        else out.idx.push(base + ix[i]!, base + ix[i + 1]!, base + ix[i + 2]!);
      }
    }
    for (const c of obj.components) collect(c.path, c.id, compose(c.transform, t), out, depth + 1);
  };

  const parts: ImportedPart[] = [];
  root.build.forEach((item, n) => {
    const out = { pos: [] as number[], idx: [] as number[] };
    collect(rootPath, item.id, item.transform, out, 0);
    if (!out.idx.length) return;
    const obj = root.objects.get(item.id);
    parts.push({
      name: obj?.name || item.name || `Object ${n + 1}`,
      mesh: { positions: new Float32Array(out.pos), indices: new Uint32Array(out.idx) },
    });
  });

  if (skippedTypes.size) warnings.push(`Skipped objects of type: ${[...skippedTypes].join(', ')}.`);
  if (!parts.length) throw new ImportError('The 3MF contains no printable meshes.');
  return { parts, unit: root.unit, warnings };
}
