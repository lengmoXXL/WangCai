import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentInfo } from './types';

const exec = promisify(execFile);

// What a command that reaches the agent runs with: the bin directory the agent is installed in, and
// the home a development profile keeps its state in, which the agent reads the same way the app does.
export function agentCommand(command: string) {
  const home = process.env.WANGCAI_HOME;
  const exportHome = home ? `export WANGCAI_HOME='${home.replace(/'/g, String.raw`'\''`)}'; ` : '';
  return `${exportHome}export PATH="$HOME/.local/bin:$PATH"; ${command}`;
}

// The release is fetched here and written over ssh stdin, so the machine needs neither curl nor a route to the
// release host; the write lands through a temporary name, so a broken transfer cannot leave a half binary.
export async function ensureAgent(host: string, { version, prefix, signal }: AgentInfo & { signal?: AbortSignal }) {
  const targets: Record<string, string> = {
    'Darwin x86_64': 'x86_64-apple-darwin',
    'Darwin arm64': 'aarch64-apple-darwin',
    'Linux x86_64': 'x86_64-unknown-linux-musl',
  };
  const remote = (command: string) => ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, command];
  // A machine that refuses the probe keeps whatever it has: its own start command reports the real failure.
  const probe = await exec('ssh', remote(agentCommand('uname -s -m; wangcai --version 2>/dev/null; true')), { timeout: 30_000, signal }).catch(() => undefined);
  const [platform, installed] = (probe?.stdout ?? '').split('\n').map((line) => line.trim());
  if (!platform) return;
  const target = targets[platform];
  if (!target) throw new Error(`${platform} 上暂不支持自动安装 agent`);
  if (installed === `wangcai ${version}`) return;
  const response = await fetch(`${prefix}/v${version}/wangcai-${target}`, { signal });
  if (!response.ok) throw new Error(`下载 agent 失败：${response.status} ${response.statusText}`);
  const binary = Buffer.from(await response.arrayBuffer());
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', remote('mkdir -p ~/.local/bin && cat > ~/.local/bin/.wangcai.tmp && chmod 755 ~/.local/bin/.wangcai.tmp && mv ~/.local/bin/.wangcai.tmp ~/.local/bin/wangcai'), { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `写入 agent 失败（ssh 退出码 ${code}）`)));
    child.stdin.end(binary);
  });
}
