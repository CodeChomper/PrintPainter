import type { Viewport } from '@/engine/Viewport';

// The engine lives outside Vue reactivity on purpose: three.js objects must never be
// wrapped in reactive proxies. UI code reaches it through this accessor.
let current: Viewport | null = null;

export function setViewport(v: Viewport | null): void {
  current = v;
}

export function getViewport(): Viewport | null {
  return current;
}
