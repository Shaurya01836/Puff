import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages ship TypeScript source, so they must be bundled rather than externalized.
const bundleWorkspace = {
  externalizeDeps: { exclude: ['@puff/shared', '@puff/core', '@puff/mcp'] },
};

export default defineConfig({
  main: { build: bundleWorkspace },
  preload: { build: bundleWorkspace },
  renderer: {
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
});
