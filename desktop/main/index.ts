import { app, BrowserWindow, ipcMain, Menu, net, protocol } from 'electron';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { loadPlugins } from './plugins';
import { homeDirectory, homeOverride, loadConfig, storageDirectory } from './config';
import { installPlugin } from './install';
import type { TabRecord } from '@wangcai/sdk/channel';
import { previewMessage, previewScheme, previewUrl, uiFont, type InstallStatus } from '../shared';

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
if (homeOverride) app.setPath('userData', join(homeDirectory, 'electron'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'));
    const { profile, plugins: specs } = await loadConfig();
    // The window opens before the plugins do: a plugin may have to be cloned and built first, and the
    // manager page reports each stage while it happens.
    mkdirSync(storageDirectory, { recursive: true });
    const installsPath = join(storageDirectory, 'installs.json');
    const node = app.isPackaged ? join(process.resourcesPath, 'node/bin/node') : join(app.getAppPath(), 'node/bin/node');
    const statuses: InstallStatus[] = specs.map(({ id }) => ({ id, stage: 'ready' }));
    const announce = (status: InstallStatus) => {
      statuses[statuses.findIndex((entry) => entry.id === status.id)] = status;
      send('wangcai:channel', 'install-statuses', statuses);
    };
    // Everything that needs a plugin waits for this.
    const loading = (async () => {
      const failed = new Set<string>();
      for (const spec of specs) {
        if (!spec.repo) continue;
        try {
          await installPlugin(spec, node, installsPath, (stage, message) => announce({ id: spec.id, stage, message }));
        } catch (error) {
          // A plugin that did not install is left out rather than activated from half a checkout: the rest
          // of the app runs without it, and the page says what went wrong.
          failed.add(spec.id);
          announce({ id: spec.id, stage: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      }
      return loadPlugins({
        sdkPath: require.resolve('@wangcai/sdk'),
        resourcesDirectory: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../wangcaicli/dist/debug'),
        agent: { version: app.getVersion(), prefix: profile.agent.downloadPrefix },
        profile,
        specs: specs.filter((spec) => !failed.has(spec.id)),
        broadcast: (event, data) => send('wangcai:channel', event, data),
      });
    })();
    // Serves a loaded plugin's files to the renderer; the directories exist once loading is done.
    protocol.handle('wangcai-plugin', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'plugins') return new Response('Not found', { status: 404 });
      const [, id, ...parts] = decodeURIComponent(url.pathname).split('/');
      const directory = (await loading).directories.get(id);
      if (!directory) return new Response('Not found', { status: 404 });
      const path = resolve(directory, parts.join('/'));
      const local = relative(directory, path);
      if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(path).toString());
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, { status: response.status, headers });
    });
    protocol.handle(previewScheme, (request) => request.url === previewUrl
      ? new Response(previewDocument(), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PREVIEW_CSP } })
      : new Response('Not found', { status: 404 }));
    ipcMain.handle('wangcai:publish', async (_, event: string, data: unknown) => (await loading).publish(event, data));
    ipcMain.handle('wangcai:plugins', async () => (await loading).plugins);
    ipcMain.handle('wangcai:request', async (_, id: string, method: string, params: unknown) => (await loading).request(id, method, params));
    ipcMain.handle('wangcai:config', () => profile);
    ipcMain.handle('wangcai:installs', () => statuses);
    const tabsPath = join(storageDirectory, 'tabs.json');
    ipcMain.handle('wangcai:tabs', () => existsSync(tabsPath) ? JSON.parse(readFileSync(tabsPath, 'utf8')) as TabRecord[] : []);
    ipcMain.handle('wangcai:save-tabs', (_: unknown, tabs: TabRecord[]) => {
      writeFileSync(`${tabsPath}.tmp`, JSON.stringify(tabs, null, 2));
      renameSync(`${tabsPath}.tmp`, tabsPath);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '旺财', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }, { type: 'separator' },
        { label: '插件', click: () => send('wangcai:channel', 'plugin-page') }] },
    ]));
    const statePath = join(storageDirectory, 'window-state.json');
    const { maximized, ...bounds } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { width: 1180, height: 780 };
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
      cleanup ??= loading.then((plugins) => plugins.dispose(), () => undefined).finally(() => { cleaned = true; app.quit(); });
    });
    if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await win.loadFile(join(__dirname, '../ui/index.html'));
  }).catch((error) => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
