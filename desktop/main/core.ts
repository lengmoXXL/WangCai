import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InstallStage } from '../../core/shared';

/** The repository a Core the shell builds itself is taken from. */
const repository = 'https://github.com/lengmoXXL/WangCai-Core';

/** A blocked host can leave a connection hanging, so a transfer that stalls fails instead of never ending. */
const TRANSFER_LIMITS = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20'];

export interface CoreSource { packaged: boolean; storage: string; app: string }

/** Where the Core of this run is: what was built into the data directory, else what the app ships. */
export function coreDirectory({ packaged, storage, app }: CoreSource) {
  const built = join(storage, 'core');
  if (existsSync(join(built, 'main.cjs')) && existsSync(join(built, 'ui/index.html'))) return built;
  return packaged ? join(process.resourcesPath, 'core') : join(app, '../core/dist');
}

/** The bundle Core is: one call the shell makes, and the host it is handed. */
export async function loadCore(directory: string) {
  return await import(pathToFileURL(join(directory, 'main.cjs')).href) as typeof import('../../core/main/index');
}

function run(command: string, args: string[], cwd: string, environment = process.env) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment });
    let output = '';
    const collect = (chunk: Buffer) => { output = `${output}${chunk}`.slice(-8000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output.trim() || `${command} exited with ${code}`)));
  });
}

// A proxy reaches the children too: git and npm read it from the environment, not from the app session.
const withProxy = (proxy: string | undefined, environment = process.env) => {
  if (!proxy) return environment;
  const address = proxy.replace(/^socks5:\/\//, 'socks5h://');
  return { ...environment, http_proxy: address, https_proxy: address, all_proxy: address };
};

export interface CoreUpdate { storage: string; node: string; network: { proxy?: string; mirror?: string }; report: (stage: InstallStage, message?: string) => void }

/**
 * Clones the repository, builds it with the Node the app carries, and puts the result where the next start
 * reads it. The build is not loaded here: what a rebuilt Core runs is the run after this one.
 *
 * Reports false when the commit that was pulled is the one already built.
 */
export async function rebuildCore({ storage, node, network, report }: CoreUpdate) {
  const source = join(storage, 'core-src');
  const environment = withProxy(network.proxy);
  const url = network.mirror && /^https:\/\/github\.com\//.test(repository) ? `${network.mirror}${repository}` : repository;
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
  if (existsSync(join(built, 'commit')) && readFileSync(join(built, 'commit'), 'utf8').trim() === commit) {
    report('ready', '已是最新');
    return false;
  }
  // npm and its own directory come first on PATH, so the build script and the tools it runs resolve to the
  // runtime the app carries rather than whatever the user happens to have installed.
  const buildEnvironment = { ...environment, PATH: `${dirname(node)}:${environment.PATH ?? ''}` };
  const npm = (args: string[]) => run(node, [join(dirname(node), 'npm'), ...args], source, buildEnvironment);
  report('installing', 'npm install');
  await npm(['install', '--no-audit', '--no-fund', '--no-progress']);
  report('building', 'npm run build');
  await npm(['run', 'build']);
  if (!existsSync(join(source, 'dist/main.cjs'))) throw new Error(`${repository} 的构建没有写出 dist/main.cjs`);
  rmSync(built, { recursive: true, force: true });
  cpSync(join(source, 'dist'), built, { recursive: true });
  report('ready');
  return true;
}