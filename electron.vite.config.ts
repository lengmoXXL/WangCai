import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
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
    plugins: [{
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace('ws://localhost:*', 'ws://localhost:* ws://127.0.0.1:*'),
    }],
    build: { rollupOptions: { input: resolve('desktop/renderer/index.html') } },
  },
});
