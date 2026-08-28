import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/config.js': { target: 'http://127.0.0.1:3300' },
      '/ws': { target: 'ws://127.0.0.1:3300', ws: true },
    },
  },
});
