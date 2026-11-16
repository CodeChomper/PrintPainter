import { defineStore } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import { transfer } from 'comlink';
import {
  PROJECT_EXTENSION,
  PROJECT_MIME,
  projectEntries,
  type ProjectData,
} from '@/io/project/ppaint';
import { platform, type FileTarget } from '@/platform';
import type { ReadResult, SessionInfo } from '@/workers/project.worker';
import { sceneObjects } from '../document';
import { projectIo } from '../services/workers';
import { useExportStore } from './export';
import { usePaintStore } from './paint';
import { usePaletteStore } from './palette';
import { useSceneStore } from './scene';
import { useUiStore } from './ui';

const UNTITLED = 'Untitled';
/** Set while a restored session is loading; still set at startup means it crashed. */
const RESTORING_KEY = 'pp.restoring';
const LOCK = 'printpainter-autosave';
/** Autosave this long after the last change… */
const QUIET_MS = 1500;
/** …but at least this often while changes keep coming. */
const MAX_WAIT_MS = 10_000;

const FILE_OPTIONS = {
  description: 'PrintPainter project',
  extension: PROJECT_EXTENSION,
  mime: PROJECT_MIME,
};

const stripExt = (n: string) => n.replace(/\.ppaint$/i, '') || UNTITLED;

export type AutosaveState = 'starting' | 'on' | 'saving' | 'off' | 'other-tab' | 'failed';

/**
 * The open project: its name, where it is saved, unsaved changes, and the autosave
 * to the browser's private storage (OPFS) that brings the work back after a reload.
 */
export const useProjectStore = defineStore('project', () => {
  const ui = useUiStore();
  const scene = useSceneStore();
  const paint = usePaintStore();
  const palette = usePaletteStore();

  const name = ref(UNTITLED);
  /** Unsaved changes compared with the project file. */
  const dirty = ref(false);
  const busy = ref<string | null>(null);
  const autosave = ref<AutosaveState>('starting');
  const lastAutosave = ref<number | null>(null);
  let target: FileTarget | null = null;
  /** Counts changes, so a save only clears `dirty` if nothing changed while it ran. */
  let changes = 0;
  let loading = false;

  const application = `PrintPainter-${__APP_VERSION__}`;

  function collect(): ProjectData {
    return {
      palette: palette.slots.map((s) => ({ ...s })),
      objects: [...sceneObjects.values()].map((o) => ({
        id: o.id,
        name: o.name,
        fileName: o.fileName,
        format: o.format,
        importId: o.importId,
        unit: o.unit,
        offset: o.offset,
        hidden: o.hidden,
        mesh: o.mesh,
        report: o.report,
        paint: o.paint && { ...o.paint, current: o.paintState === 'ready' },
        revs: { surface: o.surfaceRev, paint: o.paintRev, maps: o.paint?.mapRevs },
      })),
    };
  }

  // ---- change tracking ---------------------------------------------------------

  watch(
    () => [
      paint.revision,
      palette.slots.map((s) => `${s.name}|${s.color}|${s.material}`).join(),
      scene.items.map((i) => `${i.id}|${i.name}|${i.hidden}|${i.unit}|${i.paintState}`).join(),
    ],
    () => {
      changes++;
      if (!loading && sceneObjects.size) dirty.value = true;
      if (!sceneObjects.size && !target) dirty.value = false;
      scheduleAutosave();
    },
  );

  watch(
    [name, dirty],
    ([n, d]) => {
      document.title = `${d ? '• ' : ''}${n} – PrintPainter`;
    },
    { immediate: true },
  );

  /** Replaces the scene with a project. */
  async function load(data: ProjectData) {
    loading = true;
    try {
      useExportStore().close();
      paint.tool = 'select';
      scene.clear();
      palette.setSlots(data.palette);
      scene.restore(data.objects);
      await nextTick(); // let the change watcher see the load before `loading` ends
    } finally {
      loading = false;
    }
  }

  function confirmDiscard(): boolean {
    if (!dirty.value || !sceneObjects.size) return true;
    return confirm(`"${name.value}" has unsaved changes. Discard them?`);
  }

  // ---- files ---------------------------------------------------------------------

  async function build(): Promise<Blob> {
    const { manifest, entries } = projectEntries(collect(), application);
    // The worker gets copies (structured clone), taken right here.
    const bytes = await projectIo().pack(manifest, Object.fromEntries(entries.map((e) => [e.path, e.data()])));
    return new Blob([bytes as BlobPart], { type: PROJECT_MIME });
  }

  function saved(at: number, n: string, t: FileTarget | null) {
    name.value = n;
    target = t;
    if (changes === at) dirty.value = false;
    scheduleAutosave(); // the name and saved state are part of the session
  }

  async function saveAs(): Promise<boolean> {
    if (busy.value) return false;
    const at = changes;
    try {
      const r = await platform.saveFileAs(
        async () => {
          busy.value = 'Saving…';
          return build();
        },
        { ...FILE_OPTIONS, suggestedName: `${name.value}.${PROJECT_EXTENSION}` },
      );
      if (!r) return false;
      saved(at, stripExt(r.name), r.target);
      ui.notify('info', r.target ? `Saved ${r.name}.` : `Downloaded ${r.name}. Use Open… to continue from it later.`);
      return true;
    } catch (e) {
      ui.notify('error', `Couldn't save: ${(e as Error).message}`);
      return false;
    } finally {
      busy.value = null;
    }
  }

  async function save(): Promise<boolean> {
    if (busy.value) return false;
    if (!target) return saveAs();
    const at = changes;
    busy.value = 'Saving…';
    try {
      await platform.writeFile(target, await build());
      saved(at, name.value, target);
      return true;
    } catch (e) {
      ui.notify('error', `Couldn't save ${target.name}: ${(e as Error).message}`);
      return false;
    } finally {
      busy.value = null;
    }
  }

  async function openFile(file: File, t: FileTarget | null) {
    if (busy.value) return;
    busy.value = `Opening ${file.name}…`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r: ReadResult = await projectIo().read(transfer(bytes, [bytes.buffer]));
      if (r.error !== undefined) {
        ui.notify('error', `${file.name}: ${r.error}`);
        return;
      }
      await load(r.data);
      name.value = stripExt(file.name);
      target = t;
      dirty.value = false;
      scheduleAutosave();
    } catch (e) {
      ui.notify('error', `Couldn't open ${file.name}: ${(e as Error).message}`);
      console.error(e);
    } finally {
      busy.value = null;
    }
  }

  async function open() {
    if (busy.value || !confirmDiscard()) return;
    const f = await platform.openFile({ description: 'PrintPainter projects', extensions: [PROJECT_EXTENSION] });
    if (f) await openFile(f.file, f.target);
  }

  /** A project dropped on the view or opened from the OS. */
  async function openDropped(file: File, t: FileTarget | null = null) {
    if (confirmDiscard()) await openFile(file, t);
  }

  async function newProject() {
    if (busy.value || !confirmDiscard()) return;
    await load({ palette: palette.slots.map((s) => ({ ...s })), objects: [] });
    name.value = UNTITLED;
    target = null;
    dirty.value = false;
    scheduleAutosave();
  }

  // ---- autosave ------------------------------------------------------------------

  let enabled = false;
  let seq = 0;
  /** What the session on disk holds: project path → tag and stored file name. */
  let written = new Map<string, { tag: string; stored: string }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPending = 0;
  let pending = false;
  let running: Promise<void> | null = null;
  let again = false;
  let warned = false;

  function scheduleAutosave() {
    if (!enabled) return;
    const now = Date.now();
    if (!pending) firstPending = now;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => void runAutosave(), Math.max(0, Math.min(QUIET_MS, firstPending + MAX_WAIT_MS - now)));
  }

  async function runAutosave(): Promise<void> {
    if (!enabled) return;
    if (running) {
      again = true;
      return running;
    }
    clearTimeout(timer);
    if (!pending) return;
    pending = false;
    autosave.value = 'saving';
    running = (async () => {
      const s = seq + 1;
      const { manifest, entries } = projectEntries(collect(), application);
      const files: Record<string, string> = {};
      const changed: Record<string, Uint8Array> = {};
      const next = new Map<string, { tag: string; stored: string }>();
      for (const e of entries) {
        let w = written.get(e.path);
        if (!w || w.tag !== e.tag) {
          w = { tag: e.tag, stored: `d${s}-${e.path.replaceAll('/', '~')}` };
          changed[w.stored] = e.data();
        }
        files[e.path] = w.stored;
        next.set(e.path, w);
      }
      const session: SessionInfo = { seq: s, savedAt: Date.now(), name: name.value, dirty: dirty.value, manifest, files };
      await projectIo().saveSession(session, changed);
      seq = s;
      written = next;
      lastAutosave.value = session.savedAt;
    })();
    try {
      await running;
      autosave.value = 'on';
      warned = false;
    } catch (e) {
      autosave.value = 'failed';
      console.error(e);
      if (!warned) ui.notify('warning', `Autosave failed: ${(e as Error).message}. Save the project to keep your work.`);
      warned = true;
      written = new Map(); // write everything again next time
    } finally {
      running = null;
    }
    if (again) {
      again = false;
      pending = true;
      await runAutosave();
    }
  }

  /** Holds the autosave lock for as long as this tab lives; false if another tab has it. */
  function takeLock(): Promise<boolean> {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      void locks.request(LOCK, { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise<void>(() => {}) : undefined;
      });
    });
  }

  /** Starts the autosave and brings back the last session. Call once, after the viewport exists. */
  async function start() {
    if (!navigator.storage?.getDirectory) {
      autosave.value = 'off';
      return;
    }
    if (!(await takeLock())) {
      autosave.value = 'other-tab';
      ui.notify('warning', "PrintPainter is open in another tab, so this tab won't autosave. Use Save to keep work from this tab.");
      return;
    }
    try {
      const r = await projectIo().loadSession();
      if (r) {
        seq = r.session.seq;
        if (r.result.error !== undefined) {
          ui.notify('warning', `Couldn't restore your last session: ${r.result.error}`);
        } else if (r.result.data.objects.length && !sceneObjects.size) {
          await restore(r.session, r.result.data);
        }
      }
    } catch (e) {
      console.error(e);
      ui.notify('warning', `Couldn't read the autosave: ${(e as Error).message}`);
    }
    enabled = true;
    autosave.value = 'on';
    if (pending || sceneObjects.size) scheduleAutosave();
    platform.onOpenWith((files) => {
      const f = files.find((x) => x.file.name.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`));
      if (f) void openDropped(f.file, f.target);
    });
  }

  async function restore(session: SessionInfo, data: ProjectData) {
    let crashed = false;
    try {
      crashed = localStorage.getItem(RESTORING_KEY) !== null;
    } catch {
      /* ignore */
    }
    const n = data.objects.length;
    if (crashed && !confirm(`Last time, PrintPainter stopped while restoring your session (${n} object${n === 1 ? '' : 's'}). Try again? Cancel starts empty.`)) {
      clearRestoring();
      await projectIo().clearSession();
      seq = 0;
      return;
    }
    try {
      localStorage.setItem(RESTORING_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    await load(data);
    name.value = session.name || UNTITLED;
    dirty.value = session.dirty;
    lastAutosave.value = session.savedAt;
    // The restored objects are exactly what the session holds: don't write them again.
    const { entries } = projectEntries(collect(), application);
    written = new Map();
    for (const e of entries) {
      const stored = session.files[e.path];
      if (stored) written.set(e.path, { tag: e.tag, stored });
    }
    // Clear the crash marker once the restored scene has been on screen for a moment.
    setTimeout(clearRestoring, 3000);
    ui.notify('info', `Restored your last session: ${n} object${n === 1 ? '' : 's'}.`);
  }

  function clearRestoring() {
    try {
      localStorage.removeItem(RESTORING_KEY);
    } catch {
      /* ignore */
    }
  }

  // Try to catch up before the tab goes away, and warn if that may not have worked.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending) void runAutosave();
  });
  window.addEventListener('beforeunload', (e) => {
    const unsafe = enabled ? pending || !!running : dirty.value && sceneObjects.size > 0;
    if (unsafe) e.preventDefault();
  });

  return {
    name,
    dirty,
    busy,
    autosave,
    lastAutosave,
    start,
    open,
    openDropped,
    save,
    saveAs,
    newProject,
    /** For tests and debugging: write the autosave now. */
    flushAutosave: () => {
      if (enabled) pending = true;
      return runAutosave();
    },
  };
});
