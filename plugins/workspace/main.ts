import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, type MachineConnection, type Pty } from '@wangcai/sdk';
import type { FileClick, MainContext } from '@wangcai/sdk/plugin';
import type { Config, Machine, MachineState, Workspace } from './shared';

export function activate(context: MainContext) {
  const path = join(context.dataDirectory, 'config.json');
  let config: Config = { machines: [{ id: 'local', name: '本机' }], workspaces: [], selected: 'local' };
  const connections = new Map<string, MachineConnection>();
  const pending = new Map<string, { controller: AbortController; result: Promise<MachineState> }>();
  const terminals = new Map<string, Pty>();
  const states = new Map<string, MachineState>();
  const handlers: (() => void)[] = [];

  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Config;
    const machines: Machine[] = [{ id: 'local', name: '本机' }];
    for (const machine of stored.machines) {
      if (machine.id !== 'local' && machine.name && typeof machine.host === 'string' && /^[\w.@:+-]+$/.test(machine.host) && !machine.host.startsWith('-')) machines.push(machine);
    }
    const workspaces: Workspace[] = [];
    for (const workspace of stored.workspaces) {
      if (typeof workspace?.id !== 'string' || !machines.some((machine) => machine.id === workspace.machineId) || workspaces.some((item) => item.id === workspace.id)) continue;
      workspaces.push(workspace);
    }
    config = { machines, workspaces, selected: machines.some((m) => m.id === stored.selected) ? stored.selected : 'local' };
  }

  function save() {
    writeFileSync(`${path}.tmp`, JSON.stringify(config, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  function disconnect(id: string) {
    pending.get(id)?.controller.abort();
    pending.delete(id);
    connections.get(id)?.disconnect();
    connections.delete(id);
    for (const key of terminals.keys()) if (key.startsWith(`${id}:`)) terminals.delete(key);
    const previous = states.get(id);
    const state: MachineState = { machineId: id, status: 'disconnected', sessions: previous?.sessions ?? [], generation: previous?.generation ?? 0 };
    states.set(id, state);
    context.emit('state', state);
  }

  async function open(id: string): Promise<MachineState> {
    const active = connections.get(id);
    if (active) return { ...active.state, machineId: id };
    const opening = pending.get(id);
    if (opening) return opening.result;
    const machine = config.machines.find((machine) => machine.id === id);
    if (!machine) throw new Error('Unknown machine');
    const state: MachineState = { machineId: id, status: 'connecting', sessions: states.get(id)?.sessions ?? [], generation: 0 };
    states.set(id, state);
    context.emit('state', state);
    const controller = new AbortController();
    const result = (async () => {
      try {
        const node = await connect(machine.host
          ? { type: 'ssh', host: machine.host, signal: controller.signal }
          : { type: 'local', binary: join(context.resourcesDirectory, 'wangcai'), signal: controller.signal });
        if (controller.signal.aborted) { node.disconnect(); throw new Error('Connection cancelled'); }
        connections.set(id, node);
        node.onState((value) => {
          const state = { ...value, machineId: id };
          states.set(id, state);
          context.emit('state', state);
        });
        return { ...node.state, machineId: id };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failed: MachineState = { ...state, status: 'disconnected', error: String(error) };
        states.set(id, failed);
        context.emit('state', failed);
        throw error;
      } finally {
        if (pending.get(id)?.controller === controller) pending.delete(id);
      }
    })();
    pending.set(id, { controller, result });
    return result;
  }

  handlers.push(context.handle('click', async ({ id, sessionId, location }: { id: string; sessionId: string; location: Pick<FileClick, 'path' | 'line' | 'column'> }) => {
    const machine = config.machines.find((machine) => machine.id === id);
    const node = connections.get(id);
    if (!machine || !node) throw new Error('Machine is not connected');
    const path = posix.isAbsolute(location.path) ? posix.resolve(location.path) : posix.resolve(await node.pty.cwd(sessionId), location.path);
    const stat = await node.fs.stat(path);
    if (!stat) return;
    await context.publish('onclick', { type: stat.isDirectory ? 'directory' : 'file', machine, ...location, path });
  }));
  handlers.push(context.handle('config', () => config));
  handlers.push(context.handle('save-machine', (machine: { id?: string; name: string; host: string }) => {
    if (machine.id === 'local') throw new Error('The local machine cannot be edited.');
    const name = machine.name.trim();
    const host = machine.host.trim();
    if (!name || !/^[\w.@:+-]+$/.test(host) || host.startsWith('-')) throw new Error('请输入名称和有效的 SSH Host，例如 dev-server 或 user@host。');
    const id = machine.id ?? randomUUID();
    disconnect(id);
    const entry = { id, name, host };
    const index = config.machines.findIndex((item) => item.id === id);
    if (index < 0) config.machines.push(entry); else config.machines[index] = entry;
    save();
    return config;
  }));
  handlers.push(context.handle('remove-machine', (id: string) => {
    if (id === 'local') throw new Error('The local machine cannot be removed.');
    disconnect(id);
    config.machines = config.machines.filter((machine) => machine.id !== id);
    config.workspaces = config.workspaces.filter((workspace) => workspace.machineId !== id);
    if (config.selected === id) config.selected = 'local';
    save();
    return config;
  }));
  handlers.push(context.handle('select-machine', (id: string) => {
    if (!config.machines.some((machine) => machine.id === id)) throw new Error('Unknown machine');
    config.selected = id;
    save();
  }));
  handlers.push(context.handle('connect', open));
  handlers.push(context.handle('disconnect', disconnect));
  handlers.push(context.handle('open-workspace', async ({ machineId, workspaceId }: { machineId: string; workspaceId?: string }) => {
    let workspace = workspaceId ? config.workspaces.find((item) => item.id === workspaceId) : undefined;
    if (!workspace) {
      workspace = { id: randomUUID(), machineId };
      config.workspaces.push(workspace);
    }
    const node = connections.get(machineId);
    if (node) {
      const session = (await node.pty.list()).find((item) => item.id === workspace.sessionId);
      if (!session || session.exit_code !== null) {
        if (workspace.sessionId) await node.pty.close(workspace.sessionId).catch(() => {});
        workspace.sessionId = (await node.pty.create({ rows: 24, cols: 80 })).id;
      }
    }
    save();
    return { config, workspaceId: workspace.id };
  }));
  handlers.push(context.handle('close-workspace', async (id: string) => {
    const workspace = config.workspaces.find((item) => item.id === id);
    if (!workspace) return config;
    if (workspace.sessionId) {
      terminals.delete(`${workspace.machineId}:${workspace.sessionId}`);
      await connections.get(workspace.machineId)?.pty.close(workspace.sessionId).catch(() => {});
    }
    config.workspaces = config.workspaces.filter((item) => item.id !== id);
    save();
    return config;
  }));
  handlers.push(context.handle('pty', async ({ id, op, params }: { id: string; op: string; params: { session_id: string; data: string; rows: number; cols: number } }) => {
    const key = `${id}:${params.session_id}`;
    if (op === 'detach') {
      const terminal = terminals.get(key);
      terminals.delete(key);
      await terminal?.detach().catch(() => {});
      return;
    }
    const node = connections.get(id);
    if (!node) throw new Error('Machine is not connected');
    switch (op) {
      case 'attach': {
        const terminal = await node.pty.attach(params.session_id);
        terminals.set(key, terminal);
        terminal.onSnapshot((event) => context.emit('terminal', { ...event, event: 'snapshot', machineId: id, session_id: terminal.id }));
        terminal.onData((event) => context.emit('terminal', { ...event, event: 'output', machineId: id, session_id: terminal.id }));
        return;
      }
      case 'input':
      case 'resize': {
        const terminal = terminals.get(key);
        if (!terminal) throw new Error('Terminal is not attached');
        return op === 'input' ? terminal.write(params.data) : terminal.resize({ rows: params.rows, cols: params.cols });
      }
      default: throw new Error('Unknown terminal operation');
    }
  }));
  return () => {
    for (const remove of handlers) remove();
    for (const id of new Set([...connections.keys(), ...pending.keys()])) disconnect(id);
  };
}
