import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
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
