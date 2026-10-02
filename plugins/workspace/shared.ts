import type { MachineState as ConnectionState } from '@wangcai/sdk';
export type { Session } from '@wangcai/sdk';

export interface Machine { id: string; name: string; host?: string }
export interface FileClick {
  type: 'file' | 'directory';
  machine: Machine;
  path: string;
  line?: number;
  column?: number;
}
export interface Workspace { id: string; machineId: string; sessionId?: string; name?: string }
export interface MachineState extends ConnectionState { machineId: string }
export interface TerminalEvent {
  machineId: string;
  session_id: string;
  event: 'snapshot' | 'output';
  data: Uint8Array;
  seq: number;
  rows?: number;
  cols?: number;
}
export interface Config { machines: Machine[]; workspaces: Workspace[]; selected: string }
export interface WangcaiAPI {
  click(machineId: string, sessionId: string, location: Pick<FileClick, 'path' | 'line' | 'column'>): Promise<void>;
  config(): Promise<Config>;
  saveMachine(machine: { id?: string; name: string; host: string }): Promise<Config>;
  removeMachine(id: string): Promise<Config>;
  selectMachine(id: string): Promise<void>;
  connect(id: string): Promise<MachineState>;
  disconnect(id: string): Promise<void>;
  openWorkspace(machineId: string, workspaceId?: string): Promise<{ config: Config; workspaceId: string }>;
  closeWorkspace(id: string): Promise<Config>;
  moveWorkspace(id: string, before?: string): Promise<Config>;
  pty(machineId: string, op: string, params?: Record<string, unknown>): Promise<unknown>;
  onConfig(callback: (config: Config) => void): () => void;
  onState(callback: (state: MachineState) => void): () => void;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
}
