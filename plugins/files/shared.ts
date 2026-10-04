import type { Profile } from '@wangcai/sdk';
export type { FileClick } from '@wangcai/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
export type Settings = Profile & { font: Font };

