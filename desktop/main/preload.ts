import { contextBridge, ipcRenderer } from 'electron';
import type { PluginBridge } from '../shared';

const api: PluginBridge = {
  publish: (event, data) => ipcRenderer.invoke('wangcai:publish', event, data),
  subscribe: (event, callback) => {
    const listener = (_: unknown, name: string, data: unknown) => { if (name === event) void Promise.resolve().then(() => callback(data as never)).catch(console.error); };
    ipcRenderer.on('wangcai:channel', listener);
    return () => { ipcRenderer.removeListener('wangcai:channel', listener); };
  },
  plugins: () => ipcRenderer.invoke('wangcai:plugins'),
  request: (id, method, params) => ipcRenderer.invoke('wangcai:request', id, method, params),
  on: (callback) => {
    const listener = (_: unknown, id: string, event: string, data: unknown) => callback(id, event, data);
    ipcRenderer.on('wangcai:event', listener);
    return () => { ipcRenderer.removeListener('wangcai:event', listener); };
  },
};
contextBridge.exposeInMainWorld('wangcai', api);
