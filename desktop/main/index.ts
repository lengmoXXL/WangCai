import { app, BrowserWindow, ipcMain, Menu, net, protocol } from 'electron';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadPlugins } from './plugins';

app.setName('旺财');
protocol.registerSchemesAsPrivileged([{ scheme: 'wangcai-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let window: BrowserWindow | undefined;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    if (app.isPackaged) process.env.ESBUILD_BINARY_PATH = join(process.resourcesPath, `app.asar.unpacked/node_modules/@esbuild/darwin-${process.arch}/bin/esbuild`);
    const directory = join(homedir(), '.local/shared/wangcai/plugins');
    const bundled = app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), 'dist/plugins');
    for (const id of ['terminal', 'files']) {
      const target = join(directory, id);
      if (existsSync(target)) continue;
      mkdirSync(directory, { recursive: true });
      const staging = mkdtempSync(join(directory, `../.${id}-`));
      try {
        cpSync(join(bundled, id), staging, { recursive: true });
        renameSync(staging, target);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
    const plugins = await loadPlugins(require.resolve('@wangcai/sdk'),
      app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../wangcaicli/dist/debug'),
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
    ipcMain.handle('wangcai:publish', (_, event: string, data: unknown) => plugins.publish(event, data));
    ipcMain.handle('wangcai:plugins', () => plugins.plugins);
    ipcMain.handle('wangcai:request', (_, id: string, method: string, params: unknown) => plugins.request(id, method, params));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '旺财', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
    ]));
    window = new BrowserWindow({
      width: 1180, height: 780, minWidth: 740, minHeight: 460,
      backgroundColor: '#11151b', title: '旺财', titleBarStyle: 'hiddenInset',
      webPreferences: { preload: join(__dirname, '../preload/preload.js') },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('closed', () => { window = undefined; });
    let cleaned = false;
    let cleanup: Promise<void> | undefined;
    app.on('before-quit', (event) => {
      if (cleaned) return;
      event.preventDefault();
      cleanup ??= plugins.dispose().finally(() => { cleaned = true; app.quit(); });
    });
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(__dirname, '../ui/index.html'));
  }).catch((error) => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
