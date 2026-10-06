import type { Profile } from '@wangcai/sdk';
export type { FileClick } from '@wangcai/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight?: number };
export type Settings = Profile & { font: Font };

// Chromium renders these straight from a data URL.
const imageTypes: Record<string, string> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
};
export const imageMime = (path: string) => imageTypes[path.split('.').pop()?.toLowerCase() ?? ''];
