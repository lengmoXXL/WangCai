import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

// GitHub is not reachable from every network the app runs on, and init.ts says what a run goes out through
// instead: a prefix that https://github.com/ URLs are rewritten to. An ssh remote cannot carry a prefix, so a
// git@github.com: clone goes out as it is.
export const mirroredUrl = (url: string, mirror?: string) => mirror && /^https:\/\/github\.com\//.test(url)
  ? `${mirror}${url}`
  : url;

// A blocked host can leave a connection hanging, so a transfer that stalls fails instead of never ending.
export const TRANSFER_LIMITS = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20'];

export function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv) {
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
export const withProxy = (proxy: string | undefined, environment = process.env) => {
  if (!proxy) return environment;
  const address = proxy.replace(/^socks5:\/\//, 'socks5h://');
  return { ...environment, http_proxy: address, https_proxy: address, all_proxy: address };
};

/** npm next to the node the app carries. */
export const npm = (node: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv) =>
  run(node, [join(dirname(node), 'npm'), ...args], cwd, environment);

/** npm and its node first on PATH, so a build script and the tools it runs find them. */
export const buildEnvironment = (node: string, environment: NodeJS.ProcessEnv) => ({ ...environment, PATH: `${dirname(node)}:${environment.PATH ?? ''}` });
