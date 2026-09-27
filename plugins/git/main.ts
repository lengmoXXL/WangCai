import { join } from 'node:path';
import { connect, type MachineConnection } from '@wangcai/sdk';
import type { MainContext } from '@wangcai/sdk/plugin';
import { readGit, type RunGit } from './git';
import type { GitRequest } from './shared';

export function activate(context: MainContext) {
  const pending = new Set<AbortController>();
  const connections = new Set<MachineConnection>();
  const handlers = ['overview', 'history', 'files', 'diff'].map(method => context.handle(method, async (query: GitRequest) => {
    const controller = new AbortController();
    pending.add(controller);
    let connection: MachineConnection | undefined;
    try {
      const { machine, sessionId } = query.terminal;
      connection = await connect(machine.host
        ? { type: 'ssh', host: machine.host, signal: controller.signal }
        : { type: 'local', binary: join(context.resourcesDirectory, 'wangcai'), signal: controller.signal });
      controller.signal.throwIfAborted();
      connections.add(connection);
      const cwd = method === 'overview' ? await connection.pty.cwd(sessionId) : query.root!;
      const run: RunGit = async (cwd, args) => {
        const result = await connection!.subprocess.exec('git', ['--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...args], {
          cwd, env: { GIT_OPTIONAL_LOCKS: '0' },
        });
        return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr).toString(), code: result.code };
      };
      return await readGit(method, cwd, query, run, path => connection!.fs.readFile(path));
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
