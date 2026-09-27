export type ConnectionOptions = { type: 'local'; binary?: string; signal?: AbortSignal } | { type: 'ssh'; host: string; signal?: AbortSignal };
export interface Size { rows: number; cols: number }
export interface Session extends Size { id: string; title: string; pid: number; exit_code: number | null }
export interface MachineState {
  status: 'disconnected' | 'connecting' | 'connected';
  error?: string;
  sessions: Session[];
  generation: number;
}
export interface Output { data: Uint8Array; seq: number }
export interface Snapshot extends Output, Size {}
export type TerminalEvent = ({ event: 'snapshot' } & Snapshot | { event: 'output' } & Output) & { session_id: string };

export interface DirectoryEntry { name: string; isDirectory: boolean }
