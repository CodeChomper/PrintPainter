// Tessellates STEP files with occt-import-js (OpenCascade compiled to WASM, LGPL-2.1).
// Single-threaded build, so it works without cross-origin isolation (GitHub Pages).
import { expose, transfer } from 'comlink';
import occtimportjs, { type OcctModule } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { occtParams, partsFromOcct, type StepQuality } from '@/io/import/step';
import type { ImportedPart } from '@/io/import/types';

let occt: Promise<OcctModule> | null = null;

const api = {
  async readStep(bytes: Uint8Array, quality: StepQuality, name: string): Promise<ImportedPart[]> {
    occt ??= occtimportjs({ locateFile: () => wasmUrl });
    const m = await occt;
    const result = m.ReadStepFile(bytes, occtParams(quality));
    if (!result.success) throw new Error('OpenCascade could not read this STEP file.');
    const parts = partsFromOcct(result, name);
    const buffers = parts.flatMap((p) => [
      p.mesh.positions.buffer as ArrayBuffer,
      p.mesh.indices.buffer as ArrayBuffer,
      ...(p.mesh.faceIds ? [p.mesh.faceIds.buffer as ArrayBuffer] : []),
    ]);
    return transfer(parts, buffers);
  },
};

export type OcctApi = typeof api;
expose(api);
