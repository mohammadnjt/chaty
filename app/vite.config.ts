import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the Go server runs on :8080 and Vite proxies to it, so the app
// always talks to its own origin. Production builds go to web-build/, which
// the Go server serves (landing page at /, the app at /app/) and Nitron packs
// into the APK (index.html is the app).
const backend = process.env.CHATY_BACKEND ?? 'http://localhost:8080';
const root = fileURLToPath(new URL('.', import.meta.url));

// Gives each build's service worker a new version so clients drop old caches.
function stampServiceWorker(): Plugin {
  let outDir = '';
  return {
    name: 'chaty-sw-version',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const sw = resolve(outDir, 'sw.js');
      if (existsSync(sw)) writeFileSync(sw, readFileSync(sw, 'utf8').replace('__CHATY_BUILD__', Date.now().toString(36)));
    },
  };
}

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  server: {
    host: true,
    port: 5177,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/uploads': backend,
      '/download': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'web-build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(root, 'index.html'),
        landing: resolve(root, 'landing.html'),
      },
    },
  },
});
