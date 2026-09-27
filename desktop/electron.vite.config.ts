import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: fileURLToPath(new URL('./main/index.ts', import.meta.url)) } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: fileURLToPath(new URL('./preload/index.ts', import.meta.url)) } },
  },
  renderer: {
    root: fileURLToPath(new URL('./renderer', import.meta.url)),
    plugins: [{
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace('ws://localhost:*', 'ws://localhost:* ws://127.0.0.1:*'),
    }],
    build: { rollupOptions: { input: fileURLToPath(new URL('./renderer/index.html', import.meta.url)) } },
  },
});
