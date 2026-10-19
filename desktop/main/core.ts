import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Profile } from '@lengmoxxl/sdk';
import type { InstallStage, InstallStatus, Network, PluginEntry } from '../../core/shared';
import { TRANSFER_LIMITS, buildEnvironment, mirroredUrl, npm, run, withProxy } from './spawn';

/**
 * The host this app lends, written here rather than imported from Core's own host.ts: both sides reach the SDK
 * through their own copy of it, so `Profile` from one is not the same type as `Profile` from the other.
 */
export interface CoreHost {
  paths: { storage: string; resources: string };
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
  updateCore(): void;
  fullscreen(): boolean;
}

interface Core {
  /** The contract this build answers, or none for a build made before the number existed. */
  contract?: number;
  dispatch(method: string, ...args: unknown[]): unknown;
  dispose(): Promise<void>;
}

/** Where the Core of this run is: what a rebuild put in the data directory, else the build the app carries —
 * the packaged one, or this checkout's while developing. */
export function coreDirectory({ packaged, storage, app }: { packaged: boolean; storage: string; app: string }) {
  const built = join(storage, 'core');
  if (existsSync(join(built, 'main.cjs')) && existsSync(join(built, 'ui/index.html'))) return built;
  return packaged ? join(process.resourcesPath, 'core') : join(app, '../core/dist');
}

/** What a built Core exports: the one call the app makes, and the host it is handed. */
interface CoreModule { activate(host: CoreHost): Promise<Core> }

/** Imports the `main.cjs` a directory holds. */
export async function loadCore(directory: string) {
  return import(pathToFileURL(join(directory, 'main.cjs')).href) as Promise<CoreModule>;
}

/** The repository a Core the app builds itself is taken from. */
const repository = 'https://github.com/lengmoXXL/WangCai-Core';

interface CoreUpdate { storage: string; node: string; network: Network; report: (stage: InstallStage, message?: string) => void }

/**
 * Clones the repository, builds it with the Node the app carries, and puts the result where the next start
 * reads it — a Core is not loaded into a run that is already going.
 *
 * Reports false when the commit that was pulled is the one already built.
 */
export async function rebuildCore({ storage, node, network, report }: CoreUpdate) {
  // A fresh install has no data directory yet, and this step is exactly what runs before a Core ever did.
  mkdirSync(storage, { recursive: true });
  const source = join(storage, 'core-src');
  const environment = withProxy(network.proxy);
  const url = mirroredUrl(repository, network.mirror);
  const git = (args: string[], cwd = source) => run('git', [...TRANSFER_LIMITS, ...args], cwd, environment);
  if (!existsSync(join(source, '.git'))) {
    report('cloning', `git clone ${url}`);
    await git(['clone', url, source], storage);
  } else {
    report('updating', `git pull ${url}`);
    await git(['remote', 'set-url', 'origin', url]);
    await git(['fetch', 'origin']);
    await git(['pull', '--ff-only']);
  }
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const built = join(storage, 'core');
  if (existsSync(join(built, 'commit')) && readFileSync(join(built, 'commit'), 'utf8').trim() === commit) return false;
  const build = buildEnvironment(node, environment);
  report('installing', 'npm install');
  await npm(node, ['install', '--no-audit', '--no-fund', '--no-progress'], source, build);
  report('building', 'npm run build');
  await npm(node, ['run', 'build'], source, build);
  if (!existsSync(join(source, 'dist/main.cjs'))) throw new Error(`${repository} 的构建没有写出 dist/main.cjs`);
  rmSync(built, { recursive: true, force: true });
  cpSync(join(source, 'dist'), built, { recursive: true });
  return true;
}
