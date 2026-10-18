import { contextBridge, ipcRenderer } from 'electron';
import { bridge, type PluginBridge } from '../../core/shared';

const api: PluginBridge = {
  publish: (event, data) => ipcRenderer.invoke(bridge.publish, event, data),
  subscribe: (event, callback) => {
    const listener = (_: unknown, name: string, data: unknown) => { if (name === event) void Promise.resolve().then(() => callback(data)).catch(console.error); };
    ipcRenderer.on(bridge.channel, listener);
    return () => { ipcRenderer.removeListener(bridge.channel, listener); };
  },
  plugins: () => ipcRenderer.invoke(bridge.plugins),
  config: () => ipcRenderer.invoke(bridge.config),
  fullscreen: () => ipcRenderer.invoke(bridge.fullscreen),
  request: (id, method, params) => ipcRenderer.invoke(bridge.request, id, method, params),
  install: (ids) => ipcRenderer.invoke(bridge.install, ids),
  installs: () => ipcRenderer.invoke(bridge.installs),
  loadTabs: () => ipcRenderer.invoke(bridge.loadTabs),
  saveTabs: (tabs) => ipcRenderer.invoke(bridge.saveTabs, tabs),
  loadGroups: () => ipcRenderer.invoke(bridge.loadGroups),
  saveGroups: (groups) => ipcRenderer.invoke(bridge.saveGroups, groups),
  open: (url) => ipcRenderer.invoke(bridge.open, url),
};
contextBridge.exposeInMainWorld('wangcai', api);