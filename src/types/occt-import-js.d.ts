// Minimal typings for occt-import-js (https://github.com/kovacsv/occt-import-js), LGPL-2.1.
declare module 'occt-import-js' {
  export interface OcctParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }
  export interface OcctBrepFace {
    first: number;
    last: number;
    color: [number, number, number] | null;
  }
  export interface OcctMesh {
    name: string;
    color?: [number, number, number];
    brep_faces: OcctBrepFace[];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }
  export interface OcctNode {
    name: string;
    meshes: number[];
    children: OcctNode[];
  }
  export interface OcctResult {
    success: boolean;
    root: OcctNode;
    meshes: OcctMesh[];
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult;
  }
  const factory: (overrides?: { locateFile?: (path: string) => string }) => Promise<OcctModule>;
  export default factory;
}
