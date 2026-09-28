export interface FileClick {
  type: 'file' | 'directory';
  machine: { id: string; name: string; host?: string };
  path: string;
  line?: number;
  column?: number;
}

export interface ActiveTerminal {
  machine: FileClick['machine'];
  sessionId: string;
  workspaceId?: string;
}
