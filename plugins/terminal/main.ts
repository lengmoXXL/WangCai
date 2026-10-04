import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { connect, type AgentInfo, type MachineConnection, type Pty, type WorkspaceActive } from '@wangcai/sdk';
import type { Context } from '@wangcai/sdk/channel';
import type { Machine, TerminalRef } from './shared';

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
};

export async function activate(context: Context) {
  const path = join(await context.host.request<string>('dataDirectory'), 'sessions.json');
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
      ? { type: 'ssh', host: machine.host, agent: await context.host.request<AgentInfo>('agent') }
      : { type: 'local', binary: join(await context.host.request<string>('resourcesDirectory'), 'wangcai') });
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
  handlers.push(context.ui.handle('attach', async ({ machine, sessionId }: WorkspaceActive) => {
    const terminal = await (await connection(machine)).pty.attach(sessionId);
    terminals.set(sessionId, terminal);
    terminal.onSnapshot((event) => { void context.ui.publish('terminal', { ...event, event: 'snapshot', session_id: terminal.id }); });
    terminal.onData((event) => { void context.ui.publish('terminal', { ...event, event: 'output', session_id: terminal.id }); });
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
