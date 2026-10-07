import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Profile, Theme } from '@lengmoxxl/sdk';

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

// Where this run keeps the config it loads and the data it writes. A development run can be pointed
// somewhere else, so it cannot change the files an installed app is using.
export const homeOverride = process.env.WANGCAI_HOME || undefined;
export const homeDirectory = homeOverride ?? homedir();
const configDirectory = join(homeDirectory, '.config/wangcai');
export const storageDirectory = join(homeDirectory, '.local/share/wangcai');

export type PluginSpec = { id: string; workspaces: boolean; repo?: string; commit?: string; directory?: string; config?: Record<string, unknown> };

/** The directory a spec lives in: what init.ts names, else the user's plugin directory. */
export const pluginDirectory = (spec: PluginSpec) => spec.directory ?? join(storageDirectory, 'plugins', spec.id);

type ProfileInput = {
  theme?: Record<string, unknown>;
  agent?: { downloadPrefix?: unknown };
  workspaces?: unknown;
  tabs?: unknown;
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
function mergePlugins(entries: unknown, workspaces: boolean, specs: Map<string, PluginSpec>) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const { id, repo, commit, directory, config } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || specs.has(id)) continue;
    const relative = trimmed(directory);
    specs.set(id, {
      id,
      workspaces,
      // An entry that names no source at all is still a plugin to install: the official repository of the id.
      repo: trimmed(repo) ?? (relative ? undefined : `https://github.com/lengmoXXL/WangCai-${id}`),
      commit: trimmed(commit),
      directory: relative ? resolve(configDirectory, relative) : undefined,
      config: typeof config === 'object' && config !== null && !Array.isArray(config) ? config as Record<string, unknown> : undefined,
    });
  }
}

// init.ts names its plugins twice: the ones the window draws workspaces for, and the ones that add sidebar tabs.
function pluginsFrom(input: ProfileInput): PluginSpec[] {
  const specs = new Map<string, PluginSpec>();
  mergePlugins(input.workspaces, true, specs);
  mergePlugins(input.tabs, false, specs);
  return [...specs.values()];
}

// What a fresh install starts with: each plugin is cloned from its repository and built, so a release
// ships an app without any plugin inside it.
const DEFAULT_PLUGINS: PluginSpec[] = [
  { id: 'terminal-agent', workspaces: true, repo: 'https://github.com/lengmoXXL/WangCai-terminal-agent' },
  { id: 'files', workspaces: false, repo: 'https://github.com/lengmoXXL/WangCai-files' },
  { id: 'terminal', workspaces: false, repo: 'https://github.com/lengmoXXL/WangCai-terminal' },
];

// Written once, when init.ts is missing; from then on the file belongs to the user.
const PRESET = `// 旺财的启动入口：启动时由 app 直接加载，只放配置与插件注册。
// 可配字段（就这些，其它字段会被忽略）：
//   theme   { background, foreground, cursor, selection, surface, overlay, border, muted, accent,
//             black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed,
//             brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite }
//           界面与终端配色，值写 '#rrggbb'；终端调色板是 black 到 brightWhite
//   agent   { downloadPrefix }            下载 agent 的地址前缀
//   workspaces [{ id, repo, commit, directory, config }]  工作区插件：窗口从这里取工作区列表，以及菜单里能开什么
//   tabs       [{ id, repo, commit, directory, config }]  侧栏标签页插件：它导出的视图出现在视图菜单里
// 插件条目的字段：
//   id        插件 id，也就是插件目录名
//   repo      插件仓库：不写就用官方仓库 https://github.com/lengmoXXL/WangCai-<id>；写了就 clone 并构建
//             （app 自带 node 与 npm；GitHub 连不上时会自动换国内镜像重试）
//   commit    写哪个 commit 或分支就 checkout 到它（换一个就重新 checkout 并重建）；不写就跟仓库的分支走
//   directory 插件放在哪个目录：clone 到这里，也直接读这里的 main.cjs；不写时用数据目录（默认为
//             ~/.local/share/wangcai）下的 plugins/<id>/；只写 directory 就是用那里的现成插件
//   config    这个插件自己的配置，能写哪些字段由插件说了算（schema 在插件的 main.cjs 里），不写的用插件给的默认值
// 插件就是一个目录，里面是编译好的 main.cjs（主进程）和可选的 ui.js / ui.css（界面文件）。
// 删掉本文件会重新生成这份默认配置。
export default {
  workspaces: [
${DEFAULT_PLUGINS.filter((spec) => spec.workspaces).map(({ id, repo }) => `    { id: '${id}', repo: '${repo}' }`).join(',\n')},
  ],
  tabs: [
${DEFAULT_PLUGINS.filter((spec) => !spec.workspaces).map(({ id, repo }) => `    { id: '${id}', repo: '${repo}' }`).join(',\n')},
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
    return { profile: mergeProfile(input ?? {}), plugins: pluginsFrom(input ?? {}) };
  } catch (error) {
    console.error('User config:', error);
    return { profile: DEFAULT_PROFILE, plugins: [] };
  }
}
