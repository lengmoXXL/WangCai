const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require('playwright-core');

// Where the app keeps the agent it would download, relative to its own checkout.
const AGENT = 'wangcaicli/dist/debug/wangcai';

/**
 * The built app checkout, which runs in place and loads a plugin's files from where the case points init.ts.
 * WANGCAI_CHECKOUT names another, for a worktree of the app.
 */
const wangcaiApp = () => {
  const root = resolve(process.cwd(), process.env.WANGCAI_CHECKOUT ?? '../WangCai');
  const built = ['desktop/dist/main/index.js', 'desktop/node/bin/node', AGENT];
  if (!built.every((name) => existsSync(join(root, name)))) throw new Error(`build the WangCai checkout at ${root}`);
  return root;
};

/** A case gets its own home and none of the variables a dev run exports. */
const testEnv = (home) => {
  const env = { ...process.env, HOME: home, WANGCAI_HOME: '', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The agent Core would download is this checkout's, so no case needs a network for one.
  env.WANGCAI_AGENT_SOURCE = join(wangcaiApp(), AGENT);
  return env;
};

/**
 * Puts a Core where the app would have installed one, under `plugins` beside the clone it expects: a home without
 * one opens the window that installs a Core first, which is a clone and a build no case wants to wait for.
 * WANGCAI_CORE_SOURCE names another build.
 */
const installCore = (home) => {
  const storage = join(home, '.local/share/wangcai');
  const core = join(storage, 'plugins/core');
  const source = resolve(process.cwd(), process.env.WANGCAI_CORE_SOURCE ?? '../WangCai-Core');
  if (!existsSync(join(source, 'dist/main.cjs'))) throw new Error(`build the Core checkout at ${source}`);
  mkdirSync(core, { recursive: true });
  cpSync(join(source, 'dist'), join(core, 'dist'), { recursive: true });
  // What a Core reads of its own sources: the snapshot an agent is set up from.
  for (const entry of ['main', 'ui']) cpSync(join(source, entry), join(core, entry), { recursive: true });
};

/**
 * The app loads only what init.ts lists, so a case names the plugins and where to read them from: a sibling checkout
 * for an id alone, or whatever `directory` says.
 */
const writeInit = (home, lists) => {
  const { workspaces = [], tabs = [] } = lists ?? {};
  const entry = (item) => {
    const spec = typeof item === 'string' ? { id: item } : { ...item };
    if (!spec.directory) {
      spec.directory = resolve(process.cwd(), `../WangCai-${spec.id}`);
      if (!existsSync(join(spec.directory, 'main.cjs'))) throw new Error(`build the WangCai-${spec.id} checkout at ${spec.directory}`);
    }
    return JSON.stringify(spec);
  };
  const list = (entries) => entries.map(entry).join(', ');
  mkdirSync(join(home, '.config/wangcai'), { recursive: true });
  writeFileSync(join(home, '.config/wangcai/init.ts'), `export default { workspaces: [${list(workspaces)}], tabs: [${list(tabs)}] };\n`);
};

/** The homes a case has launched and not yet cleaned up. */
const running = new Set();

/**
 * The app the tests drive: the checkout's own Electron. The window never comes to the front, so a run does not take
 * the focus of whoever works at the machine.
 */
const launchApp = async (home, env) => {
  const app = wangcaiApp();
  const desktop = await electron.launch({
    executablePath: require(join(app, 'node_modules/electron')),
    args: [join(app, 'desktop'), '--unfocused', `--user-data-dir=${join(home, 'electron')}`],
    cwd: app,
    env,
  });
  // Steps here take seconds; a shorter default keeps a stuck run from holding the window on screen.
  desktop.context().setDefaultTimeout(15000);
  running.add(home);
  return desktop;
};

/** Tears a home down: the agent it started, the Electron on it, and the files themselves. */
const cleanup = (home) => {
  // The agent outlives the window that asked for it, so the home it ran on is what stops it here.
  const agent = join(wangcaiApp(), AGENT);
  try { execFileSync(agent, ['server', 'stop'], { env: testEnv(home), stdio: 'ignore', timeout: 15000 }); } catch {}
  try { execFileSync('pkill', ['-f', join(home, 'electron')]); } catch {}
  rmSync(home, { recursive: true, force: true });
  running.delete(home);
};

// A run that is interrupted never reaches its own teardown, so the windows it left are stopped here instead of being
// left for the next run to meet.
const stopAll = () => { for (const home of running) cleanup(home); };
process.once('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { stopAll(); process.exit(signal === 'SIGINT' ? 130 : 143); });
}

/**
 * A window that died under the case leaves its close waiting on a connection nothing answers, so a run gives it a
 * moment and then leaves the window to the teardown that stops it by hand.
 */
const closeWindow = async (desktop) => {
  await Promise.race([desktop.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10000))]);
};

/**
 * A wait is given time rather than attempts, since a loaded machine makes one attempt cost seconds. The answer that
 * ends the wait is the one it is judged by: asking again would read a state that moved on since.
 */
const until = async (holds, { act, timeout = 60000, interval = 250 } = {}) => {
  const deadline = Date.now() + timeout;
  let held = false;
  while (!(held = await holds()) && Date.now() < deadline) {
    if (act) await act();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  assert.ok(held, 'the app did not react');
};

/** The terminal of the workspace in front: the app's own pane, not a plugin's panel. */
const ACTIVE_TERMINAL = '.terminal-pane.active';
const activeTerminal = (page) => page.locator(ACTIVE_TERMINAL);

/** Opens the menu a workspace row offers, which is where a workspace is made or closed. */
const openWorkspaceMenu = (page) => page.locator('.workspace-header').click({ button: 'right' });

/** Types a line into the pane in front and runs it, the way a person does. */
const run = async (page, line) => {
  await activeTerminal(page).locator('.xterm-helper-textarea').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
};

/** Waits until the terminal in front draws that text, which it does once the shell has written it. */
const terminalShows = (page, text) => activeTerminal(page).locator('.xterm-screen').filter({ hasText: text }).waitFor();

/** Opens a local workspace, and waits for the shell its pane draws a moment after the workspace appears. */
const createWorkspace = async (page) => {
  await openWorkspaceMenu(page);
  await page.locator('#workspace-row-menu').getByRole('menuitem', { name: '新建 本机', exact: true }).click();
  await terminalShows(page, /\S/);
};

/** Opens a view in the sidebar, showing the sidebar first when it is off screen. */
const openView = async (page, name) => {
  const newTab = page.getByRole('button', { name: '新建侧栏标签页' });
  if (!(await newTab.isVisible())) await page.getByRole('button', { name: '切换右侧栏' }).click();
  await newTab.click();
  await page.locator('#view-menu').getByRole('button', { name, exact: true }).click();
};

/** The sidebar's tabs as the window draws them. */
const viewTabs = (page) => page.locator('.sidebar-tab:visible');

/** Closes the sidebar tab that is selected. */
const closeView = async (page) => page.locator('.sidebar-tab:has([aria-selected=true]) .close-tab').click();

/**
 * Runs the checkout's renderer from a dev server instead of the built bundle, so a window opened on this env shows the
 * app's renderer code as it is now. Returns what stops the server.
 */
const serveRenderer = async (env) => {
  const checkout = wangcaiApp();
  const { resolveConfig } = await import(pathToFileURL(require.resolve('electron-vite', { paths: [checkout] })).href);
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [checkout] })).href);
  const { config } = await resolveConfig({ root: join(checkout, 'desktop') }, 'serve');
  const server = await createServer({ ...config.renderer, configFile: false, server: { port: 0, host: '127.0.0.1' } });
  await server.listen();
  env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${server.httpServer.address().port}`;
  return () => server.close();
};

/**
 * One case on a home of its own: the Core and the plugins it lists, the windows opened on it, and the teardown that
 * follows whatever the body did. `open` may be called again, for what a case learns by launching a second window.
 * Only the windows see this home: the test process keeps its own, so cases may run beside each other.
 */
const withHome = async (prefix, lists, body) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  const env = testEnv(home);
  installCore(home);
  writeInit(home, lists);
  const windows = new Set();
  try {
    const open = async () => {
      const desktop = await launchApp(home, env);
      windows.add(desktop);
      const page = await desktop.firstWindow();
      const close = async () => { windows.delete(desktop); await closeWindow(desktop); };
      return { desktop, page, close };
    };
    return await body({ home, env, open });
  } finally {
    for (const desktop of windows) await closeWindow(desktop);
    cleanup(home);
  }
};

/** One case with a single window on it, which hands the body the page and whatever the page reported as errors. */
const withWindow = async (prefix, lists, body) => withHome(prefix, lists, async ({ home, env, open }) => {
  const { page } = await open();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return body({ home, env, page, errors });
});

module.exports = { wangcaiApp, activeTerminal, ACTIVE_TERMINAL, until, openWorkspaceMenu, serveRenderer, withHome, withWindow, openView, viewTabs, closeView, createWorkspace, terminalShows, run };
