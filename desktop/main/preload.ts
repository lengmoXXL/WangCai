import { contextBridge, ipcRenderer } from 'electron';
import { link } from '../../core/shared';

// What the window Core draws is given: one method asked for by name, and one channel for the topics it publishes.
// Which methods exist is Core's business — this side only forwards.
contextBridge.exposeInMainWorld('wangcai', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke(link.invoke, method, ...args),
  subscribe: (event: string, callback: (data: unknown) => void) => {
    const listener = (_: unknown, name: string, data: unknown) => { if (name === event) void Promise.resolve().then(() => callback(data)).catch(console.error); };
    ipcRenderer.on(link.channel, listener);
    return () => { ipcRenderer.removeListener(link.channel, listener); };
  },
});
