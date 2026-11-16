import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the app from /printpainter/. CI sets PP_BASE for that build;
// local dev and a future custom domain use '/'.
const base = process.env.PP_BASE ?? '/';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
  plugins: [
    vue(),
    // generateSW for now. M8 switches to injectManifest so our service worker can
    // add COOP/COEP headers (cross-origin isolation for threaded WASM).
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'PrintPainter',
        short_name: 'PrintPainter',
        description: 'Paint filaments on 3D models and export slice-ready 3MF files.',
        theme_color: '#080808',
        background_color: '#080808',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        // The installed app opens .ppaint projects (handled through window.launchQueue).
        file_handlers: [{ action: './', accept: { 'application/x-printpainter-project': ['.ppaint'] } }],
        launch_handler: { client_mode: 'focus-existing' },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,wasm,txt,woff2}'],
        // occt-import-js.wasm is ~7.6 MB; precache it so STEP import works offline.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
});
