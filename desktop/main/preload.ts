import { contextBridge, ipcRenderer } from 'electron';
import type { PluginBridge } from '../shared';

const api: PluginBridge = {
  publish: (event, data) => ipcRenderer.invoke('wangcai:publish', event, data),
  subscribe: (event, callback) => {
    const listener = (_: unknown, name: string, data: unknown) => { if (name === event) void Promise.resolve().then(() => callback(data)).catch(console.error); };
    ipcRenderer.on('wangcai:channel', listener);
    return () => { ipcRenderer.removeListener('wangcai:channel', listener); };
  },
  plugins: () => ipcRenderer.invoke('wangcai:plugins'),
  config: () => ipcRenderer.invoke('wangcai:config'),
  request: (id, method, params) => ipcRenderer.invoke('wangcai:request', id, method, params),
  install: (ids) => ipcRenderer.invoke('wangcai:install', ids),
  installs: () => ipcRenderer.invoke('wangcai:installs'),
  loadTabs: () => ipcRenderer.invoke('wangcai:tabs'),
  saveTabs: (tabs) => ipcRenderer.invoke('wangcai:save-tabs', tabs),
  open: (url) => ipcRenderer.invoke('wangcai:open', url),
};
contextBridge.exposeInMainWorld('wangcai', api);
