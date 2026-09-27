import { build } from 'esbuild';
await build({ entryPoints: ['sdk/index.ts'], outfile: 'sdk/dist/index.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external' });
