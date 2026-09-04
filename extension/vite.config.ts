import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  plugins: [{
    name: 'browser-extension-manifest',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) }); },
  }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        background: fileURLToPath(new URL('src/background.ts', import.meta.url)),
        popup: fileURLToPath(new URL('popup.html', import.meta.url)),
      },
      output: { entryFileNames: '[name].js' },
    },
  },
});
