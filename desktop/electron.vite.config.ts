import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: fileURLToPath(new URL('./dist/main', import.meta.url)), rollupOptions: { input: fileURLToPath(new URL('./main/index.ts', import.meta.url)) } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: fileURLToPath(new URL('./dist/preload', import.meta.url)), rollupOptions: { input: fileURLToPath(new URL('./main/preload.ts', import.meta.url)) } },
  },
  renderer: {
    root: fileURLToPath(new URL('./ui', import.meta.url)),
    plugins: [{
      name: 'development-csp',
      apply: 'serve',
      transformIndexHtml: (html) => html.replace('ws://localhost:*', 'ws://localhost:* ws://127.0.0.1:*'),
    }],
    build: { outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)), rollupOptions: { input: fileURLToPath(new URL('./ui/index.html', import.meta.url)) } },
  },
});
