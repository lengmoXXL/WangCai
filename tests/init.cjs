const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** The app loads only what init.ts lists, so a test that wants plugins writes the file first. */
exports.writeInit = (home, ids) => {
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  const plugins = (ids ?? ['workspace', 'files', 'git', 'terminal']).map((id) => `{ id: ${JSON.stringify(id)} }`);
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { plugins: [${plugins.join(', ')}] };\n`);
};
