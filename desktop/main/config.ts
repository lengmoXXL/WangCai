import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Profile, Theme } from '@lengmoxxl/sdk';
import type { Network } from '@lengmoxxl/sdk/bridge';

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
  leader?: unknown;
  timeout?: unknown;
  keys?: unknown;
  commands?: unknown;
};

/** init.ts's key fields, carried to Core as they are written — functions and all. */
export type KeymapInput = Pick<ProfileInput, 'leader' | 'timeout' | 'keys' | 'commands'>;

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
    // curl reads a bare `socks://` as SOCKS4, and npm needs a scheme to read a proxy at all.
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
// 顶层有 theme、network、workspaces、tabs、leader、timeout、keys、commands；插件条目的字段是 id、repo、commit、directory、config。
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
export async function loadConfig(paths: ConfigPaths): Promise<{ profile: Profile; plugins: PluginSpec[]; network: Network; keymap: KeymapInput }> {
  const source = join(paths.config, 'init.ts');
  if (!existsSync(source)) {
    try {
      mkdirSync(paths.config, { recursive: true });
      writeFileSync(source, preset(paths.storage));
    } catch (error) {
      console.error('User config:', error);
      return { profile: DEFAULT_PROFILE, plugins: DEFAULT_PLUGINS, network: {}, keymap: {} };
    }
  }
  try {
    const { default: input } = await import(pathToFileURL(source).href) as { default?: ProfileInput };
    const given = input ?? {};
    const { leader, timeout, keys, commands } = given;
    return {
      profile: mergeProfile(given),
      plugins: pluginsFrom(paths.config, given),
      network: mergeNetwork(given),
      keymap: { leader, timeout, keys, commands },
    };
  } catch (error) {
    console.error('User config:', error);
    return { profile: DEFAULT_PROFILE, plugins: [], network: {}, keymap: {} };
  }
}
