export interface AgentInfo { version: string; prefix: string }

/**
 * The workspace protocol. A plugin that init.ts lists under `workspaces` is a workspace provider, and
 * the app drives it through these `ui` methods:
 *
 *   workspaces()              -> WorkspaceRow[]        one flat row per workspace, in draw order
 *   workspace-menu()          -> WorkspaceMenuItem[]   what the menu offers to open; an entry that carries
 *                                                      an error stays listed but is not clickable
 *   workspace-create({ key }) -> { id: string }        the id of the workspace it made
 *   workspace-select({ id })
 *   workspace-close({ id })
 *   workspace-move({ id, before? })
 *
 * Every view that follows the workspace in front shares these channel topics, whatever the provider
 * behind it is:
 *
 *   'workspaces'       a provider published that its rows changed
 *   'workspace:active' the workspace in front, or null; published by its provider
 *   'workspace:query'  a view asks for 'workspace:active' again
 */
export interface WorkspaceRow { id: string; label: string; machine: string; running: boolean }
export interface WorkspaceMenuItem { key: string; label: string; hint?: string; error?: string }
export interface Machine { id: string; name: string; host?: string }
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
