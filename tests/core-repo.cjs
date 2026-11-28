const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { contractVersion } = require('@lengmoxxl/sdk/bridge');

/**
 * A Core repository that needs no network: installing it runs the repository's own build script, which writes
 * the bundle a shell loads and the page its window draws, so a case can watch a start install a Core of its own
 * instead of the one this checkout develops against.
 */
exports.makeCoreRepo = (home) => {
  const directory = join(home, 'core-repository');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'wangcai-core', private: true, scripts: { build: 'node build.mjs' } }, null, 2));
  const main = `
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
exports.prepare = async ({ config: directory }) => {
  const { default: config } = await import(pathToFileURL(join(directory, 'init.ts')).href);
  return {
    network: {},
    plugins: [],
    activate: async () => ({
      contract: ${contractVersion},
      dispatch(method) {
        if (method === 'config') return { theme: { background: '#191a1b' } };
        if (method === 'test-config') return config;
      },
      dispose: async () => {},
    }),
  };
};
`;
  writeFileSync(join(directory, 'build.mjs'), [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    // The window a first start reports an install in goes away with the build, so the build waits a moment.
    "await new Promise((resolve) => setTimeout(resolve, 800));",
    "mkdirSync(new URL('./dist/ui/', import.meta.url), { recursive: true });",
    `writeFileSync(new URL('./dist/main.cjs', import.meta.url), ${JSON.stringify(main)});`,
    "writeFileSync(new URL('./dist/ui/index.html', import.meta.url), '<!doctype html><meta charset=\"utf-8\"><div id=\"core-marker\">a core of its own</div>\\n');",
  ].join('\n'));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Core Test');
  git('config', 'user.email', 'core@test.local');
  git('add', '.');
  git('commit', '-qm', 'core one');
  return { directory, commit: git('rev-parse', 'HEAD').trim() };
};
