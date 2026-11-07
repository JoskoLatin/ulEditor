import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import tauri from '../../apps/desktop/src-tauri/tauri.conf.json' with { type: 'json' };
import { serviceWorker } from './sw/plugin';

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

/**
 * Whether Tauri is building a debug build: `tauri build --debug` and `tauri
 * android build --debug` run `beforeBuildCommand` with `TAURI_ENV_DEBUG=true`,
 * a release build without it (tauri-cli 2.11.4, measured on `tauri build`).
 *
 * The phone's own shell starts in a debug build only until Arak passes K6
 * (ADR 0009), and this is how the page knows. Vite builds the interface in its
 * production mode either way, so `import.meta.env.DEV` is `false` in a debug
 * APK too and cannot tell. Written into the bundle as a constant rather than
 * exposed through `envPrefix`: one boolean is all the page needs, and with
 * `false` written in, a release build drops the mobile shell's code entirely.
 */
const tauriDebug = process.env.TAURI_ENV_DEBUG === 'true';

export default defineConfig({
  plugins: [react(), serviceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __TAURI_DEBUG__: JSON.stringify(tauriDebug),
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
