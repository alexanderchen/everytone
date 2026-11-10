import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  publicDir: false,
  server: {
    port: 3000,
    host: '0.0.0.0'
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022'
  },
  plugins: [
    {
      name: 'copy-static-media',
      closeBundle() {
        const outDir = path.resolve(rootDir, 'dist');
        for (const file of ['catalog.json', 'stage-atlas.jpg', 'stage-atlas.json']) {
          const src = path.resolve(rootDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.resolve(outDir, file));
          }
        }
        const samplesSrc = path.resolve(rootDir, 'samples');
        if (fs.existsSync(samplesSrc)) {
          fs.cpSync(samplesSrc, path.resolve(outDir, 'samples'), { recursive: true });
        }
      }
    }
  ]
});
