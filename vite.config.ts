import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export default defineConfig({
  root: 'web',
  plugins: [react(), {
    name: 'compressed-web-assets',
    apply: 'build',
    writeBundle(options, bundle) {
      // Compress public assets once at build time, not on the relay's request path.
      for (const asset of Object.values(bundle)) {
        if (!/\.(?:js|css|svg)$/.test(asset.fileName)) continue;
        const file = resolve(options.dir!, asset.fileName);
        const source = readFileSync(file);
        if (source.length < 1024) continue;
        const variants = [
          ['gz', gzipSync(source, { level: 9 })],
          ['br', brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })],
        ] as const;
        for (const [extension, compressed] of variants) {
          if (compressed.length < source.length) {
            writeFileSync(`${file}.${extension}`, compressed);
          }
        }
      }
    },
  }],
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
