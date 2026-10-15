// Renderer only, in a plain browser, backed by the mock API. Handy for fast UI work: npm run dev:web
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') } },
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
});
