import { transfer, wrap, type Remote } from 'comlink';
import type { CleanupResult } from '@/core/cleanup';
import type { IndexedMesh } from '@/core/mesh';
import type { CleanupApi } from '@/workers/cleanup.worker';

let cleanupWorker: Remote<CleanupApi> | null = null;

/** Runs import cleanup in a worker. The input buffers are transferred (unusable afterwards). */
export function cleanupInWorker(mesh: IndexedMesh): Promise<CleanupResult> {
  cleanupWorker ??= wrap<CleanupApi>(
    new Worker(new URL('../../workers/cleanup.worker.ts', import.meta.url), { type: 'module' }),
  );
  return cleanupWorker.cleanup(
    transfer(mesh.positions, [mesh.positions.buffer as ArrayBuffer]),
    transfer(mesh.indices, [mesh.indices.buffer as ArrayBuffer]),
    mesh.faceIds && transfer(mesh.faceIds, [mesh.faceIds.buffer as ArrayBuffer]),
  );
}
