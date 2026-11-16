// Project files and the OPFS autosave, off the main thread.
//
// Autosave layout (origin-private file system, folder "autosave"):
//   session-a.json / session-b.json   alternate slots; the newest complete one wins
//   d<seq>-<path>                      one file per project entry, never overwritten
// A save writes its new files, then its session file, then deletes files no session
// needs any more. A crash at any point leaves the previous session intact.

import { expose, transfer } from 'comlink';
import { packProject, parseProject, ProjectError, projectBuffers, unpackProject, type ProjectData } from '@/io/project/ppaint';

export interface SessionInfo {
  seq: number;
  savedAt: number;
  /** Project name shown in the title bar. */
  name: string;
  /** Unsaved changes compared with the project file. */
  dirty: boolean;
  manifest: string;
  /** Project path → stored file name. */
  files: Record<string, string>;
}

export type ReadResult = { data: ProjectData; error?: undefined } | { data?: undefined; error: string };

function sendProject(data: ProjectData): ReadResult {
  return transfer({ data }, projectBuffers(data));
}

const DIR = 'autosave';
const SLOTS = ['session-a.json', 'session-b.json'];

interface SyncHandle {
  truncate(n: number): void;
  write(d: Uint8Array, o: { at: number }): number;
  flush(): void;
  close(): void;
}
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> };
type DirHandle = FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };

async function folder(): Promise<DirHandle> {
  const root = await navigator.storage.getDirectory();
  return (await root.getDirectoryHandle(DIR, { create: true })) as DirHandle;
}

async function writeFile(dir: DirHandle, name: string, data: Uint8Array): Promise<void> {
  const fh = (await dir.getFileHandle(name, { create: true })) as FileHandle;
  if (fh.createSyncAccessHandle) {
    const h = await fh.createSyncAccessHandle();
    try {
      h.truncate(0);
      let at = 0;
      while (at < data.length) at += h.write(data.subarray(at), { at });
      h.flush();
    } finally {
      h.close();
    }
    return;
  }
  const w = await fh.createWritable();
  await w.write(data as Uint8Array<ArrayBuffer>);
  await w.close();
}

async function readFile(dir: DirHandle, name: string): Promise<Uint8Array | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

async function readSessions(dir: DirHandle): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const slot of SLOTS) {
    const b = await readFile(dir, slot);
    if (!b) continue;
    try {
      const s = JSON.parse(new TextDecoder().decode(b)) as SessionInfo;
      if (Number.isInteger(s.seq) && typeof s.manifest === 'string' && s.files && typeof s.files === 'object') out.push(s);
    } catch {
      /* half-written slot: the other one is the good one */
    }
  }
  return out.sort((a, b) => b.seq - a.seq);
}

const api = {
  /** Zips a project. The inputs are copies. */
  pack(manifest: string, files: Record<string, Uint8Array>): Uint8Array {
    const z = packProject(manifest, files);
    return transfer(z, [z.buffer as ArrayBuffer]);
  },

  /** Reads a .ppaint. Problems with the file come back as `error` (a message for the user). */
  read(bytes: Uint8Array): ReadResult {
    try {
      const { manifest, files } = unpackProject(bytes);
      return sendProject(parseProject(manifest, files));
    } catch (e) {
      if (e instanceof ProjectError) return { error: e.message };
      throw e;
    }
  },

  /** Writes the changed files (stored name → bytes), then the session that lists all of them. */
  async saveSession(session: SessionInfo, changed: Record<string, Uint8Array>): Promise<void> {
    const dir = await folder();
    for (const [name, data] of Object.entries(changed)) await writeFile(dir, name, data);
    await writeFile(dir, SLOTS[session.seq % 2]!, new TextEncoder().encode(JSON.stringify(session)));
    // Keep what this session and the other slot's session need; delete the rest.
    const keep = new Set<string>(SLOTS);
    for (const s of await readSessions(dir)) for (const f of Object.values(s.files)) keep.add(f);
    const stale: string[] = [];
    for await (const name of dir.keys()) if (!keep.has(name)) stale.push(name);
    for (const name of stale) await dir.removeEntry(name).catch(() => undefined);
  },

  /** The newest session whose files are all there, or null. */
  async loadSession(): Promise<{ session: SessionInfo; result: ReadResult } | null> {
    const dir = await folder();
    for (const session of await readSessions(dir)) {
      const files: Record<string, Uint8Array> = {};
      let complete = true;
      for (const [path, name] of Object.entries(session.files)) {
        const b = await readFile(dir, name);
        if (!b) {
          complete = false;
          break;
        }
        files[path] = b;
      }
      if (!complete) continue;
      try {
        const data = parseProject(session.manifest, files);
        return transfer({ session, result: { data } }, projectBuffers(data));
      } catch (e) {
        return { session, result: { error: (e as Error).message } };
      }
    }
    return null;
  },

  async clearSession(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DIR, { recursive: true }).catch(() => undefined);
  },
};

export type ProjectApi = typeof api;
expose(api);
