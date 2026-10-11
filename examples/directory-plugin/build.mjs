import { build } from 'esbuild';

await Promise.all([
  build({
    entryPoints: ['main.ts'], outfile: 'main.cjs',
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  }),
  build({
    entryPoints: ['ui.ts'], outfile: 'ui.js',
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  }),
]);
