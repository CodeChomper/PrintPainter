import { expose, transfer } from 'comlink';
import { buildAtlas, type PaintAtlas } from '@/core/atlas';

const api = {
  /** Builds the paint atlas. Inputs are copies (the main thread keeps its mesh); the result is transferred. */
  build(
    positions: Float32Array,
    indices: Uint32Array,
    faceIds: Int32Array | undefined,
    texelSize: number,
    maxPageSize: number,
  ): PaintAtlas {
    const a = buildAtlas({ positions, indices, faceIds }, { texelSize, maxPageSize });
    return transfer(a, [
      a.positions.buffer as ArrayBuffer,
      a.indices.buffer as ArrayBuffer,
      a.uvs.buffer as ArrayBuffer,
      a.xref.buffer as ArrayBuffer,
      a.triSource.buffer as ArrayBuffer,
      ...(a.faceIds ? [a.faceIds.buffer as ArrayBuffer] : []),
    ]);
  },
};

export type AtlasApi = typeof api;
expose(api);
