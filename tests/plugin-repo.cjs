const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * A plugin repository that needs no network: installing it runs the repository's own build script, which
 * copies the revision into the files the app loads, so a test can see whether a commit was rebuilt.
 * `buildDelay` keeps a build running, so a test can look at the app while one is under way.
 */
exports.makePluginRepo = (home, id, buildDelay = 0) => {
  const directory = join(home, `${id}-repository`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `wangcai-${id}`, private: true, scripts: { build: 'node build.mjs' } }, null, 2));
  writeFileSync(join(directory, 'revision.txt'), `${id} one\n`);
  writeFileSync(join(directory, 'build.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const revision = readFileSync(new URL('./revision.txt', import.meta.url), 'utf8').trim();
${buildDelay ? `await new Promise((done) => setTimeout(done, ${buildDelay}));` : ''}
writeFileSync(new URL('./main.cjs', import.meta.url), \`exports.activate = () => {};\\n// \${revision}\\n\`);
writeFileSync(new URL('./ui.js', import.meta.url), \`export function mount(container) { container.dataset.revision = '\${revision}'; }\\n\`);
`);
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Plugin Test');
  git('config', 'user.email', 'plugin@test.local');
  git('add', '.');
  git('commit', '-qm', `${id} one`);
  const commit = git('rev-parse', 'HEAD').trim();
  return {
    directory,
    commit,
    // A second commit, so a test can watch the app rebuild what moved.
    revise(text) {
      writeFileSync(join(directory, 'revision.txt'), `${text}\n`);
      git('add', '.');
      git('commit', '-qm', text);
      return git('rev-parse', 'HEAD').trim();
    },
  };
};
