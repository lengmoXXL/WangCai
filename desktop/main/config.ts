import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Profile, Theme } from '@wangcai/sdk';

const DEFAULT_PROFILE: Profile = {
  theme: {
    background: '#121314',
    foreground: '#dce3eb',
    cursor: '#9bc7bc',
    selection: '#35534e',
    surface: '#191a1b',
    overlay: '#2c2d2e',
    border: '#333536',
    muted: '#8b98a6',
    accent: '#3994bc',
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
  agent: { downloadPrefix: 'https://github.com/lengmoXXL/WangCai/releases/download' },
};

export const configDirectory = join(homedir(), '.config/wangcai');

export type PluginSpec = { id: string; repo?: string; commit?: string; directory?: string; config?: Record<string, unknown> };

/** The directory a spec lives in: what init.ts names, else the user's plugin directory. */
export const pluginDirectory = (spec: PluginSpec) => spec.directory ?? join(configDirectory, 'plugins', spec.id);

type ProfileInput = {
  theme?: Record<string, unknown>;
  agent?: { downloadPrefix?: unknown };
  plugins?: unknown;
};

const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;
const trimmed = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

function mergeProfile(input: ProfileInput): Profile {
  const theme = { ...DEFAULT_PROFILE.theme };
  for (const token of Object.keys(theme) as (keyof Theme)[]) theme[token] = text(input.theme?.[token], theme[token]);
  return {
    theme,
    agent: { downloadPrefix: text(input.agent?.downloadPrefix, DEFAULT_PROFILE.agent.downloadPrefix) },
  };
}

// A relative directory is taken from the config directory. The first entry for an id wins.
function mergePlugins(input: unknown): PluginSpec[] {
  if (!Array.isArray(input)) return [];
  const specs = new Map<string, PluginSpec>();
  for (const entry of input) {
    const { id, repo, commit, directory, config } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || specs.has(id)) continue;
    const relative = trimmed(directory);
    specs.set(id, {
      id,
      repo: trimmed(repo),
      commit: trimmed(commit),
      directory: relative ? resolve(configDirectory, relative) : undefined,
      config: typeof config === 'object' && config !== null && !Array.isArray(config) ? config as Record<string, unknown> : undefined,
    });
  }
  return [...specs.values()];
}

// What a fresh install starts with: the plugins the app ships.
export const DEFAULT_PLUGINS: PluginSpec[] = [
  { id: 'terminal-agent' },
  { id: 'files' },
  { id: 'terminal' },
];

// Written once, when init.ts is missing; from then on the file belongs to the user.
const PRESET = `// 旺财的启动入口：启动时由 app 直接加载，只放配置与插件注册。
// 可配字段（就这些，其它字段会被忽略）：
//   theme   { background, foreground, cursor, selection, surface, overlay, border, muted, accent,
//             black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed,
//             brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite }
//           界面与终端配色，值写 '#rrggbb'；终端调色板是 black 到 brightWhite
//   agent   { downloadPrefix }            下载 agent 的地址前缀
//   plugins [{ id, repo, commit, directory, config }]  要加载的插件；没列出来的不会加载
// 插件条目的字段：
//   id        插件 id，也就是插件目录名
//   repo      插件仓库：clone 并在这里构建（app 自带 node 与 npm）；不写 directory 时 clone 到
//             ~/.config/wangcai/plugins/<id>/；GitHub 连不上时会自动换国内镜像重试
//   commit    仓库里的 commit 或分支；换一个就重新 checkout 并重建
//   directory 改用别的插件目录（相对路径相对本文件）；不写 repo 时用 ~/.config/wangcai/plugins/<id>/，
//             那里也没有就用 app 自带的那份
//   config    这个插件自己的配置，能写哪些字段由插件说了算（schema 在插件的 main.cjs 里），不写的用插件给的默认值
// 插件就是一个目录，里面是编译好的 main.cjs（主进程）和可选的 ui.js / ui.css（界面文件）。
// 删掉本文件会重新生成这份默认配置。
export default {
  plugins: [
${DEFAULT_PLUGINS.map(({ id }) => `    { id: '${id}' }`).join(',\n')},
  ],
};
`;

// init.ts is loaded as it stands: this process strips its types, so a config change needs no build step.
export async function loadConfig(): Promise<{ profile: Profile; plugins: PluginSpec[] }> {
  const source = join(configDirectory, 'init.ts');
  if (!existsSync(source)) {
    try {
      mkdirSync(configDirectory, { recursive: true });
      writeFileSync(source, PRESET);
    } catch (error) {
      console.error('User config:', error);
      return { profile: DEFAULT_PROFILE, plugins: DEFAULT_PLUGINS };
    }
  }
  try {
    const { default: input } = await import(pathToFileURL(source).href) as { default?: ProfileInput };
    return { profile: mergeProfile(input ?? {}), plugins: mergePlugins(input?.plugins) };
  } catch (error) {
    console.error('User config:', error);
    return { profile: DEFAULT_PROFILE, plugins: [] };
  }
}
