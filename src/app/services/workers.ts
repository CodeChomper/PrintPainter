import { transfer, wrap, type Remote } from 'comlink';
import type { PaintAtlas } from '@/core/atlas';
import type { CleanupResult } from '@/core/cleanup';
import type { IndexedMesh } from '@/core/mesh';
import type { AtlasApi } from '@/workers/atlas.worker';
import type { CleanupApi } from '@/workers/cleanup.worker';

let cleanupWorker: Remote<CleanupApi> | null = null;
let atlasWorker: Remote<AtlasApi> | null = null;

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

/**
 * Builds a paint atlas in a worker. The mesh is copied, not transferred: the scene
 * keeps it. Calls run one at a time, in order.
 */
export function atlasInWorker(mesh: IndexedMesh, texelSize: number, maxPageSize: number): Promise<PaintAtlas> {
  atlasWorker ??= wrap<AtlasApi>(
    new Worker(new URL('../../workers/atlas.worker.ts', import.meta.url), { type: 'module' }),
  );
  return atlasWorker.build(mesh.positions, mesh.indices, mesh.faceIds, texelSize, maxPageSize);
}
