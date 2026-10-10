import { net } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentCommand } from '@lengmoxxl/sdk';
import { mirroredUrls } from './install';

const exec = promisify(execFile);
// Where the agent releases live: each one is under the tag of its own version.
const RELEASES = 'https://github.com/lengmoXXL/WangCai/releases/download';
// A prefix that never answers hands over to the next one rather than holding the connect up.
const DOWNLOAD_TIMEOUT = 30_000;
const TARGETS: Record<string, string> = {
  'Darwin x86_64': 'x86_64-apple-darwin',
  'Darwin arm64': 'aarch64-apple-darwin',
  'Linux x86_64': 'x86_64-unknown-linux-musl',
};

/**
 * What puts the agent this app carries on a machine, which the SDK asks for before it connects there.
 * The release is fetched and written over ssh stdin, so the machine needs neither curl nor a route to the
 * release host; the write lands through a temporary name, so a broken transfer cannot leave a half binary.
 */
export function agentInstaller(directory: string) {
  let version: Promise<string> | undefined;
  const prefixes = mirroredUrls(RELEASES);
  return async (host: string, signal?: AbortSignal) => {
    version ??= versionOf(directory);
    const remote = (command: string) => ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, agentCommand(command)];
    // A machine that refuses the probe keeps whatever it has: its own start command reports the real failure.
    const probe = await exec('ssh', remote('uname -s -m; wangcai --version 2>/dev/null; true'), { timeout: 30_000, signal }).catch(() => undefined);
    const [platform, installed] = (probe?.stdout ?? '').split('\n').map((line) => line.trim());
    if (!platform) return;
    const target = TARGETS[platform];
    if (!target) throw new Error(`${platform} 上暂不支持自动安装 agent`);
    if (installed === `wangcai ${await version}`) return;
    const failures: string[] = [];
    for (const prefix of prefixes) {
      signal?.throwIfAborted();
      const url = `${prefix}/agent-v${await version}/wangcai-${target}`;
      const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT);
      let binary: Buffer;
      try {
        // The app's own fetch goes through the network stack, so a machine behind a proxy is still reached.
        const response = await net.fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        binary = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        failures.push(`${url}\n${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const command = 'mkdir -p ~/.local/bin && cat > ~/.local/bin/.wangcai.tmp && chmod 755 ~/.local/bin/.wangcai.tmp && mv ~/.local/bin/.wangcai.tmp ~/.local/bin/wangcai';
        const child = spawn('ssh', remote(command), { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `写入 agent 失败（ssh 退出码 ${code}）`)));
        child.stdin.end(binary);
      });
      return;
    }
    throw new Error(`下载 agent 失败：\n${failures.join('\n\n')}`);
  };
}

/** The version of the agent this app carries, which is the release a machine installs it from. */
async function versionOf(directory: string) {
  const { stdout } = await exec(join(directory, 'wangcai'), ['--version']);
  return stdout.trim().split(' ')[1];
}
