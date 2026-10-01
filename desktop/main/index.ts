import { app, BrowserWindow, ipcMain, Menu, net, protocol } from 'electron';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadPlugins } from './plugins';
import { loadProfile } from './config';
import { previewMessage, previewScheme, previewUrl, type TabRecord } from '../shared';

app.setName('旺财');
protocol.registerSchemesAsPrivileged([
  { scheme: 'wangcai-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: previewScheme, privileges: { standard: true, secure: true } },
]);
// A previewed page is made of inline scripts and remote assets, which the renderer's CSP forbids; serving it
// from its own scheme gives it a policy of its own, and the sandboxed frame keeps the page off the app.
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https: data:; img-src http: https: data: blob:; font-src http: https: data:; connect-src http: https: data:; media-src http: https: data: blob:; frame-src http: https: data: blob:; base-uri 'none'";
// Writing the page into this document, rather than setting innerHTML, is what runs its scripts.
const PREVIEW_DOCUMENT = `<!doctype html><meta charset="utf-8"><script>parent.postMessage('${previewMessage}', '*'); addEventListener('message', (event) => { document.open(); document.write(event.data); document.close(); });</script>`;
let window: BrowserWindow | undefined;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'));
    if (app.isPackaged) process.env.ESBUILD_BINARY_PATH = join(process.resourcesPath, `app.asar.unpacked/node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`);
    const directory = join(homedir(), '.local/shared/wangcai/plugins');
    const bundled = app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'dist/plugins');
    for (const id of ['workspace', 'files', 'git', 'terminal']) {
      const target = join(directory, id);
      if (existsSync(target)) continue;
      mkdirSync(directory, { recursive: true });
      const staging = mkdtempSync(join(directory, `../.${id}-`));
      try {
        cpSync(join(bundled, id), staging, { recursive: true });
        renameSync(staging, target);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
    const profile = await loadProfile();
    const plugins = await loadPlugins(require.resolve('@wangcai/sdk'),
      app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../wangcaicli/dist/debug'),
      profile,
      (id, event, data) => { if (window && !window.isDestroyed()) window.webContents.send('wangcai:event', id, event, data); },
      (event, data) => { if (window && !window.isDestroyed()) window.webContents.send('wangcai:channel', event, data); });
    protocol.handle('wangcai-plugin', async (request) => {
      const url = new URL(request.url);
      const path = resolve(plugins.cache, `.${decodeURIComponent(url.pathname)}`);
      const local = relative(plugins.cache, path);
      if (url.host !== 'plugins' || !local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(path).toString());
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, { status: response.status, headers });
    });
    protocol.handle(previewScheme, (request) => request.url === previewUrl
      ? new Response(PREVIEW_DOCUMENT, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PREVIEW_CSP } })
      : new Response('Not found', { status: 404 }));
    ipcMain.handle('wangcai:publish', (_, event: string, data: unknown) => plugins.publish(event, data));
    ipcMain.handle('wangcai:plugins', () => plugins.plugins);
    ipcMain.handle('wangcai:request', (_, id: string, method: string, params: unknown) => plugins.request(id, method, params));
    ipcMain.handle('wangcai:config', () => profile);
    const tabsPath = join(app.getPath('userData'), 'tabs.json');
    ipcMain.handle('wangcai:tabs', () => existsSync(tabsPath) ? JSON.parse(readFileSync(tabsPath, 'utf8')) as TabRecord[] : []);
    ipcMain.handle('wangcai:save-tabs', (_: unknown, tabs: TabRecord[]) => {
      writeFileSync(`${tabsPath}.tmp`, JSON.stringify(tabs, null, 2));
      renameSync(`${tabsPath}.tmp`, tabsPath);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '旺财', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
    ]));
    const statePath = join(app.getPath('userData'), 'window-state.json');
    const { maximized, ...bounds } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { width: 1180, height: 780 };
    const win = new BrowserWindow({
      ...bounds, minWidth: 740, minHeight: 460,
      backgroundColor: profile.theme.background, title: '旺财', titleBarStyle: 'hiddenInset',
      webPreferences: { preload: join(__dirname, '../preload/preload.js') },
    });
    window = win;
    if (maximized) win.maximize();
    win.on('close', () => {
      writeFileSync(`${statePath}.tmp`, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
      renameSync(`${statePath}.tmp`, statePath);
    });
    win.on('closed', () => { window = undefined; });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    let cleaned = false;
    let cleanup: Promise<void> | undefined;
    app.on('before-quit', (event) => {
      if (cleaned) return;
      event.preventDefault();
      cleanup ??= plugins.dispose().finally(() => { cleaned = true; app.quit(); });
    });
    if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await win.loadFile(join(__dirname, '../ui/index.html'));
  }).catch((error) => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
