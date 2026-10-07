import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pluginDirectory, type PluginSpec } from './config';
import type { InstallStage } from '../shared';

// How far a repository got: the commit it was built from, so the next start rebuilds only what moved.
type Installs = Record<string, { repo: string; commit: string }>;

// GitHub is not reachable from every network the app runs on, so a clone or a fetch that fails is retried
// through the mirrors that serve it. The repository itself comes first: a network that reaches GitHub never
// pays for them, and whichever URL answers becomes the remote the checkout keeps.
const GITHUB_MIRRORS = ['https://ghfast.top/', 'https://ghproxy.net/', 'https://gh-proxy.com/', 'https://gh.llkk.cc/'];
export const repositoryUrls = (repository: string) => /^https:\/\/github\.com\//.test(repository)
  ? [repository, ...GITHUB_MIRRORS.map((mirror) => mirror + repository)]
  : [repository];

// A blocked host can leave a connection hanging, so a transfer that stalls fails instead of never ending.
const TRANSFER_LIMITS = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20'];

/** Runs a command and rejects with the last lines it wrote, which is what a build failure is worth reading. */
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

/** Clones or fetches through whichever of the repository's URLs answers first. */
async function throughMirrors(repository: string, attempt: (url: string) => Promise<void>) {
  const failures: string[] = [];
  for (const url of repositoryUrls(repository)) {
    try {
      await attempt(url);
      return;
    } catch (error) {
      failures.push(`${url}\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(failures.join('\n\n'));
}

/**
 * Brings a repository plugin up to date and builds it, so the loader finds the files it expects.
 * `node` is the runtime the app carries; the plugin's own build script decides what a build is.
 */
export async function installPlugin(spec: PluginSpec, node: string, installsPath: string, onStage: (stage: InstallStage, message?: string) => void) {
  const directory = pluginDirectory(spec);
  const repository = spec.repo;
  if (!repository) return;
  const installs = existsSync(installsPath) ? JSON.parse(readFileSync(installsPath, 'utf8')) as Installs : {};
  const stamp = installs[spec.id];
  const builtFrom = (commit: string) => stamp?.repo === repository && stamp.commit === commit && existsSync(join(directory, 'main.cjs'));
  // A build of the commit init.ts pins is what the app is meant to run, so it starts from it without a
  // network at all.
  if (spec.commit && builtFrom(spec.commit)) {
    onStage('ready');
    return;
  }
  const git = (args: string[]) => run('git', args, directory);
  if (!existsSync(join(directory, '.git'))) {
    const entries = existsSync(directory) ? readdirSync(directory) : [];
    if (entries.length) throw new Error(`${directory} exists and is not a clone of ${repository}`);
    mkdirSync(dirname(directory), { recursive: true });
    await throughMirrors(repository, async (url) => {
      onStage('cloning', `git clone ${url}`);
      await run('git', [...TRANSFER_LIMITS, 'clone', url, directory], dirname(directory));
    });
  }
  // A commit that is already here needs no network: an offline start rebuilds what it has.
  const hasCommit = spec.commit ? await run('git', ['cat-file', '-e', `${spec.commit}^{commit}`], directory).then(() => true, () => false) : false;
  if (spec.commit && !hasCommit) {
    await throughMirrors(repository, async (url) => {
      onStage('cloning', `git fetch ${url} ${spec.commit}`);
      await git(['remote', 'set-url', 'origin', url]);
      await git([...TRANSFER_LIMITS, 'fetch', 'origin']);
    });
  }
  if (spec.commit) await git(['checkout', '--force', spec.commit]);
  else await git(['pull', '--ff-only']);
  const commit = (await git(['rev-parse', 'HEAD'])).trim();

  if (!builtFrom(commit)) {
    const scripts = existsSync(join(directory, 'package.json')) ? (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts ?? {}) : {};
    // npm and its own directory come first on PATH, so a plugin's build script and the tools it runs
    // resolve to the runtime the app carries rather than whatever the user happens to have installed.
    const environment = { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ''}` };
    const npm = (args: string[]) => run(node, [join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'), ...args], directory, environment);
    if (Object.keys(scripts).length) {
      onStage('installing', 'npm install');
      await npm(['install', '--no-audit', '--no-fund', '--no-progress']);
      // The SDK a plugin compiles against: the app injects its implementation at load time, so only the
      // types travel. Where they are is the SDK's own declaration, and they are copied after npm install,
      // which would otherwise prune this directory.
      const sdk = dirname(require.resolve('@lengmoxxl/sdk/package.json'));
      const { types } = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')) as { types: string };
      const from = dirname(join(sdk, types));
      // A plugin names the SDK in its imports, and one pinned by an older release still names the old one.
      for (const name of ['@lengmoxxl/sdk', '@wangcai/sdk']) {
        const dev = join(directory, 'node_modules', name);
        const to = join(dev, dirname(types));
        mkdirSync(to, { recursive: true });
        copyFileSync(join(sdk, 'package.json'), join(dev, 'package.json'));
        for (const entry of readdirSync(from)) if (entry.endsWith('.d.ts')) copyFileSync(join(from, entry), join(to, entry));
      }
    }
    if (scripts.build) {
      onStage('building', 'npm run build');
      await npm(['run', 'build']);
    }
    if (!existsSync(join(directory, 'main.cjs'))) throw new Error(`${repository} has no build script that writes main.cjs`);
    installs[spec.id] = { repo: repository, commit };
    writeFileSync(installsPath, JSON.stringify(installs, null, 2));
  }
  onStage('ready');
}
