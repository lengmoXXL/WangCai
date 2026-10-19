import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InstallStatus, Network, PluginEntry } from '../../core/shared';
import type { PluginSpec } from './config';
import { TRANSFER_LIMITS, buildEnvironment, mirroredUrl, npm, run, withProxy } from './spawn';

type Installs = Record<string, { repo: string; commit: string }>;

/** What one run installs with: its data directory, the runtime the app carries, and how it reaches the network. */
interface InstallSettings {
  storage: string;
  node: string;
  network: Network;
}

interface InstallOptions extends InstallSettings {
  /** Where the page is told what a row is doing; the app only relays it to the window. */
  report: (statuses: InstallStatus[]) => void;
}

/**
 * Installs one plugin: clones it if it is not here, checks out what init.ts pins, and builds it where the build
 * is missing. `follow` is what a row's update asks for — an entry that pins nothing then moves to its branch's
 * commits, which a start leaves alone.
 */
async function installPlugin(spec: PluginSpec, directory: string, { storage, node, network }: InstallSettings, mark: (status: InstallStatus) => void, follow: boolean) {
  const repository = spec.repo;
  if (!repository) return false;
  const stage = (value: Omit<InstallStatus, 'id'>) => mark({ id: spec.id, ...value });
  const installsFile = join(storage, 'installs.json');
  const installs = existsSync(installsFile) ? JSON.parse(readFileSync(installsFile, 'utf8')) as Installs : {};
  const stamp = installs[spec.id];
  if (stamp && stamp.repo !== repository) throw new Error(`${directory} holds a clone of ${stamp.repo}, not of ${repository}`);
  const builtFrom = (commit: string) => stamp?.commit === commit && existsSync(join(directory, 'main.cjs'));
  // What is already built is what a start runs, without a network at all: the build of the commit init.ts pins,
  // and the build an entry that pins nothing already has.
  const upToDate = spec.commit ? builtFrom(spec.commit) : stamp && builtFrom(stamp.commit);
  if (upToDate && !follow) {
    stage({ stage: 'ready', message: '无需更新' });
    return false;
  }
  let worked = false;
  const url = mirroredUrl(repository, network.mirror);
  const environment = withProxy(network.proxy);
  const git = (args: string[], cwd = directory) => run('git', [...TRANSFER_LIMITS, ...args], cwd, environment);
  if (!existsSync(join(directory, '.git'))) {
    if (existsSync(directory) && readdirSync(directory).length) throw new Error(`${directory} exists and is not a clone of ${repository}`);
    mkdirSync(dirname(directory), { recursive: true });
    stage({ stage: 'cloning', message: `git clone ${url}` });
    await git(['clone', url, directory], dirname(directory));
    worked = true;
  }
  // A commit that is already here needs no network: an offline start rebuilds what it has.
  if (spec.commit && !(await run('git', ['cat-file', '-e', `${spec.commit}^{commit}`], directory, environment).then(() => true, () => false))) {
    stage({ stage: 'cloning', message: `git fetch ${url} ${spec.commit}` });
    await git(['remote', 'set-url', 'origin', url]);
    await git(['fetch', 'origin']);
    worked = true;
  }
  // A pinned entry leaves the clone detached, which is what it asked for.
  if (spec.commit) await git(['checkout', '--force', spec.commit]);
  else {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim().replace(/^origin\//, '');
    await git(['checkout', '--force', branch]);
    if (follow) {
      stage({ stage: 'updating', message: `git pull ${url}` });
      await git(['remote', 'set-url', 'origin', url]);
      await git(['pull', '--ff-only']);
    }
  }
  const commit = (await git(['rev-parse', 'HEAD'])).trim();

  if (!builtFrom(commit)) {
    worked = true;
    const scripts = existsSync(join(directory, 'package.json')) ? (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts ?? {}) : {};
    const build = buildEnvironment(node, environment);
    if (Object.keys(scripts).length) {
      stage({ stage: 'installing', message: 'npm install' });
      await npm(node, ['install', '--no-audit', '--no-fund', '--no-progress'], directory, build);
    }
    if (scripts.build) {
      stage({ stage: 'building', message: 'npm run build' });
      await npm(node, ['run', 'build'], directory, build);
    }
    if (!existsSync(join(directory, 'main.cjs'))) throw new Error(`${repository} has no build script that writes main.cjs`);
    installs[spec.id] = { repo: repository, commit };
    writeFileSync(installsFile, JSON.stringify(installs, null, 2));
  }
  stage({ stage: 'ready', message: worked ? undefined : '无需更新' });
  return worked;
}

/**
 * The plugins init.ts lists, installed by the app and handed to a Core: a plugin that did not install is left
 * out rather than activated from half a checkout, and its row says what went wrong.
 */
export function pluginInstaller(specs: PluginSpec[], options: InstallOptions) {
  const statuses: InstallStatus[] = specs.map(({ id }) => ({ id, stage: 'ready' }));
  // Where each plugin lives, worked out once and handed to both the installer and what a Core loads.
  const directories = new Map(specs.map((spec) => [spec.id, spec.directory ?? join(options.storage, 'plugins', spec.id)] as const));
  // A row is changed and reported in one step, whoever is changing it.
  const mark = (status: InstallStatus) => {
    statuses[statuses.findIndex((entry) => entry.id === status.id)] = status;
    options.report([...statuses]);
  };
  const installEach = async (targets: PluginSpec[], follow: boolean) => {
    let worked = false;
    for (const spec of targets) {
      try {
        if (await installPlugin(spec, directories.get(spec.id)!, options, mark, follow)) worked = true;
      } catch (error) {
        mark({ id: spec.id, stage: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return worked;
  };
  const startup = installEach(specs, false);
  // One pass at a time: two on the same directory would clone and build it twice and write the stamps twice.
  const install = async (ids: string[]) => {
    await startup;
    return installEach(specs.filter(({ id }) => ids.includes(id)), true);
  };
  return {
    statuses: () => statuses,
    install,
    /** The plugins that ended up ready, and where their builds are. */
    async plugins(): Promise<PluginEntry[]> {
      await startup;
      return specs
        .filter(({ id }) => statuses.find((status) => status.id === id)?.stage === 'ready')
        .map((spec) => ({ id: spec.id, workspaces: spec.workspaces, config: spec.config, directory: directories.get(spec.id)! }));
    },
  };
}
