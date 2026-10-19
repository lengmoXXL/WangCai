import { defineConfig } from 'electron-vite';
import { fileURLToPath } from 'node:url';

// The app builds a window and a bridge; the page it draws is Core's, built by its own repository. The SDK is
// the one dependency that goes into the bundles: the bridge both sides share has to be there when the app is
// packaged, and the app carries no `node_modules`.
const bridge = { externalizeDeps: { exclude: ['@lengmoxxl/sdk'] } };

export default defineConfig({
  main: {
    build: {
      outDir: fileURLToPath(new URL('./dist/main', import.meta.url)),
      rollupOptions: { input: fileURLToPath(new URL('./main/index.ts', import.meta.url)) },
      ...bridge,
    },
  },
  preload: {
    build: {
      outDir: fileURLToPath(new URL('./dist/preload', import.meta.url)),
      rollupOptions: { input: fileURLToPath(new URL('./main/preload.ts', import.meta.url)) },
      ...bridge,
    },
  },
});