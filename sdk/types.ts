/** What puts the agent on an ssh machine, which the SDK calls before it connects to it. */
export type InstallAgent = (host: string, signal?: AbortSignal) => Promise<void>;

/** What the agent in a workspace is doing, which the app draws at the right end of its row. */
export type WorkspaceStatus = 'idle' | 'working' | 'finished';
export interface WorkspaceRow { id: string; label: string; machine: string; running: boolean; status?: WorkspaceStatus }
export interface WorkspaceMenuItem { key: string; label: string; hint?: string; error?: string }
export interface Machine { id: string; name: string; host?: string; env?: Record<string, string> }
export interface WorkspaceActive {
  machine: Machine;
  sessionId: string;
  workspaceId: string;
  /** The workspace as the sidebar names it, for a view that has to title its own tabs. */
  name: string;
}
/** Where a click on a file or a directory points, as the 'onclick' topic carries it. */
export interface FileClick {
  type: 'file' | 'directory';
  machine: Machine;
  path: string;
  line?: number;
  column?: number;
}
export type ConnectionOptions =
  | { type: 'local'; binary?: string; env?: Record<string, string>; signal?: AbortSignal }
  | { type: 'ssh'; host: string; agent?: InstallAgent; env?: Record<string, string>; signal?: AbortSignal };
export interface Size { rows: number; cols: number }
/** What a session is created with: the directory its shell opens in, what it is told besides the node's environment, and the name it is shown under. */
export interface PtyOptions { cwd?: string; env?: Record<string, string>; label?: string }
export interface Session extends Size {
  id: string;
  title: string;
  label: string | null;
  pid: number;
  exit_code: number | null;
}
export interface MachineState {
  status: 'disconnected' | 'connecting' | 'connected';
  error?: string;
  sessions: Session[];
  generation: number;
}
export interface Output { data: Uint8Array; seq: number }
export interface Snapshot extends Output, Size {}
export type TerminalEvent = ({ event: 'snapshot' } & Snapshot | { event: 'output' } & Output) & { session_id: string };
export interface ProcessInfo { id: string; pid: number; exit_code: number | null }
/** `stream` names the pipe the bytes came from. */
export interface ProcessOutput extends Output { stream: 'stdout' | 'stderr' }
export type ProcessEvent =
  ({ event: 'stdout' | 'stderr' } & Output | { event: 'exit'; seq: number; code: number } | { event: 'lost' }) & { session_id: string };

export interface DirectoryEntry { name: string; isDirectory: boolean }
export interface FileChanges { created: string[]; modified: string[]; removed: string[] }
export interface WatchOptions { recursive?: boolean }
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

export interface Profile { theme: Theme }
