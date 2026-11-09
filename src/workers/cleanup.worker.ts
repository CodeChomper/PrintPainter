import { expose, transfer } from 'comlink';
import { cleanupMesh, type CleanupResult } from '@/core/cleanup';

const api = {
  cleanup(positions: Float32Array, indices: Uint32Array): CleanupResult {
    const r = cleanupMesh({ positions, indices });
    return transfer(r, [
      r.mesh.positions.buffer as ArrayBuffer,
      r.mesh.indices.buffer as ArrayBuffer,
      r.report.openEdges.buffer as ArrayBuffer,
      r.report.nonManifoldEdges.buffer as ArrayBuffer,
    ]);
  },
};

export type CleanupApi = typeof api;
expose(api);
