const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** The app loads only what init.ts lists, so a test that wants plugins writes the file first. */
exports.writeInit = (home, entries) => {
  const plugins = (entries ?? ['workspace', 'files', 'git', 'terminal'])
    .map((entry) => JSON.stringify(typeof entry === 'string' ? { id: entry } : entry));
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { plugins: [${plugins.join(', ')}] };\n`);
};
