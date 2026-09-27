import type { FileClick } from '@wangcai/sdk/plugin';
import type { MachineState as ConnectionState } from '@wangcai/sdk';
export interface Machine { id: string; name: string; host?: string }
export type { Session } from '@wangcai/sdk';
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
export interface Config { machines: Machine[]; selected: string }
export interface WangcaiAPI {
  click(machineId: string, sessionId: string, location: Pick<FileClick, 'path' | 'line' | 'column'>): Promise<void>;
  config(): Promise<Config>;
  saveMachine(machine: { id?: string; name: string; host: string }): Promise<Config>;
  removeMachine(id: string): Promise<Config>;
  selectMachine(id: string): Promise<void>;
  connect(id: string): Promise<MachineState>;
  disconnect(id: string): Promise<void>;
  request(machineId: string, op: string, params?: Record<string, unknown>): Promise<unknown>;
  onState(callback: (state: MachineState) => void): () => void;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
}
