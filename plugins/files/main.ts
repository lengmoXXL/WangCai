import { join } from 'node:path';
import { connect, type MachineConnection } from '@wangcai/sdk';
import type { MainContext } from '@wangcai/sdk/channel';
import { imageMime, type FileClick } from './shared';

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 12 },
    lineHeight: { type: 'number' },
  },
};

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  const handlers = ['read', 'list'].map((method) => context.ui.handle(method, async ({ machine, path, sessionId }: { machine: FileClick['machine']; path?: string; sessionId?: string }) => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    try {
      connection = await connect(machine.host
        ? { type: 'ssh', host: machine.host, agent: context.host.agent, signal: controller.signal }
        : { type: 'local', binary: join(context.host.resourcesDirectory, 'wangcai'), signal: controller.signal });
      controller.signal.throwIfAborted();
      connections.add(connection);
      if (method === 'list') {
        const directory = path ?? await connection.pty.cwd(sessionId!);
        const entries = await connection.fs.readDirectory(directory);
        entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
        return { path: directory, entries };
      }
      const bytes = await connection.fs.readFile(path!);
      const image = imageMime(path!);
      if (image) return `data:${image};base64,${Buffer.from(bytes).toString('base64')}`;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('暂不支持二进制或非 UTF-8 文件'); }
      if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new Error('暂不支持二进制文件');
      return text;
    } finally {
      connection?.disconnect();
      if (connection) connections.delete(connection);
      pending.delete(controller);
    }
  }));
  return () => {
    for (const remove of handlers) remove();
    for (const controller of pending) controller.abort();
    for (const connection of connections) connection.disconnect();
  };
}
