import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./web/index.html', import.meta.url)),
        serviceWorker: fileURLToPath(new URL('./web/src/service-worker.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === 'serviceWorker'
          ? 'service-worker.js'
          : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/config.js': { target: 'http://127.0.0.1:3300' },
      '/ws': { target: 'ws://127.0.0.1:3300', ws: true },
    },
  },
});
