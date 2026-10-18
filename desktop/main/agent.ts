import { net } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentCommand } from '@lengmoxxl/sdk';
import type { Network } from './config';

const exec = promisify(execFile);
// Where the agent releases live: each one is under the tag of its own version.
const RELEASES = 'https://github.com/lengmoXXL/WangCai/releases/download';
// A download that stalls fails instead of holding the connect up for good.
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
export function agentInstaller(directory: string, network: Network) {
  let version: Promise<string> | undefined;
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
    const release = `${RELEASES}/agent-v${await version}/wangcai-${target}`;
    const url = network.mirror ? `${network.mirror}${release}` : release;
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT);
    const until = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let binary: Buffer;
    try {
      const expected = await publishedDigest(`${url}.sha256`, until);
      // The app's own fetch goes through the session, which is where the proxy init.ts names is set.
      const response = await net.fetch(url, { signal: until });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      binary = Buffer.from(await response.arrayBuffer());
      const digest = createHash('sha256').update(binary).digest('hex');
      if (digest !== expected) throw new Error(`sha256 不符：期望 ${expected}，得到 ${digest}`);
    } catch (error) {
      // A cancel is not a download failure: the connect that asked for this was aborted.
      signal?.throwIfAborted();
      throw new Error(`下载 agent 失败：${url}\n${error instanceof Error ? error.message : String(error)}`);
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
  };
}

// Every asset is published beside its digest, from the same prefix: what a mirror answers for one has to
// agree with the other, so an error page or a half file never reaches the machine.
async function publishedDigest(url: string, signal: AbortSignal) {
  const response = await net.fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const digest = (await response.text()).trim();
  if (!/^[0-9a-f]{64}$/i.test(digest)) throw new Error('发布目录里的校验值不是 sha256');
  return digest.toLowerCase();
}

/** The version of the agent this app carries, which is the release a machine installs it from. */
async function versionOf(directory: string) {
  const { stdout } = await exec(join(directory, 'wangcai'), ['--version']);
  return stdout.trim().split(' ')[1];
}
