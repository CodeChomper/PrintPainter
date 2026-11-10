import { releaseProxy, transfer, wrap, type Remote } from 'comlink';
import type { OcctApi } from '@/workers/occt.worker';
import type { StepQuality } from './step';
import type { ImportedPart } from './types';

let worker: Worker | null = null;
let api: Remote<OcctApi> | null = null;

/** Tessellates a STEP file in the occt worker. The WASM (~7.6 MB) loads on first use. */
export function readStepInWorker(bytes: Uint8Array, quality: StepQuality, name: string): Promise<ImportedPart[]> {
  if (!api) {
    worker = new Worker(new URL('../../workers/occt.worker.ts', import.meta.url), { type: 'module' });
    api = wrap<OcctApi>(worker);
  }
  return api.readStep(transfer(bytes, [bytes.buffer as ArrayBuffer]), quality, name);
}

/** WASM memory never shrinks, so drop the worker once a batch of imports is done. */
export function releaseStepWorker(): void {
  api?.[releaseProxy]();
  worker?.terminate();
  api = null;
  worker = null;
}
