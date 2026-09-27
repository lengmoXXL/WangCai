import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'desktop/main/index.ts' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'desktop/preload/index.ts' } },
  },
  renderer: {
    root: resolve('desktop/renderer'),
    plugins: [react(), {
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html
        .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        .replace('ws://localhost:*', 'ws://localhost:* ws://127.0.0.1:*'),
    }],
    build: { rollupOptions: { input: resolve('desktop/renderer/index.html') } },
  },
});
