import type { FileTarget, OpenedFile, OpenFileOptions, PlatformFS, SavedFile, SaveFileOptions } from './PlatformFS';

// Minimal typings for the File System Access API (Chromium only, not in TS's DOM lib).
interface FsaHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}
type ShowOpenFilePicker = (o: { multiple?: boolean; types?: PickerType[] }) => Promise<FsaHandle[]>;
type ShowSaveFilePicker = (o: { suggestedName?: string; types?: PickerType[] }) => Promise<FsaHandle>;

const w = window as unknown as { showOpenFilePicker?: ShowOpenFilePicker; showSaveFilePicker?: ShowSaveFilePicker };

class HandleTarget implements FileTarget {
  constructor(readonly handle: FsaHandle) {}
  get name() {
    return this.handle.name;
  }
}

function download(data: Blob, name: string): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function pickWithInput(o: OpenFileOptions): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!o.multiple;
    input.accept = o.extensions.map((e) => `.${e}`).join(',');
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

const openTypes = (o: OpenFileOptions): PickerType[] => [
  { description: o.description, accept: { 'application/octet-stream': o.extensions.map((e) => `.${e}`) } },
];
const saveTypes = (o: SaveFileOptions): PickerType[] => [{ description: o.description, accept: { [o.mime]: [`.${o.extension}`] } }];
const aborted = (e: unknown) => (e as DOMException)?.name === 'AbortError';

async function pickHandles(o: OpenFileOptions): Promise<FsaHandle[] | null> {
  if (!w.showOpenFilePicker) return null;
  try {
    return await w.showOpenFilePicker({ multiple: !!o.multiple, types: openTypes(o) });
  } catch (e) {
    if (aborted(e)) return [];
    // Some extensions/MIME combinations are rejected by the picker; fall back to <input>.
    return null;
  }
}

async function write(handle: FsaHandle, data: Blob): Promise<void> {
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') {
      throw new Error('PrintPainter was not allowed to write to the file.');
    }
  }
  const out = await handle.createWritable();
  await out.write(data);
  await out.close();
}

export const webFS: PlatformFS = {
  async openFiles(o) {
    const handles = await pickHandles(o);
    if (!handles) return pickWithInput(o);
    return Promise.all(handles.map((h) => h.getFile()));
  },

  async openFile(o): Promise<OpenedFile | null> {
    const handles = await pickHandles({ ...o, multiple: false });
    if (!handles) {
      const [file] = await pickWithInput({ ...o, multiple: false });
      return file ? { file, target: null } : null;
    }
    const h = handles[0];
    return h ? { file: await h.getFile(), target: new HandleTarget(h) } : null;
  },

  async saveFile(data, o) {
    return !!(await webFS.saveFileAs(async () => data, o));
  },

  async saveFileAs(produce, o): Promise<SavedFile | null> {
    let handle: FsaHandle | null = null;
    if (w.showSaveFilePicker) {
      try {
        handle = await w.showSaveFilePicker({ suggestedName: o.suggestedName, types: saveTypes(o) });
      } catch (e) {
        if (aborted(e)) return null;
        // Picker refused (e.g. blocked in this context): download instead.
      }
    }
    const data = await produce();
    if (!handle) {
      download(data, o.suggestedName);
      return { name: o.suggestedName, target: null };
    }
    await write(handle, data);
    return { name: handle.name, target: new HandleTarget(handle) };
  },

  async writeFile(target, data) {
    if (!(target instanceof HandleTarget)) throw new Error('This file can only be saved as a new download.');
    await write(target.handle, data);
  },

  onOpenWith(handler) {
    // Installed PWA with manifest file_handlers (Chromium).
    const q = (window as unknown as { launchQueue?: { setConsumer(c: (p: { files: FsaHandle[] }) => void): void } }).launchQueue;
    q?.setConsumer(async (params) => {
      if (!params.files?.length) return;
      handler(await Promise.all(params.files.map(async (h) => ({ file: await h.getFile(), target: new HandleTarget(h) }))));
    });
  },
};
