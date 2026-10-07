const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { _electron: electron } = require('playwright');

/** The environment a test runs the app in: its own home, and none of the variables a dev run exports. */
exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

/** Where an id's plugin directory lives: the entries init.ts holds and the mocks have to name the same one. */
const pluginDirectory = (home, id) => join(home, '.local/share/wangcai/plugins', id);

/** Launches the app on this home, in the checkout the tests run from. */
exports.launchApp = (home, env) => electron.launch({ args: ['desktop', `--user-data-dir=${join(home, 'electron')}`], env });

/**
 * The app loads only what init.ts lists, so a test that wants plugins writes the file first. An entry
 * without a source would be installed from the id's official repository, so here it names the directory
 * the mock plugins are written into instead.
 */
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? { workspaces: ['terminal-agent'], tabs: ['files', 'terminal'] };
  const list = (entries) => entries.map((item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    if (spec.repo || spec.directory) return JSON.stringify(spec);
    return JSON.stringify({ ...spec, directory: pluginDirectory(home, spec.id) });
  }).join(', ');
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

/**
 * A plugin without a repository, in the directory writeInit points an entry at. The app tests mock the
 * plugins they need this way rather than depend on the real ones, which live in their own repositories.
 */
exports.mockPlugin = (home, id, { main = 'exports.activate = () => {};\n', ui, css } = {}) => {
  const directory = pluginDirectory(home, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'main.cjs'), main);
  if (ui !== undefined) writeFileSync(join(directory, 'ui.js'), ui);
  if (css !== undefined) writeFileSync(join(directory, 'ui.css'), css);
  return directory;
};

/** A view plugin that only has to be listed: its menu entry and its tab are enough for the app's chrome. */
exports.mockView = (home, id, title) => exports.mockPlugin(home, id, {
  ui: `export const title = ${JSON.stringify(title)};
export function mount() {}
export function open(context) { context.host.tabs({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, mount: () => ({ dispose: () => {} }) }); }
`,
});

/** A workspace plugin: the window draws its rows, menu and tabs from what this one answers. */
exports.mockWorkspace = (home) => exports.mockPlugin(home, 'terminal-agent', {
  main: `exports.activate = ({ ui }) => {
  const rows = [];
  ui.handle('workspaces', () => rows);
  ui.handle('workspace-menu', () => [{ key: 'local', label: '本机' }]);
  ui.handle('workspace-select', () => undefined);
  ui.handle('workspace-create', () => {
    const row = { id: \`w\${rows.length + 1}\`, label: '~', machine: 'local', running: true };
    rows.push(row);
    return { id: row.id };
  });
};
`,
});

exports.waitForShell = (page) => page.locator('.workspaces').waitFor();

/** A right-click on the workspace heading opens the menu of machines a workspace can be opened on. */
exports.openWorkspaceMenu = (page) => page.locator('.workspace-header').click({ button: 'right' });

/** The list menu offers one entry per machine; picking the local one opens a workspace on it. */
exports.newWorkspace = async (page) => {
  await exports.openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '本机', exact: true }).click();
  await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').last().waitFor();
};
