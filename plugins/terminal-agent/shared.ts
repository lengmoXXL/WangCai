import type { MachineState as ConnectionState, Profile } from '@wangcai/sdk';
export type { Session } from '@wangcai/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type Settings = Profile & { font: Font };
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
export interface Config { workspaces: Workspace[]; active?: string }
export interface WangcaiAPI {
  click(machineId: string, sessionId: string, location: Pick<FileClick, 'path' | 'line' | 'column'>): Promise<void>;
  config(): Promise<Config>;
  states(): Promise<MachineState[]>;
  selectWorkspace(id: string): Promise<void>;
  pty(machineId: string, op: string, params?: Record<string, unknown>): Promise<unknown>;
  onConfig(callback: (config: Config) => void): () => void;
  onState(callback: (state: MachineState) => void): () => void;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
}
