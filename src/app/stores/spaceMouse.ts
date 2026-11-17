import { defineStore } from 'pinia';
import { reactive, ref, shallowRef, watch } from 'vue';
import { BUTTON, SpaceMouseDevice, ZERO_AXES, webHidSupported, type Axes } from '@/engine/spaceMouse';
import { DEFAULT_SPACE_SETTINGS, isDeflected, SpaceNavigation, type SpaceSettings } from '@/engine/spaceNavigation';
import { getViewport } from '../engine';
import { usePaletteStore } from './palette';
import { useUiStore } from './ui';

const SETTINGS_KEY = 'pp.spaceMouse';
/** How long after the cap is released its driver may still send wheel events. */
const WHEEL_GRACE_MS = 250;

function loadSettings(): SpaceSettings {
  const s: SpaceSettings = { ...DEFAULT_SPACE_SETTINGS };
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<SpaceSettings> | null;
    if (v && typeof v === 'object') {
      for (const k of Object.keys(s) as (keyof SpaceSettings)[]) {
        if (typeof v[k] === typeof s[k]) (s as unknown as Record<string, unknown>)[k] = v[k];
      }
      s.speed = Math.min(4, Math.max(0.25, s.speed));
    }
  } catch {
    /* storage unavailable or bad JSON: defaults */
  }
  return s;
}

/** SpaceMouse connection, settings and button actions. */
export const useSpaceMouseStore = defineStore('spaceMouse', () => {
  const supported = webHidSupported();
  const device = supported ? new SpaceMouseDevice() : null;
  const nav = new SpaceNavigation(getViewport);
  const settings = reactive<SpaceSettings>(loadSettings());
  const connected = ref<string | null>(null);
  const error = ref('');
  const dialogOpen = ref(false);
  /** Live axis values, for the settings dialog (updated only while it is open). */
  const live = shallowRef<Axes>({ ...ZERO_AXES });
  const lastButton = ref<number | null>(null);
  let liveQueued = false;
  let held = 0;
  /** When the cap was last pushed (0: at rest). */
  let deflectedAt = 0;
  let deflected = false;

  nav.settings = { ...settings };
  watch(
    settings,
    (s) => {
      nav.settings = { ...s };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
    { deep: true },
  );

  if (device) {
    device.onChange = (name) => {
      connected.value = name;
      if (!name) held = 0;
    };
    device.onAxes = (a) => {
      // Small noise at rest mustn't block a real mouse wheel: only pushes and the release count.
      const now = isDeflected(a);
      if (now || deflected) deflectedAt = performance.now();
      deflected = now;
      nav.setAxes(a);
      if (dialogOpen.value && !liveQueued) {
        liveQueued = true;
        requestAnimationFrame(() => {
          liveQueued = false;
          live.value = { ...a };
        });
      }
    };
    device.onButtons = (mask) => {
      const pressed = mask & ~held;
      held = mask;
      if (!document.hasFocus()) return;
      for (let bit = 0; bit < 32; bit++) {
        if (pressed & (1 << bit)) {
          lastButton.value = bit;
          press(bit);
        }
      }
    };
  }

  // 3DxWare turns the cap into mouse-wheel scrolling for apps it doesn't know, and the
  // browser is one of them. Those wheel events would zoom the view in steps (the cursor
  // zoom) on top of our own smooth motion, so drop wheel input while the cap is pushed.
  if (device) {
    window.addEventListener(
      'wheel',
      (e) => {
        if (!connected.value) return;
        if (deflected || performance.now() - deflectedAt < WHEEL_GRACE_MS) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      { capture: true, passive: false },
    );
  }

  function press(bit: number) {
    const vp = getViewport();
    switch (bit) {
      case BUTTON.MENU:
        dialogOpen.value = !dialogOpen.value;
        break;
      case BUTTON.FIT:
        vp?.frame();
        break;
      case BUTTON.TOP:
        vp?.viewFrom('top');
        break;
      case BUTTON.FRONT:
        vp?.viewFrom('front');
        break;
      case BUTTON.RIGHT:
        vp?.viewFrom('right');
        break;
      case BUTTON.ROLL:
        vp?.turnView(Math.PI / 2);
        break;
      case BUTTON.ONE:
      case BUTTON.TWO:
      case BUTTON.THREE:
      case BUTTON.FOUR:
        usePaletteStore().select(bit - BUTTON.ONE + 1);
        break;
      case BUTTON.ESC:
        // Same as pressing Esc: cancels placing, closes Export, back to Select.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        break;
      case BUTTON.ROTATION:
        settings.lockRotation = !settings.lockRotation;
        useUiStore().notify('info', settings.lockRotation ? 'SpaceMouse: rotation locked (pan and zoom only).' : 'SpaceMouse: rotation unlocked.');
        break;
    }
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** Shows the browser's device picker (from a click). */
  async function connect() {
    error.value = '';
    try {
      await device?.request();
    } catch (e) {
      error.value = `Couldn't open the SpaceMouse: ${message(e)}`;
    }
  }

  async function disconnect() {
    error.value = '';
    await device?.forget();
  }

  /** Reconnects a SpaceMouse allowed on an earlier visit. */
  function start() {
    device?.reconnect().catch((e) => (error.value = `Couldn't open the SpaceMouse: ${message(e)}`));
  }

  function resetSettings() {
    Object.assign(settings, DEFAULT_SPACE_SETTINGS);
  }

  return { supported, connected, error, dialogOpen, settings, live, lastButton, connect, disconnect, start, resetSettings };
});
