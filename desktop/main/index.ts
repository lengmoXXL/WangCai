import { execFile } from 'node:child_process';
import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from 'electron';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pluginManager } from './manager';
import { mirroredUrls } from './install';
import { homeOverride, loadConfig, storageDirectory, tabsPath, userDataDirectory, windowStatePath } from './config';
import type { TabRecord } from '@lengmoxxl/sdk/channel';
import { previewMessage, previewScheme, previewUrl, uiFont } from '../shared';

// Where the agent releases live: each one is under the tag of its own version.
const AGENT_RELEASES = 'https://github.com/lengmoXXL/WangCai/releases/download';
const exec = promisify(execFile);

/** The version of the agent this app carries, which is the release a machine installs it from. */
async function agentVersion(directory: string) {
  const { stdout } = await exec(join(directory, 'wangcai'), ['--version']);
  return stdout.trim().split(' ')[1];
}

app.setName('旺财');
protocol.registerSchemesAsPrivileged([
  { scheme: 'wangcai-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: previewScheme, privileges: { standard: true, secure: true } },
]);
// A previewed page is made of inline scripts and remote assets, which the renderer's CSP forbids; serving it
// from its own scheme gives it a policy of its own, and the sandboxed frame keeps the page off the app.
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https: data:; img-src http: https: data: blob:; font-src http: https: data:; connect-src http: https: data:; media-src http: https: data: blob:; frame-src http: https: data: blob:; base-uri 'none'";
// Writing the page into this document, rather than setting innerHTML, is what runs its scripts. The base font
// keeps an unstyled page readable next to the editor that the same file shows in source form; document.open()
// discards the document, so the style goes in afterwards and sits first, where the page's own rules override it.
const previewDocument = () => `<!doctype html><meta charset="utf-8"><script>parent.postMessage('${previewMessage}', '*'); addEventListener('message', (event) => { document.open(); document.write(event.data); document.close(); const base = document.createElement('style'); base.textContent = ${JSON.stringify(`html { font-family: ${uiFont}; font-size: 13px; line-height: 1.6; }`)}; document.head.prepend(base); });</script>`;
let window: BrowserWindow | undefined;
// A plugin event can outlive the window that would show it.
const send = (channel: string, ...args: unknown[]) => { if (window && !window.isDestroyed()) window.webContents.send(channel, ...args); };

// Electron keeps the instance lock in its user data, which an installed app is holding, so a
// development run takes its own.
if (homeOverride) app.setPath('userData', userDataDirectory);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'));
    const { profile, plugins: specs } = await loadConfig();
    // The window opens before the plugins do: a plugin may have to be cloned and built first, and the
    // manager page reports each stage while it happens.
    mkdirSync(storageDirectory, { recursive: true });
    const node = app.isPackaged ? join(process.resourcesPath, 'node/bin/node') : join(app.getAppPath(), 'node/bin/node');
    const resourcesDirectory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../wangcaicli/dist/debug');
    const manager = pluginManager({
      resourcesDirectory,
      agent: { version: await agentVersion(resourcesDirectory), prefixes: mirroredUrls(AGENT_RELEASES) },
      profile, specs, node,
      broadcast: (event, data) => send('wangcai:channel', event, data),
    });
    // Serves a loaded plugin's files to the renderer; the directories exist once loading is done.
    protocol.handle('wangcai-plugin', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'plugins') return new Response('Not found', { status: 404 });
      const [, id, ...parts] = decodeURIComponent(url.pathname).split('/');
      const directory = (await manager.loaded()).directories.get(id);
      if (!directory) return new Response('Not found', { status: 404 });
      const path = resolve(directory, parts.join('/'));
      const local = relative(directory, path);
      if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(path).toString());
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      // A plugin's files are read from disk, so nothing about them is worth keeping: a plugin that was
      // built again under the same URL is what the next load has to see.
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    });
    protocol.handle(previewScheme, (request) => request.url === previewUrl
      ? new Response(previewDocument(), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PREVIEW_CSP } })
      : new Response('Not found', { status: 404 }));
    ipcMain.handle('wangcai:publish', async (_, event: string, data: unknown) => (await manager.loaded()).publish(event, data));
    ipcMain.handle('wangcai:plugins', async () => (await manager.loaded()).plugins);
    ipcMain.handle('wangcai:request', async (_, id: string, method: string, params: unknown) => (await manager.loaded()).request(id, method, params));
    ipcMain.handle('wangcai:config', () => profile);
    ipcMain.handle('wangcai:installs', () => manager.statuses);
    // What the page's update and retry entries ask for.
    ipcMain.handle('wangcai:install', async (_, ids: string[]) => {
      if (await manager.update(ids)) window?.webContents.reload();
    });
    ipcMain.handle('wangcai:tabs', () => existsSync(tabsPath) ? JSON.parse(readFileSync(tabsPath, 'utf8')) as TabRecord[] : []);
    ipcMain.handle('wangcai:save-tabs', (_: unknown, tabs: TabRecord[]) => {
      writeFileSync(`${tabsPath}.tmp`, JSON.stringify(tabs, null, 2));
      renameSync(`${tabsPath}.tmp`, tabsPath);
    });
    // A plugin hands the app a link, not a program.
    ipcMain.handle('wangcai:open', (_: unknown, url: unknown) => {
      const address = new URL(String(url));
      if (address.protocol !== 'http:' && address.protocol !== 'https:') throw new Error(`Only http and https links open in a browser: ${url}`);
      return shell.openExternal(address.toString());
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '旺财', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }, { type: 'separator' },
        { label: '插件', click: () => send('wangcai:channel', 'plugin-page') }] },
    ]));
    const { maximized, ...bounds } = existsSync(windowStatePath) ? JSON.parse(readFileSync(windowStatePath, 'utf8')) : { width: 1180, height: 780 };
    const win = new BrowserWindow({
      ...bounds, minWidth: 740, minHeight: 460,
      backgroundColor: profile.theme.background, title: '旺财', titleBarStyle: 'hiddenInset',
      webPreferences: { preload: join(__dirname, '../preload/preload.js') },
    });
    window = win;
    win.on('enter-full-screen', () => send('wangcai:channel', 'fullscreen', true));
    win.on('leave-full-screen', () => send('wangcai:channel', 'fullscreen', false));
    if (maximized) win.maximize();
    win.on('close', () => {
      writeFileSync(`${windowStatePath}.tmp`, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
      renameSync(`${windowStatePath}.tmp`, windowStatePath);
    });
    win.on('closed', () => { window = undefined; });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    let cleaned = false;
    let cleanup: Promise<void> | undefined;
    app.on('before-quit', (event) => {
      if (cleaned) return;
      event.preventDefault();
      cleanup ??= manager.loaded().then((plugins) => plugins.dispose(), () => undefined).finally(() => { cleaned = true; app.quit(); });
    });
    if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await win.loadFile(join(__dirname, '../ui/index.html'));
  }).catch((error) => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
