import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Profile, Theme } from '@lengmoxxl/sdk';
import type { Network } from '../../core/shared';

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
};

/** One plugin as init.ts names it: where it comes from, and how it is configured. */
export type PluginSpec = { id: string; workspaces: boolean; repo?: string; commit?: string; directory?: string; config?: Record<string, unknown> };

type ProfileInput = {
  theme?: Record<string, unknown>;
  network?: { proxy?: unknown; mirror?: unknown };
  workspaces?: unknown;
  tabs?: unknown;
};

const trimmed = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

function mergeProfile(input: ProfileInput): Profile {
  const theme = { ...DEFAULT_PROFILE.theme };
  for (const token of Object.keys(theme) as (keyof Theme)[]) {
    const given = input.theme?.[token];
    if (typeof given === 'string' && given.trim()) theme[token] = given;
  }
  return { theme };
}

function mergeNetwork(input: ProfileInput): Network {
  const proxy = trimmed(input.network?.proxy);
  const mirror = trimmed(input.network?.mirror);
  return {
    // Chromium and curl both read a bare `socks://` as SOCKS4, and npm needs a scheme to read a proxy at all.
    proxy: proxy && (/^\w+:\/\//.test(proxy) ? proxy : `http://${proxy}`).replace(/^socks:\/\//, 'socks5://'),
    // A prefix is joined to a URL, so it ends in one whether init.ts wrote it or not.
    mirror: mirror ? (mirror.endsWith('/') ? mirror : `${mirror}/`) : undefined,
  };
}

// A relative directory is taken from the config directory. The first entry for an id wins.
function mergePlugins(configDirectory: string, entries: unknown, workspaces: boolean, specs: Map<string, PluginSpec>) {
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
function pluginsFrom(configDirectory: string, input: ProfileInput): PluginSpec[] {
  const specs = new Map<string, PluginSpec>();
  mergePlugins(configDirectory, input.workspaces, true, specs);
  mergePlugins(configDirectory, input.tabs, false, specs);
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
const preset = (storage: string) => `// 旺财的启动入口：启动时由 app 直接加载，只放配置与插件注册。
// 可配字段（就这些，其它字段会被忽略）：
//   theme   { background, foreground, cursor, selection, surface, overlay, border, muted, accent,
//             black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed,
//             brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite }
//           界面与终端配色，值写 '#rrggbb'；终端调色板是 black 到 brightWhite
//   network { proxy, mirror }  出网方式：proxy 写 http://host:port、https://host:port 或 socks5://host:port
//           （不写 scheme 当 http://，socks:// 当 socks5://；插件的 clone、npm install 与重建 Core 也走它）
//   mirror    是 GitHub 加速前缀（像 https://ghfast.top/）：https://github.com/ 开头的链接都从这里出去；
//           两个都不写就用直连
//   workspaces [{ id, repo, commit, directory, config }]  工作区插件：窗口从这里取工作区列表，以及菜单里能开什么
//   tabs       [{ id, repo, commit, directory, config }]  侧栏标签页插件：它导出的视图出现在侧栏菜单里
// 插件条目的字段：
//   id        插件 id，也就是插件目录名
//   repo      插件仓库：不写就用官方仓库 https://github.com/lengmoXXL/WangCai-<id>；写了就 clone 并构建
//             （app 自带 node 与 npm；出网方式见 network）
//   commit    写哪个 commit 或分支就 checkout 到它（换一个就重新 checkout 并重建）；不写就只在更新时
//             跟仓库的分支走，启动时用的是已经构建好的那份
//   directory 插件放在哪个目录：clone 到这里，也直接读这里的 main.cjs；不写时用数据目录（默认为
//             ~/.local/share/wangcai）下的 plugins/<id>/；只写 directory 就是用那里的现成插件
//   config    这个插件自己的配置，能写哪些字段由插件说了算（schema 在插件的 main.cjs 里），不写的用插件给的默认值
// 插件就是一个目录，里面是编译好的 main.cjs（主进程）和可选的 ui.js / ui.css（界面文件）。
// 配置字段的完整说明：${join(storage, 'src/README.md')}
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

/** The two directories init.ts is read from and the plugin builds land in. */
interface ConfigPaths { config: string; storage: string }

// init.ts is loaded as it stands: this process strips its types, so a config change needs no build step.
export async function loadConfig(paths: ConfigPaths): Promise<{ profile: Profile; plugins: PluginSpec[]; network: Network }> {
  const source = join(paths.config, 'init.ts');
  if (!existsSync(source)) {
    try {
      mkdirSync(paths.config, { recursive: true });
      writeFileSync(source, preset(paths.storage));
    } catch (error) {
      console.error('User config:', error);
      return { profile: DEFAULT_PROFILE, plugins: DEFAULT_PLUGINS, network: {} };
    }
  }
  try {
    const { default: input } = await import(pathToFileURL(source).href) as { default?: ProfileInput };
    return { profile: mergeProfile(input ?? {}), plugins: pluginsFrom(paths.config, input ?? {}), network: mergeNetwork(input ?? {}) };
  } catch (error) {
    console.error('User config:', error);
    return { profile: DEFAULT_PROFILE, plugins: [], network: {} };
  }
}
