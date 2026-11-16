/**
 * All file and OS access goes through this interface, so an Electron build can swap in
 * a preload/IPC implementation later (see PLAN.md, "Electron readiness").
 */
export interface OpenFileOptions {
  description: string;
  /** Extensions without the dot, e.g. ['stl', 'obj']. */
  extensions: string[];
  multiple?: boolean;
}

export interface SaveFileOptions {
  suggestedName: string;
  description: string;
  /** Extension without the dot. */
  extension: string;
  mime: string;
}

/** A file we may write to again (Save after Save As or Open). Opaque to callers. */
export interface FileTarget {
  readonly name: string;
}

export interface OpenedFile {
  file: File;
  /** Null when the platform can't write back to the file (plain upload). */
  target: FileTarget | null;
}

export interface SavedFile {
  name: string;
  /** Null when the file was downloaded, so saving again downloads again. */
  target: FileTarget | null;
}

export interface PlatformFS {
  /** Resolves to the chosen files, or [] if the user cancelled. */
  openFiles(options: OpenFileOptions): Promise<File[]>;
  /** One file, with a handle to save back to it when the platform allows. Null if cancelled. */
  openFile(options: OpenFileOptions): Promise<OpenedFile | null>;
  /** Saves (or downloads) data. Resolves false if the user cancelled. */
  saveFile(data: Blob, options: SaveFileOptions): Promise<boolean>;
  /**
   * Asks where to save, then calls `produce` and writes its result. The location is asked
   * first so the picker opens while the click still counts as a user gesture.
   * Null if the user cancelled.
   */
  saveFileAs(produce: () => Promise<Blob>, options: SaveFileOptions): Promise<SavedFile | null>;
  /** Overwrites a file chosen earlier. */
  writeFile(target: FileTarget, data: Blob): Promise<void>;
  /** Files the OS asked the app to open ("Open with", double-click on an installed app). */
  onOpenWith(handler: (files: OpenedFile[]) => void): void;
}
