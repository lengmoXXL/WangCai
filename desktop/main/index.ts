import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contractVersion, corePageTopic, coreScheme, coreStatusTopic, fullscreenTopic, installStatusesTopic, link, pluginPageTopic, pluginScheme, previewScheme, type InstallStage } from '@lengmoxxl/sdk/bridge';
import { loadConfig } from './config';
import { coreDirectory, coreReady, installCore, loadCore, type CoreHost } from './core';
import { pluginInstaller } from './plugins';

// The app is a shell: it draws the window, installs the plugins init.ts lists, and is the only thing that can
// replace Core. What the window is made of, what a plugin is and where a workspace comes from all live in the
// Core it loads.
app.setName('旺财');
protocol.registerSchemesAsPrivileged([
  // The page the window draws comes out of one of these; Core answers for the other two.
  { scheme: coreScheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: pluginScheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: previewScheme, privileges: { standard: true, secure: true } },
]);
let window: BrowserWindow | undefined;
// A Core event can outlive the window that would show it.
const send = (topic: string, data?: unknown) => { if (window && !window.isDestroyed()) window.webContents.send(link.channel, topic, data); };

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
    // The node and the agent this app carries: packaged they sit among its resources, while a development run
    // uses this checkout's node and the agent built next to it.
    const node = app.isPackaged ? join(process.resourcesPath, 'node/bin/node') : join(app.getAppPath(), 'node/bin/node');
    const resourcesDirectory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../wangcaicli/dist/debug');
    // What init.ts holds is the app's to read: the theme of the window, how a run reaches the network, and the
    // plugins that have to be built before a Core can load them.
    const { profile, network, plugins: specs } = await loadConfig({ config: configDirectory, storage: storageDirectory });
    // What the window tells the page about its chrome, and what it is asked when a page loads again. Remembered
    // rather than read back from the window: the window a test runs never comes to the front, and the system
    // refuses to put that one in full screen at all.
    let fullscreen = false;
    let rebuilding = false;
    // Nothing about installing or replacing Core runs through Core: the app fetches the repository and builds it
    // with the Node it carries, and what it writes is read by a run that starts after it.
    const report = (stage: InstallStage, message?: string) => send(coreStatusTopic, { stage, message });
    const install = async (follow: boolean) => {
      send(corePageTopic);
      return await installCore({ storage: storageDirectory, node, network, report, follow });
    };
    const rebuild = async () => {
      if (rebuilding) return;
      rebuilding = true;
      try {
        const changed = await install(true);
        report('ready', changed ? '已重建，正在重启' : '已是最新');
        if (changed) { app.relaunch(); app.quit(); }
      } catch (error) {
        report('failed', error instanceof Error ? error.message : String(error));
      } finally {
        rebuilding = false;
      }
    };
    // The window is Core's to draw, so a Core that will not run is answered by the app itself: there is no menu
    // yet, and rebuilding it is the way back.
    const refuse = async (title: string, detail: string) => {
      const { response } = await dialog.showMessageBox({ type: 'error', message: title, detail, buttons: ['更新核心组件', '退出'], defaultId: 0, cancelId: 1 });
      if (response === 0) await rebuild();
      app.quit();
    };
    // A Core is not carried by the app: the run that finds none installs one before there is anything to load, and
    // what an install reports goes nowhere — no page of Core's is drawn yet, so a failure is the app's to answer.
    if (!coreReady(storageDirectory)) {
      try {
        await install(false);
      } catch (error) {
        await refuse('Core 安装失败', error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const directory = coreDirectory(storageDirectory);
    const core = await loadCore(directory).catch(async (error: Error) => {
      await refuse('Core 加载失败', error.message);
      return undefined;
    });
    if (!core) return;
    const installer = pluginInstaller(specs, {
      storage: storageDirectory, node, network,
      report: (statuses) => send(installStatusesTopic, statuses),
    });
    const host: CoreHost = {
      paths: { storage: storageDirectory, resources: resourcesDirectory },
      version: app.getVersion(),
      sources: app.isPackaged ? join(process.resourcesPath, 'src') : join(app.getAppPath(), '..'),
      config: { profile, network },
      plugins: installer.plugins,
      statuses: installer.statuses,
      install: installer.install,
      protocol: { handle: (scheme, handler) => protocol.handle(scheme, handler) },
      fetch: (url, options) => net.fetch(url, options),
      send,
      setProxy: (rules) => session.defaultSession.setProxy({ proxyRules: rules }).then(() => undefined),
      openExternal: async (url) => {
        // A plugin hands the app a link, not a program.
        const address = new URL(String(url));
        if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error(`Only http and https links open in a browser: ${url}`);
        await shell.openExternal(address.toString());
      },
      reload: () => window?.webContents.reload(),
      updateCore: rebuild,
      fullscreen: () => fullscreen,
    };
    const running = await core.activate(host).catch(async (error: Error) => {
      await refuse('Core 启动失败', error.message);
      return undefined;
    });
    if (!running) return;
    if (running.contract === undefined || running.contract < contractVersion) {
      await refuse('Core 版本过旧', `这个 Core 面向的契约是 ${running.contract ?? '更早的版本'}，当前是 ${contractVersion}。`);
      return;
    }
    // The page the window draws is Core's own bundle, out of the directory this run picked.
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
      backgroundColor: profile.theme.background, title: '旺财', titleBarStyle: 'hiddenInset',
      show: !unfocused, focusable: !unfocused,
      webPreferences: { preload: join(__dirname, '../preload/preload.js') },
    });
    window = win;
    if (unfocused) win.showInactive();
    win.on('enter-full-screen', () => { fullscreen = true; send(fullscreenTopic, true); });
    win.on('leave-full-screen', () => { fullscreen = false; send(fullscreenTopic, false); });
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
    // One name comes over the wire, and one table answers it: Core's, which the app only forwards to.
    ipcMain.handle(link.invoke, (_event, method: string, ...args: unknown[]) => running.dispatch(method, ...args));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '旺财', submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '更新核心组件', click: () => void rebuild() },
        { type: 'separator' },
        { role: 'quit' },
      ] },
      { label: '视图', submenu: [
        { label: '插件', click: () => send(pluginPageTopic) },
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
