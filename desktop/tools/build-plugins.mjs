import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './plugin-build.mjs';

rmSync(fileURLToPath(new URL('../dist/plugins/', import.meta.url)), { recursive: true, force: true });

// The plugins that ship with the app. init.ts decides which of them the app loads.
for (const id of ['workspace', 'files', 'terminal']) {
  await buildPlugin(
    fileURLToPath(new URL(`../../plugins/${id}/`, import.meta.url)),
    fileURLToPath(new URL(`../dist/plugins/${id}/`, import.meta.url)));
}
