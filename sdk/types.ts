export interface AgentInfo { version: string; prefix: string }
export type ConnectionOptions = { type: 'local'; binary?: string; signal?: AbortSignal } | { type: 'ssh'; host: string; agent?: AgentInfo; signal?: AbortSignal };
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
export interface ExecOptions { cwd: string; env?: Record<string, string> }
export interface ExecResult { stdout: Uint8Array; stderr: Uint8Array; code: number }
export interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  surface: string;
  overlay: string;
  border: string;
  muted: string;
  accent: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Profile {
  theme: Theme;
  agent: { downloadPrefix: string };
}
