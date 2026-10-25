import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Profile } from '@lengmoxxl/sdk';
import type { InstallStage, InstallStatus, Network, PluginEntry } from '@lengmoxxl/sdk/bridge';
import { TRANSFER_LIMITS, buildEnvironment, mirroredUrl, npm, run, withProxy } from './spawn';

/**
 * The host this app lends, written here rather than imported from Core's own host.ts: both sides reach the SDK
 * through their own copy of it, so `Profile` from one is not the same type as `Profile` from the other.
 */
export interface CoreHost {
  paths: { storage: string };
  version: string;
  sources: string;
  config: { profile: Profile; network: Network };
  plugins(): Promise<PluginEntry[]>;
  statuses(): InstallStatus[];
  install(ids: string[]): Promise<boolean>;
  protocol: { handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void };
  fetch(url: string, options?: { signal?: AbortSignal }): Promise<Response>;
  send(topic: string, data: unknown): void;
  setProxy(rules: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  reload(): void;
  fullscreen(): boolean;
}

interface Core {
  /** The contract this build answers, or none for a build made before the number existed. */
  contract?: number;
  dispatch(method: string, ...args: unknown[]): unknown;
  dispose(): Promise<void>;
}

/** The repository a Core is taken from. A test run points WANGCAI_CORE_REPOSITORY at a local one, so a start
 * that has to install a Core can be driven without a network. */
const repository = process.env.WANGCAI_CORE_REPOSITORY ?? 'https://github.com/lengmoXXL/WangCai-Core';

/** Where this run reads the Core the app installed: the build beside the clone it keeps under `plugins`. */
export const coreDirectory = (storage: string) => join(storage, 'plugins/core/dist');

/** Whether that build is one a run can load: the bundle, and the page the window draws. */
export const coreReady = (storage: string) => {
  const built = coreDirectory(storage);
  return existsSync(join(built, 'main.cjs')) && existsSync(join(built, 'ui/index.html'));
};

/** What a built Core exports: the one call the app makes, and the host it is handed. */
interface CoreModule { activate(host: CoreHost): Promise<Core> }

export async function loadCore(directory: string) {
  return import(pathToFileURL(join(directory, 'main.cjs')).href) as Promise<CoreModule>;
}

interface CoreInstall { storage: string; node: string; network: Network; report: (stage: InstallStage, message?: string) => void; follow?: boolean }

/**
 * Puts a Core where a run reads it: the repository is cloned under `plugins`, built with the Node the app
 * carries, and left beside its clone in `dist`. A build that is already there is left as it stands — `follow`
 * is the app menu's update, which goes back to the branch and rebuilds what moved.
 *
 * Reports whether anything was built anew.
 */
export async function installCore({ storage, node, network, report, follow = false }: CoreInstall) {
  const built = coreDirectory(storage);
  const ready = coreReady(storage);
  if (ready && !follow) return false;
  // A fresh install has no data directory yet, and this step is exactly what runs before a Core ever did.
  mkdirSync(storage, { recursive: true });
  mkdirSync(join(storage, 'plugins'), { recursive: true });
  const source = join(storage, 'plugins/core');
  const environment = withProxy(network.proxy);
  const url = mirroredUrl(repository, network.mirror);
  const git = (args: string[], cwd = source) => run('git', [...TRANSFER_LIMITS, ...args], cwd, environment);
  if (!existsSync(join(source, '.git'))) {
    report('cloning', `git clone ${url}`);
    await git(['clone', url, source], storage);
  } else if (follow) {
    // Only an update reaches the repository: a start builds what the clone already holds, without a network.
    report('updating', `git pull ${url}`);
    await git(['remote', 'set-url', 'origin', url]);
    await git(['fetch', 'origin']);
    const branch = (await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim().replace(/^origin\//, '');
    await git(['checkout', '--force', branch]);
    await git(['pull', '--ff-only']);
  }
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const stamp = join(built, 'commit');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === commit) return false;
  // npm and its own directory come first on PATH, so the build script and the tools it runs resolve to the
  // runtime the app carries rather than whatever the user happens to have installed.
  const build = buildEnvironment(node, environment);
  report('installing', 'npm install');
  await npm(node, ['install', '--no-audit', '--no-fund', '--no-progress'], source, build);
  report('building', 'npm run build');
  await npm(node, ['run', 'build'], source, build);
  if (!existsSync(join(built, 'main.cjs'))) throw new Error(`${repository} 的构建没有写出 dist/main.cjs`);
  return true;
}
