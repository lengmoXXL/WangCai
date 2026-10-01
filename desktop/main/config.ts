import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Profile, Theme } from '@wangcai/sdk';

const DEFAULT_PROFILE: Profile = {
  font: {
    ui: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
    terminal: { family: '"SFMono-Regular", Menlo, Monaco, monospace', size: 13, lineHeight: 1 },
  },
  theme: {
    background: '#0b0e13',
    foreground: '#dce3eb',
    cursor: '#9bc7bc',
    selection: '#35534e',
    surface: '#161b22',
    overlay: '#202730',
    border: '#252c35',
    muted: '#8b98a6',
    accent: '#9bc7bc',
    black: '#26303a',
    red: '#e68c8c',
    green: '#9bc7bc',
    yellow: '#e4c590',
    blue: '#86a9de',
    magenta: '#c8a2d8',
    cyan: '#8fc7c7',
    white: '#d9e0e9',
    brightBlack: '#3b4650',
    brightRed: '#f0a8a8',
    brightGreen: '#b8ddd3',
    brightYellow: '#f0d5a6',
    brightBlue: '#a6c3ea',
    brightMagenta: '#dbb8e8',
    brightCyan: '#a9dbe0',
    brightWhite: '#eef3f8',
  },
};

type ProfileInput = {
  font?: { ui?: { family?: unknown }; terminal?: { family?: unknown; size?: unknown; lineHeight?: unknown } };
  theme?: Record<string, unknown>;
};

const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;
const positive = (value: unknown, fallback: number) => typeof value === 'number' && value > 0 ? value : fallback;

function mergeProfile(input: ProfileInput): Profile {
  const font = input.font;
  const theme = { ...DEFAULT_PROFILE.theme };
  for (const token of Object.keys(theme) as (keyof Theme)[]) theme[token] = text(input.theme?.[token], theme[token]);
  return {
    font: {
      ui: { family: text(font?.ui?.family, DEFAULT_PROFILE.font.ui.family) },
      terminal: {
        family: text(font?.terminal?.family, DEFAULT_PROFILE.font.terminal.family),
        size: positive(font?.terminal?.size, DEFAULT_PROFILE.font.terminal.size),
        lineHeight: positive(font?.terminal?.lineHeight, DEFAULT_PROFILE.font.terminal.lineHeight),
      },
    },
    theme,
  };
}

// The user's init.ts may define several profiles and export the selected one.
export async function loadProfile(): Promise<Profile> {
  const source = join(homedir(), '.config/wangcai/init.ts');
  if (!existsSync(source)) return DEFAULT_PROFILE;
  const cache = join(homedir(), '.cache/wangcai');
  const output = join(cache, 'init.cjs');
  try {
    const { build } = await import('esbuild');
    mkdirSync(cache, { recursive: true });
    await build({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', target: 'node22' });
    const input = createRequire(__filename)(output).default as ProfileInput | undefined;
    return mergeProfile(input ?? {});
  } catch (error) {
    console.error('User config:', error);
    return DEFAULT_PROFILE;
  }
}