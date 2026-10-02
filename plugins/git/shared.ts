export interface ActiveTerminal {
  machine: { id: string; name: string; host?: string };
  sessionId: string;
  workspaceId?: string;
}

export interface GitFile { path: string; oldPath?: string; status: string }
export type Stage = 'staged' | 'unstaged' | 'untracked' | 'conflicted';
export interface Change extends GitFile { stage: Stage }
export interface Commit { sha: string; author: string; time: number; subject: string; refs: string[] }
export interface History { commits: Commit[]; hasMore: boolean }
export interface Overview extends History {
  root: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  head: string;
  changes: Change[];
  truncated: boolean;
}
export interface Comparison extends GitFile { source: Stage | 'commit'; rev?: string }
export interface Diff { oldText: string; newText: string; notice?: string }
export interface GitRequest {
  terminal: ActiveTerminal;
  root?: string;
  head?: string;
  skip?: number;
  rev?: string;
  comparison?: Comparison;
}
