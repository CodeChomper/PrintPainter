import { Mesh } from 'three';
import { boundsSize, boundsUnion, meshBounds, type Bounds } from '@/core/mesh';
import { guessUnitFromExtent, type UnitGuess } from '@/core/units';
import { partsFromObject3D } from './fromThree';
import { read3mf } from './threemf';
import { ImportError, type ImportFormat, type ImportResult, type ImportedPart } from './types';

export { ImportError } from './types';
export type { ImportResult, ImportedPart, ImportFormat } from './types';

const EXT_FORMAT: Record<string, ImportFormat> = {
  stl: 'stl',
  obj: 'obj',
  '3mf': '3mf',
  gltf: 'gltf',
  glb: 'gltf',
  ply: 'ply',
  fbx: 'fbx',
  step: 'step',
  stp: 'step',
};

export const IMPORT_EXTENSIONS = Object.keys(EXT_FORMAT);

export function formatFromName(name: string): ImportFormat | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_FORMAT[ext] ?? null;
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

/** Parses a model file into parts (file units) plus a unit decision. Loaders are loaded on demand. */
export async function importFile(file: File): Promise<ImportResult> {
  const format = formatFromName(file.name);
  if (!format) throw new ImportError(`${file.name}: unsupported file type.`);
  const name = baseName(file.name);
  const warnings: string[] = [];
  let parts: ImportedPart[];
  let unit: UnitGuess | null = null;

  switch (format) {
    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      const geom = new STLLoader().parse(await file.arrayBuffer());
      parts = partsFromObject3D(new Mesh(geom), name);
      unit = { unit: 'mm', certain: true, reason: 'STL files are millimetres by convention.' };
      break;
    }
    case 'obj': {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      parts = partsFromObject3D(new OBJLoader().parse(await file.text()), name);
      break;
    }
    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      const geom = new PLYLoader().parse(await file.arrayBuffer());
      // PLYLoader only produces an index when the file has faces.
      if (!geom.getIndex()) {
        throw new ImportError(`${file.name} has no faces (it may be a point cloud).`);
      }
      parts = partsFromObject3D(new Mesh(geom), name);
      break;
    }
    case 'gltf': {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const buf = await file.arrayBuffer();
      try {
        const gltf = await new GLTFLoader().parseAsync(file.name.toLowerCase().endsWith('.gltf') ? new TextDecoder().decode(buf) : buf, '');
        parts = partsFromObject3D(gltf.scene, name);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (/draco|meshopt/i.test(msg)) {
          throw new ImportError(`${file.name} uses mesh compression (Draco/Meshopt), which isn't supported yet. Re-export it without compression.`);
        }
        throw new ImportError(`${file.name}: ${msg || 'could not read glTF'}. Separate .gltf files with external .bin/.png files aren't supported yet; use .glb.`);
      }
      unit = { unit: 'm', certain: true, reason: 'glTF files are metres by specification.' };
      break;
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      parts = partsFromObject3D(new FBXLoader().parse(await file.arrayBuffer(), ''), name);
      warnings.push('FBX support is best-effort.');
      break;
    }
    case '3mf': {
      const r = read3mf(await file.arrayBuffer());
      parts = r.parts;
      // A lone object without a name in the file takes the file's name.
      if (parts.length === 1 && /^Object \d+$/.test(parts[0]!.name)) parts[0]!.name = name;
      warnings.push(...r.warnings);
      unit = { unit: r.unit, certain: true, reason: 'The 3MF file states its unit.' };
      break;
    }
    case 'step':
      throw new ImportError('STEP import is coming in the next step of M1.');
  }

  if (!parts.length) throw new ImportError(`${file.name} contains no triangle meshes.`);
  if (!unit) {
    const b = parts.map((p) => meshBounds(p.mesh)).reduce<Bounds>((a, x) => boundsUnion(a, x), meshBounds(parts[0]!.mesh));
    unit = guessUnitFromExtent(Math.max(...boundsSize(b)));
  }
  return { fileName: file.name, format, parts, unit, warnings };
}
