import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import tauri from '../../apps/desktop/src-tauri/tauri.conf.json' with { type: 'json' };

/*
 * The version comes from the same file the installers and the APK read, so the
 * number in the corner of the window cannot claim to be a release that was
 * never built. Written into the bundle at build time — the interface runs in a
 * browser tab as well, where there is nothing to ask.
 */
const version = tauri.version;

/**
 * When developing for a phone, Tauri reports this machine's LAN address through
 * `TAURI_DEV_HOST`, because `localhost` on a phone means the phone itself.
 *
 * Binding to every interface happens **only then**. Without it the dev server
 * stays on `localhost` — being exposed to the network is a cost paid only by
 * someone actually developing for mobile.
 */
declare const process: { env: Record<string, string | undefined> };

const mobileHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 5273,
    strictPort: true,
    host: mobileHost ?? false,
    // HMR has to come back to the same machine; without this the phone looks for
    // a websocket on its own localhost and refreshing quietly stops working.
    hmr: mobileHost ? { protocol: 'ws', host: mobileHost, port: 5274 } : undefined,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // pdf.js ships its worker as a separate module; Vite has to see it.
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
});
