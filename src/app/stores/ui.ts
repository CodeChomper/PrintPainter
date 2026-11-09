import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { NAV_PRESETS, type NavPreset } from '@/engine/navigation';

const NAV_KEY = 'pp.navPreset';

export type NoticeKind = 'info' | 'warning' | 'error';
export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}

function loadNavPreset(): NavPreset {
  try {
    const v = localStorage.getItem(NAV_KEY);
    if (v && v in NAV_PRESETS) return v as NavPreset;
  } catch {
    /* storage unavailable (private window, blocked site data) */
  }
  return 'bambu';
}

/** UI-only state. Scene, mesh and paint data live in the engine/core, outside Vue reactivity. */
export const useUiStore = defineStore('ui', () => {
  const navPreset = ref<NavPreset>(loadNavPreset());
  const aboutOpen = ref(false);
  const updateAvailable = ref(false);
  let applyUpdate: (() => void) | null = null;
  const notices = ref<Notice[]>([]);
  let noticeId = 0;

  function dismiss(id: number) {
    notices.value = notices.value.filter((n) => n.id !== id);
  }

  /** Shows a toast. Info and warnings fade on their own; errors stay until dismissed. */
  function notify(kind: NoticeKind, text: string) {
    const id = ++noticeId;
    notices.value.push({ id, kind, text });
    if (kind !== 'error') setTimeout(() => dismiss(id), kind === 'warning' ? 10000 : 5000);
  }

  watch(navPreset, (v) => {
    try {
      localStorage.setItem(NAV_KEY, v);
    } catch {
      /* ignore */
    }
  });

  function setUpdateHandler(fn: () => void) {
    applyUpdate = fn;
    updateAvailable.value = true;
  }

  return {
    navPreset,
    aboutOpen,
    updateAvailable,
    setUpdateHandler,
    notices,
    notify,
    dismiss,
    update: () => applyUpdate?.(),
  };
});
