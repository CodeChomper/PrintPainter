import { MOUSE } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type NavPreset = 'bambu' | 'blender' | 'substance';

export const NAV_PRESETS: Record<NavPreset, { label: string; hint: string }> = {
  bambu: {
    label: 'Bambu / Orca',
    hint: 'Left drag: rotate · Right or middle drag: pan · Wheel: zoom',
  },
  blender: {
    label: 'Blender',
    hint: 'Middle drag: rotate · Shift + middle drag: pan · Wheel: zoom',
  },
  substance: {
    label: 'Substance / Maya',
    hint: 'Alt + left: rotate · Alt + middle: pan · Alt + right: zoom · Wheel: zoom',
  },
};

type Buttons = OrbitControls['mouseButtons'];
const NONE: Buttons = { LEFT: null, MIDDLE: null, RIGHT: null };

/**
 * Applies a navigation preset to OrbitControls. Returns a cleanup function.
 *
 * Painting (M2) will claim the left button on the mesh; in the Bambu preset a left
 * drag that starts on empty space will still rotate, matching the slicers.
 */
export function applyNavPreset(controls: OrbitControls, preset: NavPreset): () => void {
  controls.zoomToCursor = true;
  controls.enableZoom = true;

  switch (preset) {
    case 'bambu':
      controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
      return () => {};

    case 'blender':
      // OrbitControls pans when Shift is held during a ROTATE drag.
      controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.ROTATE, RIGHT: null };
      return () => {};

    case 'substance': {
      // Mouse buttons only navigate while Alt is held; the wheel always zooms.
      const withAlt: Buttons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.DOLLY };
      controls.mouseButtons = { ...NONE };
      const set = (alt: boolean) => (controls.mouseButtons = alt ? { ...withAlt } : { ...NONE });
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Alt') {
          e.preventDefault(); // stop Alt from focusing the browser menu
          set(e.type === 'keydown');
        }
      };
      const onBlur = () => set(false);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      window.addEventListener('blur', onBlur);
      return () => {
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        window.removeEventListener('blur', onBlur);
      };
    }
  }
}
