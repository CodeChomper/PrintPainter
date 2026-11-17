import { Vector3 } from 'three';
import type { Viewport } from './Viewport';
import type { Axes } from './spaceMouse';

export interface SpaceSettings {
  /** Overall speed multiplier. */
  speed: number;
  /** Pan and zoom only. */
  lockRotation: boolean;
  /** Zoom by pushing down / pulling up instead of pushing forward / pulling back. */
  zoomUpDown: boolean;
  invertPanX: boolean;
  invertPanY: boolean;
  invertZoom: boolean;
  invertTilt: boolean;
  invertSpin: boolean;
}

export const DEFAULT_SPACE_SETTINGS: Readonly<SpaceSettings> = Object.freeze({
  speed: 1,
  lockRotation: false,
  zoomUpDown: false,
  invertPanX: false,
  invertPanY: false,
  invertZoom: false,
  invertTilt: false,
  invertSpin: false,
});

/**
 * What the cap asks for, in "object mode" (you move the cap as if holding the model),
 * each -1..1. panX: model right; panY: model up; zoom: model toward you; tilt: model's
 * top toward you; spin: model turns anticlockwise seen from above. The horizon stays
 * level (Z up, like the slicers), so the cap's roll is not used.
 */
export interface Motion {
  panX: number;
  panY: number;
  zoom: number;
  tilt: number;
  spin: number;
}

const FULL_SCALE = 350;
const DEAD_ZONE = 0.04;
/** Above 1: finer control near the centre. */
const CURVE = 1.6;

/** Raw axis value to -1..1 with a dead zone and a response curve. */
export function shapeAxis(raw: number): number {
  const n = Math.min(1, Math.abs(raw) / FULL_SCALE);
  if (n <= DEAD_ZONE) return 0;
  return Math.sign(raw) * ((n - DEAD_ZONE) / (1 - DEAD_ZONE)) ** CURVE;
}

/** True when any axis, roll included, is pushed past the dead zone. */
export function isDeflected(a: Readonly<Axes>): boolean {
  return [a.tx, a.ty, a.tz, a.rx, a.ry, a.rz].some((v) => shapeAxis(v) !== 0);
}

export function motionFromAxes(a: Readonly<Axes>, s: Readonly<SpaceSettings>): Motion {
  const sign = (inv: boolean) => (inv ? -1 : 1);
  // HID frame: x right, y toward the user, z down.
  const right = shapeAxis(a.tx);
  const up = -shapeAxis(a.tz);
  const toward = shapeAxis(a.ty);
  const m: Motion = {
    panX: right * sign(s.invertPanX),
    panY: (s.zoomUpDown ? -toward : up) * sign(s.invertPanY),
    zoom: (s.zoomUpDown ? -up : toward) * sign(s.invertZoom),
    // +rx tips the cap's top toward the user; +rz twists it clockwise seen from above.
    tilt: s.lockRotation ? 0 : shapeAxis(a.rx) * sign(s.invertTilt),
    spin: s.lockRotation ? 0 : -shapeAxis(a.rz) * sign(s.invertSpin),
  };
  return m;
}

const isStill = (m: Motion) => !m.panX && !m.panY && !m.zoom && !m.tilt && !m.spin;

// At full deflection and speed 1.
const ROTATE_RAD_PER_S = 2;
/** View distances per second. */
const PAN_PER_S = 1;
/** e-folds of distance per second. */
const ZOOM_PER_S = 1.6;
const MIN_DISTANCE_MM = 0.5;
/** Keeps the camera off the poles (straight up or down), where "level" is undefined. */
const POLE = 0.01;

/**
 * Moves the camera from SpaceMouse input, once per animation frame while the cap is
 * pushed. The camera turns about the point on the model at the centre of the view
 * (picked when a move starts), or the orbit centre when nothing is there.
 */
export class SpaceNavigation {
  settings: SpaceSettings = { ...DEFAULT_SPACE_SETTINGS };

  private axes: Axes = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  private raf = 0;
  private last = 0;
  private pivot: Vector3 | null = null;

  constructor(private viewport: () => Viewport | null) {}

  setAxes(a: Readonly<Axes>): void {
    Object.assign(this.axes, a);
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.end(this.viewport());
  }

  private tick(t: number): void {
    this.raf = 0;
    const vp = this.viewport();
    const m = motionFromAxes(this.axes, this.settings);
    // Like 3DxWare, only the focused window moves (the device keeps reporting while
    // you use it in a slicer).
    if (!vp || isStill(m) || !document.hasFocus() || document.visibilityState !== 'visible') {
      this.end(vp);
      return;
    }
    this.raf = requestAnimationFrame((t2) => this.tick(t2));
    if (vp.strokeActive()) {
      this.last = t; // a stroke's occlusion was captured for this view: wait for it to end
      return;
    }
    if (!this.pivot) {
      this.pivot = vp.centreHit() ?? vp.controls.target.clone();
      this.last = t;
      vp.onNavMotion?.(true);
      return;
    }
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    if (dt > 0) this.apply(vp, m, dt);
  }

  private end(vp: Viewport | null): void {
    if (!this.pivot) return;
    this.pivot = null;
    if (!vp) return;
    vp.controls.update();
    vp.onNavMotion?.(false);
  }

  private apply(vp: Viewport, m: Motion, dt: number): void {
    const cam = vp.camera;
    const pivot = this.pivot!;
    const k = this.settings.speed;
    const offset = cam.position.clone().sub(pivot);
    let dist = Math.max(1e-6, offset.length());

    // Pan in the view plane, at a constant speed on screen.
    if (m.panX || m.panY) {
      const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const step = PAN_PER_S * k * dist * dt;
      pivot.addScaledVector(right, -m.panX * step).addScaledVector(up, -m.panY * step);
    }

    // Zoom toward the pivot, slowing as it gets close.
    if (m.zoom) dist = Math.max(MIN_DISTANCE_MM, dist * Math.exp(-m.zoom * ZOOM_PER_S * k * dt));

    // Turntable rotation around the pivot: the camera moves opposite to the model.
    let theta = Math.atan2(offset.y, offset.x);
    let phi = Math.acos(Math.min(1, Math.max(-1, offset.z / offset.length())));
    theta -= m.spin * ROTATE_RAD_PER_S * k * dt;
    phi = Math.min(Math.PI - POLE, Math.max(POLE, phi - m.tilt * ROTATE_RAD_PER_S * k * dt));
    offset.set(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi)).multiplyScalar(dist);

    cam.position.copy(pivot).add(offset);
    cam.lookAt(pivot);
    if (dist * 20 > cam.far) {
      cam.far = dist * 20;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    vp.controls.target.copy(pivot);
    vp.requestRender();
  }
}
