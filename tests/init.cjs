const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { Module } = require('node:module');
const { join } = require('node:path');
const { buildSync } = require('esbuild');
const { _electron: electron } = require('playwright');
const { openWorkspaceMenu, until } = require('@lengmoxxl/wangcai-testkit');
const { coreScheme } = require('@lengmoxxl/sdk/bridge');

const root = join(__dirname, '..');

// Where the Core of a test run is: the app installs Core itself — it clones the repository and builds it into
// the data directory — so a case that found none would need a network and a build. A run reads the developer's
// checkout instead, and WANGCAI_CORE_SOURCE points it at another one.
const coreSource = process.env.WANGCAI_CORE_SOURCE ?? join(process.env.HOME ?? '', '.wangcai-dev/.local/share/wangcai/plugins/core');
const coreBuild = join(coreSource, 'dist');

// One module of a checkout here, compiled the way it runs: its own imports, bundled.
const compile = (file, resolveDir, contents, external) => {
  const compiled = new Module(file);
  const text = buildSync({ stdin: { contents, resolveDir, loader: 'ts' }, bundle: true, platform: 'node', target: 'node22', external, write: false }).outputFiles[0].text;
  compiled._compile(text, `${file}.cjs`);
  return compiled.exports;
};

// One module of the app's own, compiled the way the app runs it.
exports.appModule = (entry) => {
  const file = join(root, 'desktop', entry);
  return compile(file, join(root, 'desktop'), `export * from ${JSON.stringify(file)};`, ['electron', '@lengmoxxl/sdk']);
};

// One module of Core, compiled and loaded the way the app loads a whole Core: Core never imports electron, so a
// test only has to name the module it drives.
exports.coreModule = (entry) => {
  const file = join(coreSource, entry);
  return compile(file, coreSource, `export * from ${JSON.stringify(file)};`, ['bufferutil', 'utf-8-validate']);
};

// The agent release the Core under test drives, which its own agent.ts pins.
exports.agentVersion = readFileSync(join(coreSource, 'main/agent.ts'), 'utf8').match(/^const VERSION = '([^']+)';$/m)[1];

exports.testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The agent Core would install from a release is taken from this checkout instead, so a case needs no network.
  const agent = join(root, 'wangcaicli/dist/debug/wangcai');
  if (existsSync(agent)) env.WANGCAI_AGENT_SOURCE = agent;
  return env;
};

const pluginDirectory = (home, id) => join(home, '.local/share/wangcai/plugins', id);

// Puts the Core the app would have installed into a case's home: the developer's build, copied the way the app
// copies its own, with the sources the snapshot an agent reads is taken from.
exports.installCore = (home) => {
  if (!existsSync(join(coreBuild, 'main.cjs'))) throw new Error(`no Core build at ${coreBuild}: build the checkout at ${coreSource}, or point WANGCAI_CORE_SOURCE at one that is built`);
  const storage = join(home, '.local/share/wangcai');
  mkdirSync(storage, { recursive: true });
  const core = join(storage, 'plugins/core');
  mkdirSync(join(core, 'dist'), { recursive: true });
  cpSync(coreBuild, join(core, 'dist'), { recursive: true });
  for (const entry of ['main', 'ui']) cpSync(join(coreSource, entry), join(core, entry), { recursive: true });
};

exports.launchApp = (home, env, { installed = true } = {}) => {
  if (installed) exports.installCore(home);
  return electron.launch({ args: ['desktop', '--unfocused', `--user-data-dir=${join(home, 'electron')}`], env });
};

// The app installs what init.ts lists, so a test that wants plugins writes the file first. An entry
// without a source would be installed from the id's official repository, so here it names the directory
// the mock plugins are written into instead.
exports.writeInit = (home, lists) => {
  const { workspaces = [], tabs, network } = lists;
  const list = (entries) => entries.map((item) => {
    const spec = typeof item === 'string' ? { id: item } : item;
    if (spec.repo || spec.directory) return JSON.stringify(spec);
    return JSON.stringify({ ...spec, directory: pluginDirectory(home, spec.id) });
  }).join(', ');
  const settings = network ? `network: ${JSON.stringify(network)}, ` : '';
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { ${settings}workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

// These tests use mocks because the real plugins live in their own repositories.
exports.mockPlugin = (home, id, { main = 'exports.activate = () => {};\n', ui, css } = {}) => {
  const directory = pluginDirectory(home, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'main.cjs'), main);
  if (ui !== undefined) writeFileSync(join(directory, 'ui.js'), ui);
  if (css !== undefined) writeFileSync(join(directory, 'ui.css'), css);
  return directory;
};

exports.mockWorkspace = (home) => exports.mockPlugin(home, 'terminal-agent', {
  main: `exports.activate = ({ ui }) => {
  const rows = [];
  ui.handle('workspaces', () => rows);
  ui.handle('workspace-menu', () => [{ key: 'local', label: '本机' }]);
  // Core selects a row after it creates one and after a refresh, so this answers those calls where a mock has nothing to
  // select: a missing method only leaves an 'Unknown plugin method' on the console.
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
};
`,
});

exports.waitForShell = (page) => page.locator('.workspaces').waitFor();
// The window Core's page is drawn in: a start that has to install a Core says what it is doing in a window of its
// own first, so a case waits for the page rather than for the first window.
exports.coreWindow = async (desktop) => {
  const drawn = () => desktop.windows().find((page) => page.url().startsWith(`${coreScheme}://`));
  while (!drawn()) await desktop.waitForEvent('window');
  return drawn();
};

exports.newWorkspace = async (page) => {
  await openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await page.getByRole('tablist', { name: '工作区' }).getByRole('tab').last().waitFor();
};

// The workspace header's distance from the window's top: what the chrome above it takes.
exports.headerTop = (page) => page.locator('.workspace-header').evaluate((element) => Math.round(element.getBoundingClientRect().top));

// A test window belongs to an app that never comes to the front, which the system will not put in full screen, so
// the event the main process forwards is emitted instead, and what it leaves behind is waited for.
exports.setFullScreen = async (desktop, page, on) => {
  await desktop.evaluate(({ BrowserWindow }, enter) => {
    BrowserWindow.getAllWindows()[0].emit(enter ? 'enter-full-screen' : 'leave-full-screen');
  }, on);
  const padding = on ? '0px' : '36px';
  await until(async () => (await page.locator('.sidebar-left').evaluate((element) => getComputedStyle(element).paddingTop)) === padding);
};
