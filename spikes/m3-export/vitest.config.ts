import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Runs make.test.ts, which writes sample exports to spikes/m3-export/out/.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  test: { include: ['spikes/m3-export/make.test.ts'], environment: 'node', testTimeout: 120000 },
});
