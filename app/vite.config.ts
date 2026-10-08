import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the Go server runs on :8080 and Vite proxies to it, so the app
// always talks to its own origin. Production builds go to web-build/, which
// the Go server serves and Nitron packs into the APK.
const backend = process.env.CHATY_BACKEND ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5177,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/uploads': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'web-build',
    emptyOutDir: true,
  },
});
