// Paint input on the viewport: brush and eraser strokes, straight lines, bucket fills
// and lasso fills, with X/Y/Z mirror symmetry. Each finished action is reported as
// undo edits. Shift erases with any tool.

import { Matrix4, Vector3, type Mesh } from 'three';
import type { PaintAtlas } from '@/core/atlas';
import { buildTopology, fillTriangles, growRegion, paintWhere, type FillMode, type FillTopology } from '@/core/fill';
import { paintDab, PaintRecorder, type Dab, type Rect, type TileEdit, type Vec3 } from '@/core/paint';
import type { DepthView } from './depth';
import type { PaintBinding, PaintHit, Viewport } from './Viewport';

export type PaintMode = 'brush' | 'eraser' | 'fill' | 'line' | 'lasso' | null;

export interface PaintSettings {
  mode: PaintMode;
  /** Brush radius in mm (brush, eraser, line). */
  radius: number;
  /** Slot painted (1..16). */
  slot: number;
  /** Mirror across the object's centre on X, Y, Z. */
  symmetry: [boolean, boolean, boolean];
  /** #rrggbb of the slot, for the brush outline and fill preview. */
  slotColor: string;
  fillMode: FillMode;
  /** Angle fill: largest bend between neighbouring triangles, degrees. */
  fillAngle: number;
  /** Lasso: also paint back faces and hidden surfaces. */
  lassoThrough: boolean;
}

/** The maps an action writes into on one object (a layer's, or a painted mask's). */
export interface PaintTarget {
  /** Map id (layer or mask). */
  id: string;
  maps: Uint8Array[];
  /** A mask: paint writes 1 instead of the slot. */
  mask: boolean;
}

export interface StrokeEdit {
  /** Object id. */
  id: string;
  edit: TileEdit;
  /** Map id the edit applies to, and those maps. */
  target: string;
  maps: Uint8Array[];
}

interface Painting {
  rec: PaintRecorder;
  target: PaintTarget;
}

interface Stroke {
  kind: 'brush' | 'line' | 'lasso';
  erase: boolean;
  depth: DepthView;
  /** Per object; null when that object can't be painted (already reported). */
  recorders: Map<string, Painting | null>;
  /** Brush: last dab position. Line: start. */
  last: { x: number; y: number };
  /** Lasso outline (client coordinates). */
  points: { x: number; y: number }[];
  pointerId: number;
}

interface Topo {
  topo: FillTopology;
  /** growRegion scratch; after a call it marks that region's triangles. */
  seen: Uint8Array;
}

/** Dab spacing as a fraction of the brush radius. */
const SPACING = 0.3;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Mirror images of a point around centre c, one per enabled symmetry combination (identity first). */
function mirrors(sym: readonly boolean[]): (readonly [number, number, number])[] {
  const out: (readonly [number, number, number])[] = [];
  for (let m = 0; m < 8; m++) {
    if ((m & 1 && !sym[0]) || (m & 2 && !sym[1]) || (m & 4 && !sym[2])) continue;
    out.push([m & 1 ? -1 : 1, m & 2 ? -1 : 1, m & 4 ? -1 : 1]);
  }
  return out;
}

export class PaintTool {
  settings: PaintSettings = {
    mode: null,
    radius: 2,
    slot: 2,
    symmetry: [false, false, false],
    slotColor: '#ffffff',
    fillMode: 'angle',
    fillAngle: 30,
    lassoThrough: false,
  };
  /** An action finished and changed something. `erased` when it removed paint. */
  onStrokeEnd: ((edits: StrokeEdit[], erased: boolean) => void) | null = null;
  /** The user tried to paint an object whose paint surface isn't ready yet, or that has nothing to paint on (`reason`). */
  onBlocked: ((id: string, reason?: string) => void) | null = null;
  /** Where painting on an object writes. Without it, the viewport's slot maps. */
  targetFor: ((id: string) => PaintTarget | string) | null = null;
  /** Maps of a target changed (rectangles per page). Without it, the viewport is told directly. */
  onPainted: ((id: string, target: string, dirty: (Rect | null)[]) => void) | null = null;

  private stroke: Stroke | null = null;
  private candidates = new Uint32Array(1024);
  private shiftDown = false;
  private disposers: (() => void)[] = [];
  private topos = new WeakMap<PaintAtlas, Topo>();
  /** The fill region shown under the cursor. */
  private hovered: { id: string; atlas: PaintAtlas; key: string; erase: boolean; tris: Uint32Array } | null = null;
  private overlay: SVGSVGElement;
  private overlayPath: SVGPathElement;

  constructor(private vp: Viewport) {
    const el = vp.renderer.domElement;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    // Capture phase on the canvas runs before OrbitControls' own listener, so a stroke
    // that starts on a paintable surface never also rotates the view.
    on(el, 'pointerdown', (e) => this.onDown(e), { capture: true });
    on(el, 'pointermove', (e) => this.onMove(e));
    on(el, 'pointerup', (e) => this.onUp(e));
    on(el, 'pointercancel', (e) => this.onUp(e));
    on(el, 'pointerleave', () => {
      if (!this.stroke) this.clearHover();
    });
    const onShift = (e: KeyboardEvent) => {
      if (this.shiftDown === e.shiftKey) return;
      this.shiftDown = e.shiftKey;
      const h = this.hovered;
      if (h && this.settings.mode === 'fill' && !this.stroke) {
        h.erase = e.shiftKey;
        this.vp.setHighlight(h.id, h.tris, h.erase ? '#ffffff' : this.settings.slotColor);
      }
    };
    on(window, 'keydown', onShift);
    on(window, 'keyup', onShift);

    // Line and lasso outlines are drawn over the canvas.
    this.overlay = document.createElementNS(SVG_NS, 'svg');
    this.overlay.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible');
    this.overlayPath = document.createElementNS(SVG_NS, 'path');
    this.overlayPath.setAttribute('fill', 'none');
    this.overlayPath.setAttribute('stroke-width', '1.5');
    this.overlayPath.setAttribute('stroke-dasharray', '5 4');
    this.overlay.appendChild(this.overlayPath);
    el.parentElement?.appendChild(this.overlay);
  }

  /** Applies new settings and refreshes the cursor. */
  update(settings: Partial<PaintSettings>): void {
    Object.assign(this.settings, settings);
    const el = this.vp.renderer.domElement;
    if (this.settings.mode !== 'fill') this.clearHover();
    else if (this.hovered) this.hovered.key = ''; // settings changed: recompute on the next move
    if (!this.settings.mode) {
      this.vp.hideBrushRing();
      el.style.cursor = '';
    } else if (this.settings.mode === 'lasso' || this.settings.mode === 'fill') {
      this.vp.hideBrushRing();
      el.style.cursor = 'crosshair';
    }
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.vp.hideBrushRing();
    this.vp.setHighlight(null);
    this.overlay.remove();
  }

  private ringColor(erase: boolean): string {
    return erase ? '#ffffff' : this.settings.slotColor;
  }

  private onDown(e: PointerEvent): void {
    const mode = this.settings.mode;
    if (!mode || e.button !== 0 || e.altKey || this.stroke) return;
    const erase = mode === 'eraser' || e.shiftKey;
    if (mode === 'lasso') {
      // A lasso can start anywhere (around the model); Alt+drag or the other buttons move the view.
      e.stopImmediatePropagation();
      e.preventDefault();
      this.begin(e, 'lasso', erase);
      return;
    }
    const hit = this.vp.paintHit(e.clientX, e.clientY, true);
    if (!hit) return; // empty space: let the view rotate (Bambu preset)
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!hit.ready) {
      this.onBlocked?.(hit.id);
      return;
    }
    if (mode === 'fill') {
      this.fillAt(hit, erase);
      return;
    }
    this.begin(e, mode === 'line' ? 'line' : 'brush', erase);
    if (mode !== 'line') {
      this.dabAt(e.clientX, e.clientY);
      this.flush();
    }
  }

  private begin(e: PointerEvent, kind: Stroke['kind'], erase: boolean): void {
    try {
      this.vp.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone (or synthetic): the stroke still works inside the canvas */
    }
    this.stroke = {
      kind,
      erase,
      depth: this.vp.captureDepth(),
      recorders: new Map(),
      last: { x: e.clientX, y: e.clientY },
      points: [{ x: e.clientX, y: e.clientY }],
      pointerId: e.pointerId,
    };
    if (kind !== 'brush') this.overlayPath.setAttribute('stroke', erase ? '#ffffff' : this.settings.slotColor);
  }

  private onMove(e: PointerEvent): void {
    const s = this.stroke;
    if (!s) {
      this.hover(e);
      return;
    }
    if (e.pointerId !== s.pointerId) return;
    if (s.kind === 'line') {
      const hit = this.vp.paintHit(e.clientX, e.clientY);
      if (hit) this.vp.showBrushRing(hit.point, this.settings.radius, this.ringColor(s.erase));
      else this.vp.hideBrushRing();
      this.drawOverlay([s.last, { x: e.clientX, y: e.clientY }], false);
      return;
    }
    if (s.kind === 'lasso') {
      const p = s.points[s.points.length - 1]!;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 2) s.points.push({ x: e.clientX, y: e.clientY });
      this.drawOverlay(s.points, true);
      return;
    }
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) this.strokeTo(ev.clientX, ev.clientY);
    this.flush();
  }

  private drawOverlay(points: { x: number; y: number }[], closed: boolean): void {
    const r = this.overlay.getBoundingClientRect();
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${(p.x - r.left).toFixed(1)},${(p.y - r.top).toFixed(1)}`).join('');
    this.overlayPath.setAttribute('d', points.length ? d + (closed ? 'Z' : '') : '');
  }

  private hover(e: PointerEvent): void {
    const mode = this.settings.mode;
    if (!mode || e.buttons || mode === 'lasso') return;
    const hit = this.vp.paintHit(e.clientX, e.clientY);
    const el = this.vp.renderer.domElement;
    const erase = mode === 'eraser' || e.shiftKey || this.shiftDown;
    if (mode === 'fill') {
      this.hoverFill(hit, erase);
      return;
    }
    if (!hit) {
      this.vp.hideBrushRing();
      el.style.cursor = '';
      return;
    }
    el.style.cursor = 'none';
    this.vp.showBrushRing(hit.point, this.settings.radius, this.ringColor(erase));
  }

  private clearHover(): void {
    this.vp.hideBrushRing();
    this.hovered = null;
    this.vp.setHighlight(null);
  }

  // ---- fill ----------------------------------------------------------------------

  private topology(b: PaintBinding): Topo {
    let t = this.topos.get(b.atlas);
    if (!t) {
      t = { topo: buildTopology(b.atlas), seen: new Uint8Array(b.atlas.indices.length / 3) };
      this.topos.set(b.atlas, t);
    }
    return t;
  }

  private fillKey(): string {
    const s = this.settings;
    return `${s.fillMode}|${s.fillMode === 'angle' ? s.fillAngle : ''}`;
  }

  private region(b: PaintBinding, tri: number): Uint32Array {
    const t = this.topology(b);
    return growRegion(b.atlas, t.topo, tri, { mode: this.settings.fillMode, maxAngleDeg: this.settings.fillAngle }, t.seen);
  }

  /** Shows the region a click would fill. */
  private hoverFill(hit: PaintHit | null, erase: boolean): void {
    const b = hit && hit.tri >= 0 ? this.vp.paintBinding(hit.id) : null;
    if (!hit || !b) {
      if (this.hovered) this.clearHover();
      return;
    }
    const key = this.fillKey();
    const h = this.hovered;
    // Still inside the region on show, with the same settings: nothing to do.
    if (h && h.id === hit.id && h.atlas === b.atlas && h.key === key && h.erase === erase && this.topology(b).seen[hit.tri]) return;
    const tris = this.region(b, hit.tri);
    this.hovered = { id: hit.id, atlas: b.atlas, key, erase, tris };
    this.vp.setHighlight(hit.id, tris, erase ? '#ffffff' : this.settings.slotColor);
  }

  /** The target for an object, reporting why not when there is none. */
  private target(id: string, b: PaintBinding): PaintTarget | null {
    const t = this.targetFor ? this.targetFor(id) : { id: '', maps: b.maps, mask: false };
    if (typeof t === 'string') {
      this.onBlocked?.(id, t);
      return null;
    }
    return t;
  }

  private value(t: PaintTarget, erase: boolean): number {
    return erase ? 0 : t.mask ? 1 : this.settings.slot;
  }

  private painted(id: string, target: string, dirty: (Rect | null)[]): void {
    if (this.onPainted) this.onPainted(id, target, dirty);
    else this.vp.uploadPaint(id, dirty);
  }

  private fillAt(hit: PaintHit, erase: boolean): void {
    const b = this.vp.paintBinding(hit.id);
    const mesh = this.vp.objectMesh(hit.id);
    if (!b || !mesh || hit.tri < 0) return;
    const target = this.target(hit.id, b);
    if (!target) return;
    const rec = new PaintRecorder(b.atlas, target.maps);
    const value = this.value(target, erase);
    const local = this.toLocal(mesh, hit.point);
    const c = this.centre(mesh);
    const done = new Uint8Array(b.atlas.indices.length / 3);
    for (const f of mirrors(this.settings.symmetry)) {
      let seed = hit.tri;
      if (f.some((v) => v < 0)) {
        const p = new Vector3(...([0, 1, 2].map((k) => (f[k]! < 0 ? 2 * c[k]! - local[k]! : local[k]!)) as Vec3));
        seed = b.bvh.closestPointToPoint(p)?.faceIndex ?? -1;
      }
      if (seed < 0 || done[seed]) continue; // a mirror landing in a region already filled
      const tris = this.region(b, seed);
      for (const t of tris) done[t] = 1;
      fillTriangles(b.atlas, target.maps, b.pageOf, rec, tris, value);
    }
    // The scratch region was overwritten: recompute the preview on the next move.
    if (this.hovered) this.hovered.key = '';
    this.painted(hit.id, target.id, rec.takeDirty());
    const edit = rec.finish();
    if (edit) this.onStrokeEnd?.([{ id: hit.id, edit, target: target.id, maps: target.maps }], erase);
  }

  // ---- brush and line --------------------------------------------------------------

  /** Dabs along the screen segment from the last position, spaced by a fraction of the radius. */
  private strokeTo(x: number, y: number): void {
    const s = this.stroke!;
    const dx = x - s.last.x, dy = y - s.last.y;
    const dist = Math.hypot(dx, dy);
    const hit = this.vp.paintHit(x, y);
    const radiusPx = hit ? this.settings.radius / this.vp.pixelSizeAt(hit.point) : 8;
    const step = Math.max(1, radiusPx * SPACING);
    if (dist < step) {
      if (hit) this.vp.showBrushRing(hit.point, this.settings.radius, this.ringColor(s.erase));
      return;
    }
    const n = Math.ceil(dist / step);
    for (let i = 1; i <= n; i++) this.dabAt(s.last.x + (dx * i) / n, s.last.y + (dy * i) / n);
    s.last = { x, y };
  }

  private toLocal(mesh: Mesh, world: Vector3): Vec3 {
    const scale = mesh.scale.x, off = mesh.position;
    return [(world.x - off.x) / scale, (world.y - off.y) / scale, (world.z - off.z) / scale];
  }

  private centre(mesh: Mesh): Vec3 {
    const box = mesh.geometry.boundingBox!;
    return [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
  }

  private recorder(s: Stroke, id: string, b: PaintBinding): Painting | null {
    if (s.recorders.has(id)) return s.recorders.get(id)!;
    const target = this.target(id, b);
    const p = target && { rec: new PaintRecorder(b.atlas, target.maps), target };
    s.recorders.set(id, p);
    return p;
  }

  private dabAt(x: number, y: number): void {
    const s = this.stroke!;
    const hit = this.vp.paintHit(x, y);
    if (!hit) return;
    this.vp.showBrushRing(hit.point, this.settings.radius, this.ringColor(s.erase));
    const binding = this.vp.paintBinding(hit.id);
    const mesh = this.vp.objectMesh(hit.id);
    if (!binding || !mesh) return;
    const pr = this.recorder(s, hit.id, binding);
    if (!pr) return;
    const { rec, target } = pr;

    // Work in the object's source units: world = local × scale + offset.
    const scale = mesh.scale.x;
    const off = mesh.position;
    const dir = new Vector3().subVectors(hit.point, this.vp.camera.position).normalize();
    const origin = this.toLocal(mesh, this.vp.camera.position);
    const d: Vec3 = [dir.x, dir.y, dir.z];
    const radius = this.settings.radius / scale;
    const depth = s.depth;
    const visible = (px: number, py: number, pz: number) =>
      depth.visible(px * scale + off.x, py * scale + off.y, pz * scale + off.z);

    const c = this.centre(mesh);
    const value = this.value(target, s.erase);
    for (const flip of mirrors(this.settings.symmetry)) {
      const mirrored = flip.some((v) => v < 0);
      const mirror = (v: Vec3): Vec3 => [0, 1, 2].map((k) => (flip[k]! < 0 ? 2 * c[k]! - v[k]! : v[k]!)) as Vec3;
      const dab: Dab = {
        origin: mirror(origin),
        dir: [d[0] * flip[0], d[1] * flip[1], d[2] * flip[2]],
        radius,
        value,
        // A mirrored texel is visible if its mirror image (on the side being looked at) is.
        visible: mirrored
          ? (px, py, pz) =>
              visible(flip[0] < 0 ? 2 * c[0] - px : px, flip[1] < 0 ? 2 * c[1] - py : py, flip[2] < 0 ? 2 * c[2] - pz : pz)
          : visible,
      };
      const n = this.gather(binding, dab);
      paintDab(binding.atlas, target.maps, binding.pageOf, rec, dab, this.candidates, n);
    }
  }

  /** Triangles whose bounds come within the brush radius of the brush axis. */
  private gather(binding: PaintBinding, dab: Dab): number {
    const [ox, oy, oz] = dab.origin;
    const [dx, dy, dz] = dab.dir;
    const r = dab.radius;
    let n = 0;
    const bvh = binding.bvh;
    bvh.shapecast({
      intersectsBounds: (box) => {
        const cx = (box.min.x + box.max.x) / 2 - ox, cy = (box.min.y + box.max.y) / 2 - oy, cz = (box.min.z + box.max.z) / 2 - oz;
        const half = box.max.distanceTo(box.min) / 2;
        const along = cx * dx + cy * dy + cz * dz;
        if (along < -half) return false; // behind the camera
        const perp2 = cx * cx + cy * cy + cz * cz - along * along;
        return perp2 <= (r + half) * (r + half);
      },
      intersectsRange: (offset, count) => {
        this.reserve(n + count);
        for (let i = offset; i < offset + count; i++) this.candidates[n++] = bvh.resolveTriangleIndex(i);
        return false;
      },
    });
    return n;
  }

  private reserve(size: number): void {
    if (size <= this.candidates.length) return;
    const bigger = new Uint32Array(Math.max(this.candidates.length * 2, size));
    bigger.set(this.candidates);
    this.candidates = bigger;
  }

  // ---- lasso ---------------------------------------------------------------------

  /** Paints what lies inside the lasso outline on every visible object. */
  private applyLasso(s: Stroke): void {
    const pts = s.points;
    if (pts.length < 3) return;
    const el = this.vp.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
    // Rasterize the outline once; each texel then needs one lookup.
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x - rect.left, p.y - rect.top) : ctx.moveTo(p.x - rect.left, p.y - rect.top)));
    ctx.closePath();
    ctx.fill('nonzero');
    const rgba = ctx.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3]! >= 128 ? 1 : 0;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of pts) {
      bx0 = Math.min(bx0, p.x - rect.left);
      bx1 = Math.max(bx1, p.x - rect.left);
      by0 = Math.min(by0, p.y - rect.top);
      by1 = Math.max(by1, p.y - rect.top);
    }

    this.vp.camera.updateMatrixWorld();
    const vpm = new Matrix4().multiplyMatrices(this.vp.camera.projectionMatrix, this.vp.camera.matrixWorldInverse).elements;
    const through = this.settings.lassoThrough;
    const depth = s.depth;

    for (const id of this.vp.paintableIds()) {
      const b = this.vp.paintBinding(id)!;
      const mesh = this.vp.objectMesh(id)!;
      const scale = mesh.scale.x, off = mesh.position;
      // Local point → canvas pixel (NaN when behind the camera).
      const m = new Float64Array(16);
      for (let k = 0; k < 16; k++) m[k] = vpm[k]!;
      const project = (x: number, y: number, z: number, out: Float64Array) => {
        const wx = x * scale + off.x, wy = y * scale + off.y, wz = z * scale + off.z;
        const cw = m[3]! * wx + m[7]! * wy + m[11]! * wz + m[15]!;
        if (cw <= 1e-9) {
          out[0] = NaN;
          return;
        }
        out[0] = ((m[0]! * wx + m[4]! * wy + m[8]! * wz + m[12]!) / cw * 0.5 + 0.5) * W;
        out[1] = (0.5 - (m[1]! * wx + m[5]! * wy + m[9]! * wz + m[13]!) / cw * 0.5) * H;
      };
      const q = new Float64Array(2);
      const keepAt = (x: number, y: number, z: number): boolean => {
        project(x, y, z, q);
        const px = q[0]!, py = q[1]!;
        if (!(px >= 0 && py >= 0 && px < W && py < H) || !mask[(py | 0) * W + (px | 0)]) return false;
        return through || depth.visible(x * scale + off.x, y * scale + off.y, z * scale + off.z);
      };
      const c = this.centre(mesh);
      const eye = this.toLocal(mesh, this.vp.camera.position);
      const P = b.atlas.positions, I = b.atlas.indices;
      const V = P.length / 3, T = I.length / 3;
      const sx = new Float64Array(V), sy = new Float64Array(V);
      let pr: Painting | null | undefined;

      for (const flip of mirrors(this.settings.symmetry)) {
        const mx = (v: number, k: number) => (flip[k]! < 0 ? 2 * c[k]! - v : v);
        // Screen position of each vertex's mirror image.
        for (let v = 0; v < V; v++) {
          project(mx(P[v * 3]!, 0), mx(P[v * 3 + 1]!, 1), mx(P[v * 3 + 2]!, 2), q);
          sx[v] = q[0]!;
          sy[v] = q[1]!;
        }
        let n = 0;
        for (let t = 0; t < T; t++) {
          const a = I[t * 3]!, bb = I[t * 3 + 1]!, cc = I[t * 3 + 2]!;
          const xa = sx[a]!, xb = sx[bb]!, xc = sx[cc]!;
          // Behind the camera (NaN): keep it, the per-texel test decides.
          if (xa === xa && xb === xb && xc === xc) {
            if (Math.max(xa, xb, xc) < bx0 - 1 || Math.min(xa, xb, xc) > bx1 + 1) continue;
            const ya = sy[a]!, yb = sy[bb]!, yc = sy[cc]!;
            if (Math.max(ya, yb, yc) < by0 - 1 || Math.min(ya, yb, yc) > by1 + 1) continue;
          }
          this.reserve(n + 1);
          this.candidates[n++] = t;
        }
        if (!n) continue;
        if (pr === undefined) pr = this.recorder(s, id, b);
        if (!pr) break;
        const value = this.value(pr.target, s.erase);
        const mirrored = flip.some((v) => v < 0);
        const keep = mirrored ? (x: number, y: number, z: number) => keepAt(mx(x, 0), mx(y, 1), mx(z, 2)) : keepAt;
        const eyeM: [number, number, number] = [mx(eye[0], 0), mx(eye[1], 1), mx(eye[2], 2)];
        paintWhere(b.atlas, pr.target.maps, b.pageOf, pr.rec, this.candidates, n, value, through ? null : eyeM, keep);
      }
    }
  }

  private flush(): void {
    const s = this.stroke;
    if (!s) return;
    for (const [id, p] of s.recorders) if (p) this.painted(id, p.target.id, p.rec.takeDirty());
  }

  private onUp(e: PointerEvent): void {
    const s = this.stroke;
    if (!s || e.pointerId !== s.pointerId) return;
    if (s.kind === 'line') {
      this.dabAt(s.last.x, s.last.y);
      this.strokeTo(e.clientX, e.clientY);
    } else if (s.kind === 'lasso') {
      this.applyLasso(s);
    }
    this.drawOverlay([], false);
    this.flush();
    this.stroke = null;
    const el = this.vp.renderer.domElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const edits: StrokeEdit[] = [];
    for (const [id, p] of s.recorders) {
      const edit = p?.rec.finish();
      if (edit) edits.push({ id, edit, target: p!.target.id, maps: p!.target.maps });
    }
    if (edits.length) this.onStrokeEnd?.(edits, s.erase);
  }
}
