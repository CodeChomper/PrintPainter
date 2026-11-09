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

export interface PlatformFS {
  /** Resolves to the chosen files, or [] if the user cancelled. */
  openFiles(options: OpenFileOptions): Promise<File[]>;
}
