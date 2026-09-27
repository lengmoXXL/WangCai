import { contextBridge, ipcRenderer } from 'electron';
import type { PluginBridge } from '../shared';

const api: PluginBridge = {
  publish: (event, data) => ipcRenderer.invoke('shu:publish', event, data),
  subscribe: (event, callback) => {
    const listener = (_: unknown, name: string, data: unknown) => { if (name === event) void Promise.resolve().then(() => callback(data as never)).catch(console.error); };
    ipcRenderer.on('shu:channel', listener);
    return () => { ipcRenderer.removeListener('shu:channel', listener); };
  },
  plugins: () => ipcRenderer.invoke('shu:plugins'),
  request: (id, method, params) => ipcRenderer.invoke('shu:request', id, method, params),
  on: (callback) => {
    const listener = (_: unknown, id: string, event: string, data: unknown) => callback(id, event, data);
    ipcRenderer.on('shu:event', listener);
    return () => { ipcRenderer.removeListener('shu:event', listener); };
  },
};
contextBridge.exposeInMainWorld('shu', api);
