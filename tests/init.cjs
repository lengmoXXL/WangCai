const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { Module } = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { _electron: electron } = require('playwright');

const root = join(__dirname, '..');

/** One module of a checkout here, compiled the way it runs: its own imports, bundled. */
const compile = (file, resolveDir, contents, external) => {
  const compiled = new Module(file);
  const text = buildSync({ stdin: { contents, resolveDir, loader: 'ts' }, bundle: true, platform: 'node', target: 'node22', external, write: false }).outputFiles[0].text;
  compiled._compile(text, `${file}.cjs`);
  return compiled.exports;
};

/** One module of the app's own, compiled the way the app runs it. */
exports.appModule = (entry) => {
  const file = join(root, 'desktop', entry);
  return compile(file, join(root, 'desktop'), `export * from ${JSON.stringify(file)};`, ['electron', '@lengmoxxl/sdk']);
};

/**
 * One module of Core, compiled and loaded the way the app loads a whole Core: the paths of the run are set
 * before it starts. Core never imports electron, so a test only has to say where the run keeps its files.
 */
exports.coreModule = (entry, paths = {}) => {
  const file = join(root, entry);
  const contents = [
    `import { paths } from ${JSON.stringify(join(root, 'core/main/paths.ts'))};`,
    `Object.assign(paths, ${JSON.stringify(paths)});`,
    `export * from ${JSON.stringify(file)};`,
  ].join('\n');
  return compile(file, root, contents, ['bufferutil', 'utf-8-validate']);
};

exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

const pluginDirectory = (home, id) => join(home, '.local/share/wangcai/plugins', id);

exports.launchApp = (home, env) => electron.launch({ args: ['desktop', '--unfocused', `--user-data-dir=${join(home, 'electron')}`], env });

/**
 * The app installs what init.ts lists, so a test that wants plugins writes the file first. An entry
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

/** These tests use mocks because the real plugins live in their own repositories. */
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
  ui.handle('workspace-move', ({ id, before }) => {
    const at = rows.findIndex((row) => row.id === id);
    if (at < 0) return;
    const [row] = rows.splice(at, 1);
    const target = rows.findIndex((item) => item.id === before);
    if (target < 0) rows.push(row);
    else rows.splice(target, 0, row);
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

// A group is made from the row menu, named in the dialog it opens; the dialog opens on the name the group was made
// with, so typing a name is what names it.
exports.makeGroup = async (page, name) => {
  await exports.openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建分组', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名分组' });
  const input = dialog.getByRole('textbox');
  await input.fill(name);
  await input.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
};

// The order the row list draws: a group by its name, a row as 'row'.
exports.drawnOrder = (page) => page.locator('.workspaces').locator(':scope > :not(.workspace-line)').evaluateAll((nodes) => nodes.map((node) => node.classList.contains('workspace-group') ? node.querySelector('.workspace-group-bar .name').textContent : 'row'));

// The line under a group's bar, which is the first line the group holds.
exports.firstInsideLine = (group) => group.locator('.workspace-line').first();

// The line at an index among the row list's children.
const lineAt = (page, index) => page.locator(`.workspaces > :nth-child(${index + 1})`);

// The line in front of a group, by index into the groups as Array.prototype.at reads it: 0 is the first group and
// -1 the last. An index no group answers throws instead of pointing at nothing.
exports.lineBeforeGroup = async (page, index) => {
  const at = await page.locator('.workspaces').evaluate((list, which) => {
    const groups = [...list.children].filter((node) => node.classList.contains('workspace-group'));
    const group = groups.at(which);
    if (group === undefined) throw new Error(`no group at ${which}`);
    return [...list.children].indexOf(group) - 1;
  }, index);
  return lineAt(page, at);
};

// The line right after a row of the list: where a row dropped under that row would stand.
exports.lineAfter = async (page, row) => {
  const at = await row.evaluate((element) => [...element.parentElement.children].indexOf(element) + 1);
  return lineAt(page, at);
};

// The line right in front of a row of the list: the place a group dropped above that row would take.
exports.lineBefore = async (page, row) => {
  const at = await row.evaluate((element) => [...element.parentElement.children].indexOf(element) - 1);
  return lineAt(page, at);
};

// Where a line is dropped on: its own one pixel, a little in from the left edge.
exports.onLine = { x: 40, y: 0 };

// A launched app with three workspaces, and the locators the row list is read through.
exports.launchedWithThree = async () => {
  const home = mkdtempSync(join(tmpdir(), 'wangcai-lines-'));
  const env = exports.testEnv(home);
  exports.mockWorkspace(home);
  exports.writeInit(home, { workspaces: ['terminal-agent'], tabs: [] });
  const desktop = await exports.launchApp(home, env);
  const page = await desktop.firstWindow();
  await exports.waitForShell(page);
  for (const _ of [1, 2, 3]) await exports.newWorkspace(page);
  return { home, desktop, page, rows: page.locator('.workspaces > .workspace'), groups: page.locator('.workspace-group') };
};

// The ids of the workspaces a locator matches, in the order they are drawn.
exports.rowIds = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.dataset.workspace));

// The id of the first workspace a locator matches.
exports.rowId = (locator) => locator.first().evaluate((element) => element.dataset.workspace);
