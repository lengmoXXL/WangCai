const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { _electron: electron } = require('playwright');

exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

const pluginDirectory = (home, id) => join(home, '.local/share/wangcai/plugins', id);

exports.launchApp = (home, env) => electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });

/**
 * The app loads only what init.ts lists, so a test that wants plugins writes the file first. An entry
 * without a source would be installed from the id's official repository, so here it names the directory
 * the mock plugins are written into instead.
 */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [], network } = lists ?? { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
  const list = (entries) => entries.map((item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    if (spec.repo || spec.directory) return JSON.stringify(spec);
    return JSON.stringify({ ...spec, directory: pluginDirectory(home, spec.id) });
  }).join(', ');
  const settings = network ? `network: ${JSON.stringify(network)}, ` : '';
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { ${settings}workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

/**
 * The app tests use mocks because the real plugins live in their own repositories.
 */
exports.mockPlugin = (home, id, { main = 'exports.activate = () => {};\n', ui, css } = {}) => {
  const directory = pluginDirectory(home, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'main.cjs'), main);
  if (ui !== undefined) writeFileSync(join(directory, 'ui.js'), ui);
  if (css !== undefined) writeFileSync(join(directory, 'ui.css'), css);
  return directory;
};

exports.mockView = (home, id, title) => exports.mockPlugin(home, id, {
  ui: `export const title = ${JSON.stringify(title)};
export function mount() {}
export function open(context) { context.host.tabs({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, mount: () => ({ dispose: () => {} }) }); }
`,
});

exports.mockWorkspace = (home) => exports.mockPlugin(home, 'terminal-agent', {
  main: `exports.activate = ({ ui, global }) => {
  const rows = [];
  ui.handle('workspaces', () => rows);
  ui.handle('workspace-menu', () => [{ key: 'local', label: '本机' }]);
  ui.handle('workspace-select', () => undefined);
  ui.handle('workspace-create', () => {
    const row = { id: \`w\${rows.length + 1}\`, label: '~', machine: 'local', running: true };
    rows.push(row);
    return { id: row.id };
  });
  ui.handle('workspace-rename', ({ id, name }) => {
    const row = rows.find((item) => item.id === id);
    if (row) row.label = name || '~';
  });
  // The plugin reads a workspace's state from a file it watches; the test sets it through this instead.
  ui.handle('agent-state', ({ id, status }) => {
    const row = rows.find((item) => item.id === id);
    if (row) row.status = status;
    return global.publish('workspaces', undefined);
  });
};
`,
});

exports.waitForShell = (page) => page.locator('.workspaces').waitFor();

exports.openWorkspaceMenu = (page) => page.locator('.workspace-header').click({ button: 'right' });

exports.newWorkspace = async (page) => {
  await exports.openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').last().waitFor();
};
