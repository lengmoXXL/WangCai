import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridge, coreId, coreScheme, coreStatusTopic, pluginPageTopic, pluginScheme, previewScheme, type InstallStage } from '../../core/shared';
import type { Network } from '../../core/main/config';
import type { Core, CoreHost } from '../../core/main/host';
import { coreDirectory, loadCore, rebuildCore } from './core';

// The app is a shell: it draws the window, carries Core, and is the only thing that can replace it. What the
// window is made of, what a plugin is and where a workspace comes from all live in the Core it loads.
app.setName('旺财');
protocol.registerSchemesAsPrivileged([
  // The page the window draws comes out of one of these; Core answers for the other two.
  { scheme: coreScheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: pluginScheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: previewScheme, privileges: { standard: true, secure: true } },
]);
let window: BrowserWindow | undefined;
// A Core event can outlive the window that would show it.
const send = (channel: string, ...args: unknown[]) => { if (window && !window.isDestroyed()) window.webContents.send(channel, ...args); };

// Where this run keeps the files it writes. A development run can be pointed somewhere else, so it cannot
// change the files an installed app is using.
const homeOverride = process.env.WANGCAI_HOME || undefined;
const home = homeOverride ?? homedir();
const configDirectory = join(home, '.config/wangcai');
const storageDirectory = join(home, '.local/share/wangcai');
const userDataDirectory = join(home, 'electron');
const windowStatePath = join(storageDirectory, 'window-state.json');

// Electron keeps the instance lock in its user data, which an installed app is holding, so a development run
// takes its own.
if (homeOverride) app.setPath('userData', userDataDirectory);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'));
    // The tests launch the app with --unfocused, so that driving its window never takes the focus of whoever
    // works at the machine.
    const unfocused = process.argv.includes('--unfocused');
    // An unfocused window belongs to an app that never comes to the front, so it holds no dock icon either.
    if (unfocused) app.dock?.hide();
    const node = app.isPackaged ? join(process.resourcesPath, 'node/bin/node') : join(app.getAppPath(), 'node/bin/node');
    const resourcesDirectory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../wangcaicli/dist/debug');
    // Rebuilding Core is the shell's own business: a Core that will not load is exactly when it is needed, so
    // nothing about it runs through Core. The run after this one is what reads the result.
    let rebuilding = false;
    const rebuild = async (network: Network) => {
      if (rebuilding) return;
      rebuilding = true;
      const report = (stage: InstallStage, message?: string) => send(bridge.channel, coreStatusTopic, { id: coreId, stage, message });
      send(bridge.channel, pluginPageTopic);
      try {
        const changed = await rebuildCore({ storage: storageDirectory, node, network, report });
        report('ready', changed ? '已重建，正在重启' : '已是最新');
        if (changed) { app.relaunch(); app.quit(); }
      } catch (error) {
        report('failed', error instanceof Error ? error.message : String(error));
      } finally {
        rebuilding = false;
      }
    };
    const directory = coreDirectory({ packaged: app.isPackaged, storage: storageDirectory, app: app.getAppPath() });
    const core = await loadCore(directory).catch(async (error: Error) => {
      // The window is Core's to draw, so a Core that will not load is answered by the app itself: there is no
      // menu yet, and rebuilding it is the way back.
      const { response } = await dialog.showMessageBox({ type: 'error', message: 'Core 加载失败', detail: error.message, buttons: ['重建 Core', '退出'], defaultId: 0, cancelId: 1 });
      if (response === 0) await rebuild({});
      app.quit();
      return undefined;
    });
    if (!core) return;
    // Everything Electron owns is lent to Core here: it asks for the window, the session and the system, and
    // answers for the protocols and channels the window calls.
    const host: CoreHost = {
      paths: { config: configDirectory, storage: storageDirectory, resources: resourcesDirectory, node },
      version: app.getVersion(),
      sources: app.isPackaged ? join(process.resourcesPath, 'src') : join(app.getAppPath(), '..'),
      protocol: { handle: (scheme, handler) => protocol.handle(scheme, handler) },
      ipc: { handle: (channel, handler) => ipcMain.handle(channel, (_event, ...args) => handler(...args)) },
      fetch: (url, options) => net.fetch(url, options),
      send: (topic, data) => send(bridge.channel, topic, data),
      setProxy: (rules) => session.defaultSession.setProxy({ proxyRules: rules }).then(() => undefined),
      openExternal: async (url) => {
        // A plugin hands the app a link, not a program.
        const address = new URL(String(url));
        if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error(`Only http and https links open in a browser: ${url}`);
        await shell.openExternal(address.toString());
      },
      reload: () => window?.webContents.reload(),
      fullscreen: () => window?.isFullScreen() ?? false,
    };
    const running: Core = await core.activate(host);
    // The page the window draws is Core's own bundle, which only this run's directory holds: what a rebuilt
    // Core wrote is what the next start serves.
    const ui = join(directory, 'ui');
    protocol.handle(coreScheme, async (request) => {
      const url = new URL(request.url);
      const path = resolve(ui, decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html');
      const local = relative(ui, path);
      if (!local || local.startsWith(`..${sep}`) || isAbsolute(local)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(path).toString());
    });
    const { maximized, ...bounds } = existsSync(windowStatePath) ? JSON.parse(readFileSync(windowStatePath, 'utf8')) : { width: 1180, height: 780 };
    const win = new BrowserWindow({
      ...bounds, minWidth: 740, minHeight: 460,
      backgroundColor: running.background, title: '旺财', titleBarStyle: 'hiddenInset',
      show: !unfocused, focusable: !unfocused,
      webPreferences: { preload: join(__dirname, '../preload/preload.js') },
    });
    window = win;
    if (unfocused) win.showInactive();
    win.on('enter-full-screen', () => send(bridge.channel, 'fullscreen', true));
    win.on('leave-full-screen', () => send(bridge.channel, 'fullscreen', false));
    if (maximized) win.maximize();
    win.on('close', () => {
      writeFileSync(`${windowStatePath}.tmp`, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
      renameSync(`${windowStatePath}.tmp`, windowStatePath);
    });
    win.on('closed', () => { window = undefined; });
    // The menu bar holds no clipboard roles, so the app serves those shortcuts itself.
    const editing: Record<string, () => void> = {
      c: () => win.webContents.copy(),
      v: () => win.webContents.paste(),
      a: () => win.webContents.selectAll(),
    };
    win.webContents.on('before-input-event', (event, input) => {
      if (!input.meta || input.control || input.alt || input.type !== 'keyDown') return;
      const command = editing[input.key.toLowerCase()];
      if (!command) return;
      event.preventDefault();
      command();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '旺财', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '视图', submenu: [
        { label: '插件', click: () => send(bridge.channel, pluginPageTopic) },
        { label: '重建 Core', click: () => void rebuild(running.network) },
      ] },
    ]));
    let cleaned = false;
    let cleanup: Promise<void> | undefined;
    app.on('before-quit', (event) => {
      if (cleaned) return;
      event.preventDefault();
      cleanup ??= running.dispose().then(() => undefined, () => undefined).finally(() => { cleaned = true; app.quit(); });
    });
    await win.loadURL(`${coreScheme}://core/index.html`);
  }).catch((error) => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}