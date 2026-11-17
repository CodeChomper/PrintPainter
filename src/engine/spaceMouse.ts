/**
 * 3Dconnexion SpaceMouse over WebHID (Chrome and Edge). The device sends raw HID
 * reports; nothing goes through 3DxWare and nothing leaves the machine.
 *
 * Axes are in the device's HID frame: x right, y toward the user, z down. Rotations
 * follow the right-hand rule about those axes. Full deflection is about ±350.
 */

export interface Axes {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}

export const ZERO_AXES: Readonly<Axes> = Object.freeze({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });

/**
 * Button bit numbers (3Dconnexion's key codes minus one). These are the SpaceMouse Pro's;
 * other models share the ones they have.
 */
export const BUTTON = {
  MENU: 0,
  FIT: 1,
  TOP: 2,
  RIGHT: 4,
  FRONT: 5,
  ROLL: 8,
  ONE: 12,
  TWO: 13,
  THREE: 14,
  FOUR: 15,
  ESC: 22,
  ALT: 23,
  SHIFT: 24,
  CTRL: 25,
  ROTATION: 26,
} as const;

/**
 * Reads one input report. Older devices (SpaceNavigator, wired SpaceMouse Pro) send
 * translation as report 1 and rotation as report 2; newer ones send all six axes in
 * report 1. Report 3 is the button bitmask.
 */
export function parseReport(id: number, data: DataView): { axes?: Partial<Axes>; buttons?: number } | null {
  const i16 = (o: number) => data.getInt16(o, true);
  if (id === 1 && data.byteLength >= 12) {
    return { axes: { tx: i16(0), ty: i16(2), tz: i16(4), rx: i16(6), ry: i16(8), rz: i16(10) } };
  }
  if (id === 1 && data.byteLength >= 6) return { axes: { tx: i16(0), ty: i16(2), tz: i16(4) } };
  if (id === 2 && data.byteLength >= 6) return { axes: { rx: i16(0), ry: i16(2), rz: i16(4) } };
  if (id === 3) {
    let mask = 0;
    for (let i = 0; i < Math.min(4, data.byteLength); i++) mask = (mask | (data.getUint8(i) << (8 * i))) >>> 0;
    return { buttons: mask };
  }
  return null;
}

// Multi-axis controllers (generic desktop page, usage 8) from 3Dconnexion, and the
// older ones sold under Logitech's vendor id.
const FILTERS: HIDDeviceFilter[] = [
  { vendorId: 0x256f, usagePage: 0x01, usage: 0x08 },
  { vendorId: 0x046d, usagePage: 0x01, usage: 0x08 },
];

export const webHidSupported = (): boolean => typeof navigator !== 'undefined' && !!navigator.hid;

const isSpaceMouse = (d: HIDDevice) =>
  FILTERS.some((f) => d.vendorId === f.vendorId && d.collections.some((c) => c.usagePage === f.usagePage && c.usage === f.usage));

/** One connected SpaceMouse. Reconnects to a device the user already allowed. */
export class SpaceMouseDevice {
  onAxes: ((axes: Readonly<Axes>) => void) | null = null;
  onButtons: ((mask: number) => void) | null = null;
  /** The device's name when connected, null when not. */
  onChange: ((name: string | null) => void) | null = null;

  private device: HIDDevice | null = null;
  private axes: Axes = { ...ZERO_AXES };
  private buttons = 0;

  constructor() {
    const hid = navigator.hid;
    if (!hid) return;
    hid.onconnect = (e) => {
      if (!this.device && isSpaceMouse(e.device)) void this.use(e.device).catch(() => {});
    };
    hid.ondisconnect = (e) => {
      if (e.device === this.device) this.drop();
    };
  }

  get name(): string | null {
    return this.device ? this.device.productName || 'SpaceMouse' : null;
  }

  /** Shows the browser's device picker. Must run from a click. */
  async request(): Promise<boolean> {
    const [d] = (await navigator.hid?.requestDevice({ filters: FILTERS })) ?? [];
    if (!d) return false;
    await this.use(d);
    return true;
  }

  /** Opens a device the user allowed before, if one is plugged in. */
  async reconnect(): Promise<void> {
    const d = (await navigator.hid?.getDevices())?.find(isSpaceMouse);
    if (d) await this.use(d);
  }

  /** Closes the device and asks the browser to forget the permission. */
  async forget(): Promise<void> {
    const d = this.device;
    this.drop();
    if (!d) return;
    await d.close().catch(() => {});
    await d.forget?.().catch(() => {});
  }

  private async use(d: HIDDevice): Promise<void> {
    if (this.device === d) return;
    this.drop();
    if (!d.opened) await d.open();
    d.oninputreport = (e) => this.onReport(e);
    this.device = d;
    this.onChange?.(this.name);
  }

  private onReport(e: HIDInputReportEvent): void {
    const r = parseReport(e.reportId, e.data);
    if (!r) return;
    if (r.axes) {
      Object.assign(this.axes, r.axes);
      this.onAxes?.(this.axes);
    }
    if (r.buttons !== undefined && r.buttons !== this.buttons) {
      this.buttons = r.buttons;
      this.onButtons?.(r.buttons);
    }
  }

  private drop(): void {
    if (!this.device) return;
    this.device.oninputreport = null;
    this.device = null;
    this.axes = { ...ZERO_AXES };
    this.buttons = 0;
    this.onAxes?.(this.axes);
    this.onChange?.(null);
  }
}
