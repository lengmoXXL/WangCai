import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NodeConnection } from './connection';
import type { Config, Machine } from '../shared';

app.setName('shū');
const connections = new Map<string, NodeConnection>();
const directory = join(homedir(), '.config', 'shu');
const path = join(directory, 'desktop.json');
let config: Config = { machines: [{ id: 'local', name: '本机' }], selected: 'local' };
let window: BrowserWindow | undefined;

function save() {
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(config, null, 2));
  renameSync(`${path}.tmp`, path);
}

function connection(id: string) {
  const machine = config.machines.find((machine) => machine.id === id);
  if (!machine) throw new Error('Unknown machine');
  let connection = connections.get(id);
  if (!connection) {
    const binary = app.isPackaged ? join(process.resourcesPath, 'shu')
      : join(app.getAppPath(), 'target', 'debug', 'shu');
    connection = new NodeConnection(machine, binary,
      (state) => { if (window && !window.isDestroyed()) window.webContents.send('shu:state', state); },
      (event) => { if (window && !window.isDestroyed()) window.webContents.send('shu:terminal', event); },
    );
    connections.set(id, connection);
  }
  return connection;
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180, height: 780, minWidth: 740, minHeight: 460,
    backgroundColor: '#11151b', title: 'shū', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => {
    for (const connection of connections.values()) connection.stop();
    connections.clear();
    window = undefined;
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(() => {
    if (existsSync(path)) {
      try {
        const stored = JSON.parse(readFileSync(path, 'utf8')) as Config;
        const machines: Machine[] = [{ id: 'local', name: '本机' }];
        for (const machine of stored.machines) {
          if (machine.id !== 'local' && machine.name && typeof machine.host === 'string' && /^[\w.@:+-]+$/.test(machine.host) && !machine.host.startsWith('-')) machines.push(machine);
        }
        config = { machines, selected: machines.some((m) => m.id === stored.selected) ? stored.selected : 'local' };
      } catch (error) { console.error('Unable to load machine configuration:', error); }
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'shū', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
    ]));
    ipcMain.handle('shu:config', () => config);
    ipcMain.handle('shu:save-machine', (_, machine: { id?: string; name: string; host: string }) => {
      if (machine.id === 'local') throw new Error('The local machine cannot be edited.');
      const name = machine.name.trim();
      const host = machine.host.trim();
      if (!name || !/^[\w.@:+-]+$/.test(host) || host.startsWith('-')) throw new Error('请输入名称和有效的 SSH Host，例如 dev-server 或 user@host。');
      const id = machine.id ?? randomUUID();
      connections.get(id)?.stop();
      connections.delete(id);
      const entry = { id, name, host };
      const index = config.machines.findIndex((item) => item.id === id);
      if (index < 0) config.machines.push(entry); else config.machines[index] = entry;
      save();
      return config;
    });
    ipcMain.handle('shu:remove-machine', (_, id: string) => {
      if (id === 'local') throw new Error('The local machine cannot be removed.');
      connections.get(id)?.stop();
      connections.delete(id);
      config.machines = config.machines.filter((machine) => machine.id !== id);
      if (config.selected === id) config.selected = 'local';
      save();
      return config;
    });
    ipcMain.handle('shu:select-machine', (_, id: string) => {
      if (!config.machines.some((m) => m.id === id)) throw new Error('Unknown machine');
      config.selected = id;
      save();
    });
    ipcMain.handle('shu:connect', (_, id: string) => { const node = connection(id); node.start(); return node.state; });
    ipcMain.handle('shu:disconnect', (_, id: string) => { connections.get(id)?.stop(); });
    ipcMain.handle('shu:request', (_, id: string, op: string, params: Record<string, unknown>) => {
      if (!['list', 'create', 'attach', 'detach', 'input', 'resize', 'close'].includes(op)) throw new Error('Unsupported operation');
      return connection(id).request(op, params);
    });
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('before-quit', () => { for (const connection of connections.values()) connection.stop(); });
  app.on('window-all-closed', () => app.quit());
}
