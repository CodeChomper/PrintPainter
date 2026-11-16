import { expose, transfer } from 'comlink';
import type { PaintAtlas } from '@/core/atlas';
import { cutMesh, type CutMesh } from '@/core/export/cut';
import { write3mfBambu, type BambuOptions, type ExportObject } from '@/io/export/3mf/bambu';

const api = {
  /** Cuts one object along its paint boundaries. Inputs are copies; the result is transferred. */
  cut(
    positions: Float32Array,
    indices: Uint32Array,
    atlas: PaintAtlas,
    maps: Uint8Array[],
    smoothMm: number,
    texelMm: number,
    onProgress?: (f: number) => void,
  ): CutMesh {
    let last = 0;
    const c = cutMesh({ positions, indices }, atlas, maps, {
      smoothMm,
      texelMm,
      onProgress: (f) => {
        if (onProgress && (f - last > 0.02 || f === 1)) {
          last = f;
          void onProgress(f);
        }
      },
    });
    return transfer(c, [c.positions.buffer as ArrayBuffer, c.indices.buffer as ArrayBuffer, c.slots.buffer as ArrayBuffer]);
  },

  /** Writes the Bambu/Orca 3MF. */
  write(objects: ExportObject[], opts: BambuOptions): Uint8Array {
    const bytes = write3mfBambu(objects, opts);
    return transfer(bytes, [bytes.buffer as ArrayBuffer]);
  },
};

export type ExportApi = typeof api;
expose(api);
