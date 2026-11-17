// The parts of WebHID (Chrome and Edge) that PrintPainter uses. TypeScript's DOM
// library doesn't include WebHID yet.

interface HIDCollectionInfo {
  usagePage: number;
  usage: number;
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HIDDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  oninputreport: ((e: HIDInputReportEvent) => void) | null;
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
}

interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice;
}

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HID extends EventTarget {
  onconnect: ((e: HIDConnectionEvent) => void) | null;
  ondisconnect: ((e: HIDConnectionEvent) => void) | null;
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]>;
}

interface Navigator {
  readonly hid?: HID;
}
