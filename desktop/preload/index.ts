import { contextBridge, ipcRenderer } from 'electron';
import type { MachineState, ShuAPI, TerminalEvent } from '../shared';

const api: ShuAPI = {
  config: () => ipcRenderer.invoke('shu:config'),
  saveMachine: (machine) => ipcRenderer.invoke('shu:save-machine', machine),
  removeMachine: (id) => ipcRenderer.invoke('shu:remove-machine', id),
  selectMachine: (id) => ipcRenderer.invoke('shu:select-machine', id),
  connect: (id) => ipcRenderer.invoke('shu:connect', id),
  disconnect: (id) => ipcRenderer.invoke('shu:disconnect', id),
  request: (id, op, params = {}) => ipcRenderer.invoke('shu:request', id, op, params),
  onState: (callback) => {
    const listener = (_: unknown, state: MachineState) => callback(state);
    ipcRenderer.on('shu:state', listener);
    return () => { ipcRenderer.removeListener('shu:state', listener); };
  },
  onTerminal: (callback) => {
    const listener = (_: unknown, event: TerminalEvent) => callback(event);
    ipcRenderer.on('shu:terminal', listener);
    return () => { ipcRenderer.removeListener('shu:terminal', listener); };
  },
};
contextBridge.exposeInMainWorld('shu', api);
