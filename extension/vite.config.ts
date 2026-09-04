import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };
import sharp from 'sharp';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  plugins: [{
    name: 'browser-extension-manifest',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" rx="30" fill="#202a30"/><path d="m45 43-22 21 22 21m38-42 22 21-22 21" fill="none" stroke="#b9e8d7" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="m71 35-14 58" stroke="#e7e9ee" stroke-width="9" stroke-linecap="round"/></svg>';
      for (const size of [16, 32, 48, 128]) this.emitFile({ type: 'asset', fileName: `icon-${size}.png`, source: await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer() });
    },
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
