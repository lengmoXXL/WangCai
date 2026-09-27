import { join } from 'node:path';
import { connect, type MachineConnection } from '@shu/sdk';
import type { FileClick, MainContext } from '@shu/sdk/plugin';

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  const remove = context.handle('read', async ({ machine, path }: FileClick) => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    try {
      connection = await connect(machine.host
        ? { type: 'ssh', host: machine.host, signal: controller.signal }
        : { type: 'local', binary: join(context.resourcesDirectory, 'shu'), signal: controller.signal });
      controller.signal.throwIfAborted();
      connections.add(connection);
      const bytes = await connection.fs.readFile(path);
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
  });
  return () => {
    remove();
    for (const controller of pending) controller.abort();
    for (const connection of connections) connection.disconnect();
  };
}
