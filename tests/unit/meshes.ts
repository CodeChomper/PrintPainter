// Small procedural meshes for tests. All outward-wound (CCW seen from outside).
import type { IndexedMesh } from '@/core/mesh';

export function box(sx: number, sy = sx, sz = sx): IndexedMesh {
  const C = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const tris = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return {
    positions: new Float32Array(C.flatMap(([x, y, z]) => [x! * sx, y! * sy, z! * sz])),
    indices: new Uint32Array(tris),
  };
}

/** Flat w × h rectangle at z = 0 facing +Z, split into n × n quads. */
export function plane(w: number, h: number, n = 1): IndexedMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push((i / n) * w, (j / n) * h, 0);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export function uvSphere(r: number, seg = 32, rings = 16): IndexedMesh {
  const pos: number[] = [0, 0, -r];
  for (let j = 1; j < rings; j++) {
    const phi = -Math.PI / 2 + (j / rings) * Math.PI;
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      pos.push(r * Math.cos(phi) * Math.cos(th), r * Math.cos(phi) * Math.sin(th), r * Math.sin(phi));
    }
  }
  pos.push(0, 0, r);
  const top = pos.length / 3 - 1;
  const ring = (j: number, i: number) => 1 + (j - 1) * seg + (i % seg);
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) idx.push(0, ring(1, i + 1), ring(1, i));
  for (let j = 1; j < rings - 1; j++) {
    for (let i = 0; i < seg; i++) {
      idx.push(ring(j, i), ring(j, i + 1), ring(j + 1, i + 1), ring(j, i), ring(j + 1, i + 1), ring(j + 1, i));
    }
  }
  for (let i = 0; i < seg; i++) idx.push(top, ring(rings - 1, i), ring(rings - 1, i + 1));
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/**
 * Upward-facing spiral ramp (helicoid strip), `turns` turns. Its normals stay close
 * to +Z, but seen from above it covers the same ring more than once.
 */
export function spiralRamp(turns = 2, inner = 5, outer = 10, risePerTurn = 3, steps = 96): IndexedMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = Math.round(steps * turns);
  for (let s = 0; s <= n; s++) {
    const th = (s / steps) * Math.PI * 2;
    const z = (s / steps) * risePerTurn;
    pos.push(inner * Math.cos(th), inner * Math.sin(th), z, outer * Math.cos(th), outer * Math.sin(th), z);
  }
  for (let s = 0; s < n; s++) {
    const a = s * 2, b = a + 1, c = a + 3, d = a + 2;
    // CCW seen from above.
    idx.push(a, b, c, a, c, d);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
