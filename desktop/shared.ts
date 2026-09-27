export interface Machine { id: string; name: string; host?: string }
export interface Session { id: string; title: string; pid: number; rows: number; cols: number; exit_code: number | null }
export interface MachineState {
  machineId: string;
  status: 'disconnected' | 'connecting' | 'connected';
  error?: string;
  sessions: Session[];
  generation: number;
}
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
export interface ShuAPI {
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
declare global { interface Window { shu: ShuAPI } }
