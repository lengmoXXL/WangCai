/** What puts the agent on an ssh machine, which the SDK calls before it connects to it. */
export type InstallAgent = (host: string, signal?: AbortSignal) => Promise<void>;

/**
 * The workspace protocol. A plugin that init.ts lists under `workspaces` is a workspace provider, and
 * the app drives it through these `ui` methods:
 *
 *   workspaces()              -> WorkspaceRow[]        one flat row per workspace, in draw order; the window may
 *                                                      draw rows under groups of its own, whose rows keep this order
 *   workspace-menu()          -> WorkspaceMenuItem[]   what the menu offers to open; an entry that carries
 *                                                      an error stays listed with its reason, and a click retries it
 *   workspace-create({ key }) -> { id: string }        the id of the workspace it made
 *   workspace-select({ id })
 *   workspace-close({ id })
 *   workspace-rename({ id, name })                     an empty name gives the workspace back to the name it followed
 *   workspace-move({ id, before? })
 *
 * Every view that follows the workspace in front shares these channel topics, whatever the provider
 * behind it is:
 *
 *   'workspaces'       a provider published that its rows changed
 *   'workspace:active' the workspace in front, or null; published by its provider
 *   'workspace:query'  a view asks for 'workspace:active' again
 */
/** What the agent in a workspace is doing, which the app draws at the right end of its row. */
export type WorkspaceStatus = 'idle' | 'working' | 'finished';
export interface WorkspaceRow { id: string; label: string; machine: string; running: boolean; status?: WorkspaceStatus }
export interface WorkspaceMenuItem { key: string; label: string; hint?: string; error?: string }
export interface Machine { id: string; name: string; host?: string; env?: Record<string, string> }
export interface WorkspaceActive {
  machine: Machine;
  sessionId: string;
  workspaceId: string;
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
/** What a session is created with: the directory its shell opens in, and what it is told besides the node's environment. */
export interface PtyOptions { cwd?: string; env?: Record<string, string> }
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
