import type { Profile } from '@wangcai/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type Settings = Profile & { font: Font };

export interface Machine { id: string; name: string; host?: string }
export interface ActiveTerminal { machine: Machine; sessionId: string; workspaceId?: string }
export interface TerminalRef { machine: Machine; sessionId: string; label: string }
