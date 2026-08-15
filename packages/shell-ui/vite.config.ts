import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Kod razvoja za mobitel Tauri javlja LAN adresu ovog računala kroz
 * `TAURI_DEV_HOST`, jer `localhost` na telefonu znači sam telefon.
 *
 * Vezanje na sva sučelja se događa **samo tada**. Bez toga dev server ostaje
 * na `localhost` — izlaganje na mrežu je cijena koju plaća samo onaj tko
 * stvarno razvija za mobitel.
 */
declare const process: { env: Record<string, string | undefined> };

const mobileHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    host: mobileHost ?? false,
    // HMR mora natrag na isto računalo; bez ovoga telefon traži websocket
    // na vlastitom localhostu i osvježavanje tiho prestane raditi.
    hmr: mobileHost ? { protocol: 'ws', host: mobileHost, port: 5274 } : undefined,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // pdf.js isporučuje worker kao zaseban modul; Vite ga mora vidjeti.
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
});
