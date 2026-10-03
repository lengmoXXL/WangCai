import type { Profile } from '@wangcai/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
export type Settings = Profile & { font: Font };

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
