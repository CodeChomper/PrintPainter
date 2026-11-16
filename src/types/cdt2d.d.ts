declare module 'cdt2d' {
  /** Constrained Delaunay triangulation (mikolalysenko/cdt2d). Returns triangles as point index triples. */
  export default function cdt2d(
    points: [number, number][],
    edges?: [number, number][],
    options?: { delaunay?: boolean; interior?: boolean; exterior?: boolean; infinity?: boolean },
  ): [number, number, number][];
}
