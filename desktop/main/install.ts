import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installsPath, pluginDirectory, type Network, type PluginSpec } from './config';
import type { InstallStage } from '../shared';

type Installs = Record<string, { repo: string; commit: string }>;

// GitHub is not reachable from every network the app runs on, and init.ts says what a run goes out
// through instead: a prefix that https://github.com/ URLs are rewritten to. An ssh remote cannot
// carry a prefix, so a git@github.com: clone goes out as it is.
export const mirroredUrl = (url: string, mirror?: string) => mirror && /^https:\/\/github\.com\//.test(url)
  ? `${mirror}${url}`
  : url;

// A blocked host can leave a connection hanging, so a transfer that stalls fails instead of never ending.
const TRANSFER_LIMITS = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20'];

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

// A proxy reaches the children too: git and npm read it from the environment, not from the app session. A
// socks proxy goes out in its remote-DNS form, since a name resolved here is one a proxy cannot correct.
const withProxy = (proxy: string | undefined, environment = process.env) => {
  if (!proxy) return environment;
  const address = proxy.replace(/^socks5:\/\//, 'socks5h://');
  return { ...environment, http_proxy: address, https_proxy: address, all_proxy: address };
};

/**
 * `node` is the runtime the app carries.
 *
 * `follow` is what a row's update asks for: an entry that pins nothing then moves to its branch's commits,
 * which a start leaves alone.
 */
export async function installPlugin(spec: PluginSpec, node: string, network: Network, onStage: (stage: InstallStage, message?: string) => void, follow = false) {
  const repository = spec.repo;
  if (!repository) return;
  const directory = pluginDirectory(spec);
  const installs = existsSync(installsPath) ? JSON.parse(readFileSync(installsPath, 'utf8')) as Installs : {};
  const stamp = installs[spec.id];
  if (stamp && stamp.repo !== repository) throw new Error(`${directory} holds a clone of ${stamp.repo}, not of ${repository}`);
  const builtFrom = (commit: string) => stamp?.commit === commit && existsSync(join(directory, 'main.cjs'));
  // What is already built is what a start runs, without a network at all: the build of the commit init.ts pins,
  // and the build an entry that pins nothing already has.
  const upToDate = spec.commit ? builtFrom(spec.commit) : stamp && builtFrom(stamp.commit);
  if (upToDate && !follow) {
    onStage('ready', '无需更新');
    return false;
  }
  let worked = false;
  const url = mirroredUrl(repository, network.mirror);
  const environment = withProxy(network.proxy);
  const git = (args: string[], cwd = directory) => run('git', [...TRANSFER_LIMITS, ...args], cwd, environment);
  if (!existsSync(join(directory, '.git'))) {
    if (existsSync(directory) && readdirSync(directory).length) throw new Error(`${directory} exists and is not a clone of ${repository}`);
    mkdirSync(dirname(directory), { recursive: true });
    onStage('cloning', `git clone ${url}`);
    await git(['clone', url, directory], dirname(directory));
    worked = true;
  }
  // A commit that is already here needs no network: an offline start rebuilds what it has.
  if (spec.commit && !(await run('git', ['cat-file', '-e', `${spec.commit}^{commit}`], directory, environment).then(() => true, () => false))) {
    onStage('cloning', `git fetch ${url} ${spec.commit}`);
    await git(['remote', 'set-url', 'origin', url]);
    await git(['fetch', 'origin']);
    worked = true;
  }
  if (spec.commit) await git(['checkout', '--force', spec.commit]);
  else {
    // A pinned entry leaves the clone detached.
    const branch = (await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim().replace(/^origin\//, '');
    await git(['checkout', '--force', branch]);
    if (follow) {
      onStage('updating', `git pull ${url}`);
      await git(['remote', 'set-url', 'origin', url]);
      await git(['pull', '--ff-only']);
    }
  }
  const commit = (await git(['rev-parse', 'HEAD'])).trim();

  if (!builtFrom(commit)) {
    worked = true;
    const scripts = existsSync(join(directory, 'package.json')) ? (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts ?? {}) : {};
    // npm and its own directory come first on PATH, so a plugin's build script and the tools it runs
    // resolve to the runtime the app carries rather than whatever the user happens to have installed.
    const buildEnvironment = { ...environment, PATH: `${dirname(node)}:${environment.PATH ?? ''}` };
    const npm = (args: string[]) => run(node, [join(dirname(node), 'npm'), ...args], directory, buildEnvironment);
    if (Object.keys(scripts).length) {
      onStage('installing', 'npm install');
      await npm(['install', '--no-audit', '--no-fund', '--no-progress']);
    }
    if (scripts.build) {
      onStage('building', 'npm run build');
      await npm(['run', 'build']);
    }
    if (!existsSync(join(directory, 'main.cjs'))) throw new Error(`${repository} has no build script that writes main.cjs`);
    installs[spec.id] = { repo: repository, commit };
    writeFileSync(installsPath, JSON.stringify(installs, null, 2));
  }
  onStage('ready', worked ? undefined : '无需更新');
  return worked;
}
