import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { connect, type MachineConnection, type Pty, type WorkspaceActive } from '@wangcai/sdk';
import type { MainContext } from '@wangcai/sdk/channel';
import type { FileClick, Machine, TerminalRef } from './shared';

/** How long a path stays answered. */
const resolvedTtl = 10_000;

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
};

export async function activate(context: MainContext) {
  const path = join(context.host.dataDirectory, 'sessions.json');
  const sessions: Record<string, Machine> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, Machine> : {};
  const connections = new Map<string, MachineConnection>();
  const terminals = new Map<string, Pty>();
  const homes = new Map<string, Promise<string>>();
  const handlers: (() => void)[] = [];
  const key = (machine: Machine) => machine.host ?? machine.id;

  function save() {
    writeFileSync(`${path}.tmp`, JSON.stringify(sessions, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  async function connection(machine: Machine) {
    const existing = connections.get(key(machine));
    if (existing) return existing;
    const node = await connect(machine.host
      ? { type: 'ssh', host: machine.host, agent: context.host.agent }
      : { type: 'local', binary: join(context.host.resourcesDirectory, 'wangcai') });
    connections.set(key(machine), node);
    return node;
  }

  async function label(machine: Machine, node: MachineConnection, cwd: string) {
    let home = homes.get(key(machine));
    if (!home) {
      home = node.subprocess.exec('/bin/sh', ['-c', 'printf %s "$HOME"'], { cwd: '/' })
        .then((result) => result.code === 0 ? Buffer.from(result.stdout).toString().trim() : '')
        .catch(() => '');
      homes.set(key(machine), home);
    }
    return cwd === await home ? '~' : basename(cwd) || '/';
  }

  async function ref(machine: Machine, sessionId: string): Promise<TerminalRef> {
    const node = await connection(machine);
    const cwd = await node.pty.cwd(sessionId);
    return { machine, sessionId, label: await label(machine, node, cwd) };
  }

  handlers.push(context.ui.handle('open', async ({ machine, sessionId }: WorkspaceActive) => {
    const node = await connection(machine);
    const session = await node.pty.create({ rows: 24, cols: 80 }, await node.pty.cwd(sessionId));
    sessions[session.id] = machine;
    save();
    return ref(machine, session.id);
  }));
  handlers.push(context.ui.handle('describe', async (sessionId: string) => {
    const machine = sessions[sessionId];
    if (!machine) throw new Error('这个终端已经找不到了');
    return ref(machine, sessionId);
  }));
  // A hovered line asks which of the paths it printed exist, so only real paths become links.
  const resolved = new Map<string, string | undefined>();
  let resolvedUntil = 0;
  handlers.push(context.ui.handle('resolve', async ({ machine, sessionId, paths }: { machine: Machine; sessionId: string; paths: string[] }) => {
    const node = await connection(machine);
    if (Date.now() > resolvedUntil) {
      resolved.clear();
      resolvedUntil = Date.now() + resolvedTtl;
    }
    const cwd = await node.pty.cwd(sessionId);
    const wanted = paths.map((text) => ({
      text,
      key: `${machine.id}\0${cwd}\0${text}`,
      path: posix.isAbsolute(text) ? posix.resolve(text) : posix.resolve(cwd, text),
    }));
    // One look per path, all of them at once: a remote machine answers a batch in one round trip
    // rather than one per path.
    await Promise.all(wanted.map(async (item) => {
      if (resolved.has(item.key)) return;
      resolved.set(item.key, (await node.fs.stat(item.path)) ? item.path : undefined);
    }));
    const found: Record<string, string> = {};
    for (const item of wanted) {
      const path = resolved.get(item.key);
      if (path) found[item.text] = path;
    }
    return found;
  }));
  handlers.push(context.ui.handle('click', async ({ machine, sessionId, location }: { machine: Machine; sessionId: string; location: Pick<FileClick, 'path' | 'line' | 'column'> }) => {
    const node = await connection(machine);
    const path = posix.isAbsolute(location.path) ? posix.resolve(location.path) : posix.resolve(await node.pty.cwd(sessionId), location.path);
    const stat = await node.fs.stat(path);
    if (!stat) return;
    await context.global.publish('onclick', { type: stat.isDirectory ? 'directory' : 'file', machine, ...location, path });
  }));
  handlers.push(context.ui.handle('attach', async ({ machine, sessionId }: WorkspaceActive) => {
    const terminal = await (await connection(machine)).pty.attach(sessionId);
    terminals.set(sessionId, terminal);
    terminal.onSnapshot((event) => { context.ui.publish('terminal', { ...event, event: 'snapshot', session_id: terminal.id }); });
    terminal.onData((event) => { context.ui.publish('terminal', { ...event, event: 'output', session_id: terminal.id }); });
  }));
  handlers.push(context.ui.handle('pty', async ({ op, sessionId, params }: { op: string; sessionId: string; params: { data: string; rows: number; cols: number } }) => {
    const terminal = terminals.get(sessionId);
    if (!terminal) throw new Error('Terminal is not attached');
    if (op === 'detach') {
      terminals.delete(sessionId);
      await terminal.detach().catch(() => {});
      return;
    }
    if (op === 'input') return terminal.write(params.data);
    if (op === 'resize') return terminal.resize({ rows: params.rows, cols: params.cols });
    throw new Error(`Unknown terminal operation: ${op}`);
  }));
  handlers.push(context.ui.handle('close', async (sessionId: string) => {
    const machine = sessions[sessionId]!;
    delete sessions[sessionId];
    save();
    terminals.delete(sessionId);
    try { await (await connection(machine)).pty.close(sessionId); } catch { /* the session is gone either way */ }
  }));

  return () => {
    for (const remove of handlers) remove();
    for (const node of connections.values()) node.disconnect();
  };
}
