import { contextBridge, ipcRenderer } from 'electron';
import type { PluginBridge } from '../shared';

const api: PluginBridge = {
  plugins: () => ipcRenderer.invoke('shu:plugins'),
  request: (id, method, params) => ipcRenderer.invoke('shu:request', id, method, params),
  on: (callback) => {
    const listener = (_: unknown, id: string, event: string, data: unknown) => callback(id, event, data);
    ipcRenderer.on('shu:event', listener);
    return () => { ipcRenderer.removeListener('shu:event', listener); };
  },
};
contextBridge.exposeInMainWorld('shu', api);
