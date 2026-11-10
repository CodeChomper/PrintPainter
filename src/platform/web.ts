import type { OpenFileOptions, PlatformFS, SaveFileOptions } from './PlatformFS';

// Minimal typings for the File System Access API (Chromium only, not in TS's DOM lib).
interface FilePickerHandle {
  getFile(): Promise<File>;
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type ShowOpenFilePicker = (o: OpenFilePickerOptions) => Promise<FilePickerHandle[]>;
interface WritableHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}
type ShowSaveFilePicker = (o: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<WritableHandle>;

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

export const webFS: PlatformFS = {
  async openFiles(o) {
    const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
    if (!picker) return pickWithInput(o);
    try {
      const handles = await picker({
        multiple: !!o.multiple,
        types: [{ description: o.description, accept: { 'application/octet-stream': o.extensions.map((e) => `.${e}`) } }],
      });
      return Promise.all(handles.map((h) => h.getFile()));
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return [];
      // Some extensions/MIME combinations are rejected by the picker; fall back to <input>.
      return pickWithInput(o);
    }
  },

  async saveFile(data: Blob, o: SaveFileOptions) {
    const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
    if (!picker) {
      download(data, o.suggestedName);
      return true;
    }
    try {
      const handle = await picker({
        suggestedName: o.suggestedName,
        types: [{ description: o.description, accept: { [o.mime]: [`.${o.extension}`] } }],
      });
      const w = await handle.createWritable();
      await w.write(data);
      await w.close();
      return true;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return false;
      download(data, o.suggestedName);
      return true;
    }
  },
};
