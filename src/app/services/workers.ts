import { proxy, transfer, wrap, type Remote } from 'comlink';
import type { PaintAtlas } from '@/core/atlas';
import type { CleanupResult } from '@/core/cleanup';
import type { IndexedMesh } from '@/core/mesh';
import type { AtlasApi } from '@/workers/atlas.worker';
import type { CleanupApi } from '@/workers/cleanup.worker';
import type { CutMesh } from '@/core/export/cut';
import type { BambuOptions, ExportObject } from '@/io/export/3mf/bambu';
import type { ExportApi } from '@/workers/export.worker';
import type { ProjectApi } from '@/workers/project.worker';

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

let exportWorker: { raw: Worker; api: Remote<ExportApi> } | null = null;

function exporter() {
  if (!exportWorker) {
    const raw = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), { type: 'module' });
    exportWorker = { raw, api: wrap<ExportApi>(raw) };
  }
  return exportWorker.api;
}

/** Stops whatever the export worker is doing (the next call starts a fresh one). */
export function cancelExportWork(): void {
  exportWorker?.raw.terminate();
  exportWorker = null;
}

/** Cuts a painted object for export, in a worker. Inputs are copied. */
export function cutInWorker(
  mesh: IndexedMesh,
  atlas: PaintAtlas,
  maps: Uint8Array[],
  smoothMm: number,
  texelMm: number,
  onProgress: (f: number) => void,
): Promise<CutMesh> {
  return exporter().cut(mesh.positions, mesh.indices, atlas, maps, smoothMm, texelMm, proxy(onProgress));
}

/** Writes the Bambu/Orca 3MF in a worker. The object arrays are transferred. */
export function write3mfInWorker(objects: ExportObject[], opts: BambuOptions): Promise<Uint8Array> {
  const buffers = objects.flatMap((o) => [o.positions.buffer, o.indices.buffer, o.slots.buffer] as ArrayBuffer[]);
  return exporter().write(transfer(objects, buffers), opts);
}

let projectWorker: Remote<ProjectApi> | null = null;

/** Zips projects and reads/writes the OPFS autosave. Calls run one at a time, in order. */
export function projectIo(): Remote<ProjectApi> {
  projectWorker ??= wrap<ProjectApi>(
    new Worker(new URL('../../workers/project.worker.ts', import.meta.url), { type: 'module' }),
  );
  return projectWorker;
}
