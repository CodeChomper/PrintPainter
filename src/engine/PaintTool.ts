// Brush and eraser input: turns pointer strokes on the viewport into dabs on the
// objects' slot maps, with X/Y/Z mirror symmetry, and reports each finished stroke
// as undo edits.

import { Vector3 } from 'three';
import { paintDab, PaintRecorder, type Dab, type TileEdit, type Vec3 } from '@/core/paint';
import type { DepthView } from './depth';
import type { PaintBinding, Viewport } from './Viewport';

export type PaintMode = 'brush' | 'eraser' | null;

export interface PaintSettings {
  mode: PaintMode;
  /** Brush radius in mm. */
  radius: number;
  /** Slot painted by the brush (1..16). */
  slot: number;
  /** Mirror across the object's centre on X, Y, Z. */
  symmetry: [boolean, boolean, boolean];
  /** #rrggbb of the slot, for the brush outline. */
  slotColor: string;
}

export interface StrokeEdit {
  id: string;
  edit: TileEdit;
}

interface Stroke {
  erase: boolean;
  depth: DepthView;
  recorders: Map<string, PaintRecorder>;
  last: { x: number; y: number };
  pointerId: number;
}

/** Dab spacing as a fraction of the brush radius. */
const SPACING = 0.3;

export class PaintTool {
  settings: PaintSettings = { mode: null, radius: 2, slot: 2, symmetry: [false, false, false], slotColor: '#ffffff' };
  /** A stroke finished and changed something. */
  onStrokeEnd: ((edits: StrokeEdit[]) => void) | null = null;
  /** The user tried to paint an object whose paint surface isn't ready yet. */
  onBlocked: ((id: string) => void) | null = null;

  private stroke: Stroke | null = null;
  private candidates = new Uint32Array(1024);
  private shiftDown = false;
  private disposers: (() => void)[] = [];

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
      if (!this.stroke) this.vp.hideBrushRing();
    });
    on(window, 'keydown', (e) => (this.shiftDown = e.shiftKey));
    on(window, 'keyup', (e) => (this.shiftDown = e.shiftKey));
  }

  /** Applies new settings and refreshes the cursor. */
  update(settings: Partial<PaintSettings>): void {
    Object.assign(this.settings, settings);
    if (!this.settings.mode) {
      this.vp.hideBrushRing();
      this.vp.renderer.domElement.style.cursor = '';
    }
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.vp.hideBrushRing();
  }

  private ringColor(erase: boolean): string {
    return erase ? '#ffffff' : this.settings.slotColor;
  }

  private onDown(e: PointerEvent): void {
    if (!this.settings.mode || e.button !== 0 || e.altKey || this.stroke) return;
    const hit = this.vp.paintHit(e.clientX, e.clientY, true);
    if (!hit) return; // empty space: let the view rotate (Bambu preset)
    e.stopImmediatePropagation();
    e.preventDefault();
    if (!hit.ready) {
      this.onBlocked?.(hit.id);
      return;
    }
    try {
      this.vp.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone (or synthetic): the stroke still works inside the canvas */
    }
    this.stroke = {
      erase: this.settings.mode === 'eraser' || e.shiftKey,
      depth: this.vp.captureDepth(),
      recorders: new Map(),
      last: { x: e.clientX, y: e.clientY },
      pointerId: e.pointerId,
    };
    this.dabAt(e.clientX, e.clientY);
    this.flush();
  }

  private onMove(e: PointerEvent): void {
    const s = this.stroke;
    if (!s) {
      this.hover(e);
      return;
    }
    if (e.pointerId !== s.pointerId) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) this.strokeTo(ev.clientX, ev.clientY);
    this.flush();
  }

  private hover(e: PointerEvent): void {
    if (!this.settings.mode || e.buttons) return;
    const hit = this.vp.paintHit(e.clientX, e.clientY);
    const el = this.vp.renderer.domElement;
    if (!hit) {
      this.vp.hideBrushRing();
      el.style.cursor = '';
      return;
    }
    el.style.cursor = 'none';
    this.vp.showBrushRing(hit.point, this.settings.radius, this.ringColor(this.settings.mode === 'eraser' || e.shiftKey || this.shiftDown));
  }

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

  private dabAt(x: number, y: number): void {
    const s = this.stroke!;
    const hit = this.vp.paintHit(x, y);
    if (!hit) return;
    this.vp.showBrushRing(hit.point, this.settings.radius, this.ringColor(s.erase));
    const binding = this.vp.paintBinding(hit.id);
    const mesh = this.vp.objectMesh(hit.id);
    if (!binding || !mesh) return;
    let rec = s.recorders.get(hit.id);
    if (!rec) {
      rec = new PaintRecorder(binding.atlas, binding.maps);
      s.recorders.set(hit.id, rec);
    }

    // Work in the object's source units: world = local × scale + offset.
    const scale = mesh.scale.x;
    const off = mesh.position;
    const cam = this.vp.camera.position;
    const dir = new Vector3().subVectors(hit.point, cam).normalize();
    const origin: Vec3 = [(cam.x - off.x) / scale, (cam.y - off.y) / scale, (cam.z - off.z) / scale];
    const d: Vec3 = [dir.x, dir.y, dir.z];
    const radius = this.settings.radius / scale;
    const depth = s.depth;
    const visible = (px: number, py: number, pz: number) =>
      depth.visible(px * scale + off.x, py * scale + off.y, pz * scale + off.z);

    const box = mesh.geometry.boundingBox!;
    const c = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
    const [sx, sy, sz] = this.settings.symmetry;
    const value = s.erase ? 0 : this.settings.slot;
    for (let m = 0; m < 8; m++) {
      if ((m & 1 && !sx) || (m & 2 && !sy) || (m & 4 && !sz)) continue;
      const flip = [m & 1 ? -1 : 1, m & 2 ? -1 : 1, m & 4 ? -1 : 1] as const;
      const mirror = (v: Vec3): Vec3 => [0, 1, 2].map((k) => (flip[k]! < 0 ? 2 * c[k]! - v[k]! : v[k]!)) as Vec3;
      const dab: Dab = {
        origin: mirror(origin),
        dir: [d[0] * flip[0], d[1] * flip[1], d[2] * flip[2]],
        radius,
        value,
        // A mirrored texel is visible if its mirror image (on the side being looked at) is.
        visible:
          m === 0
            ? visible
            : (px, py, pz) =>
                visible(flip[0] < 0 ? 2 * c[0]! - px : px, flip[1] < 0 ? 2 * c[1]! - py : py, flip[2] < 0 ? 2 * c[2]! - pz : pz),
      };
      const n = this.gather(binding, dab);
      paintDab(binding.atlas, binding.maps, binding.pageOf, rec, dab, this.candidates, n);
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
        if (n + count > this.candidates.length) {
          const bigger = new Uint32Array(Math.max(this.candidates.length * 2, n + count));
          bigger.set(this.candidates.subarray(0, n));
          this.candidates = bigger;
        }
        for (let i = offset; i < offset + count; i++) this.candidates[n++] = bvh.resolveTriangleIndex(i);
        return false;
      },
    });
    return n;
  }

  private flush(): void {
    const s = this.stroke;
    if (!s) return;
    for (const [id, rec] of s.recorders) this.vp.uploadPaint(id, rec.takeDirty());
  }

  private onUp(e: PointerEvent): void {
    const s = this.stroke;
    if (!s || e.pointerId !== s.pointerId) return;
    this.flush();
    this.stroke = null;
    const el = this.vp.renderer.domElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const edits: StrokeEdit[] = [];
    for (const [id, rec] of s.recorders) {
      const edit = rec.finish();
      if (edit) edits.push({ id, edit });
    }
    if (edits.length) this.onStrokeEnd?.(edits);
  }
}
