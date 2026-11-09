import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { NAV_PRESETS, type NavPreset } from '@/engine/navigation';

const NAV_KEY = 'pp.navPreset';

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
    update: () => applyUpdate?.(),
  };
});
