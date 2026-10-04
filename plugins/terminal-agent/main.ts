import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, type AgentInfo, type MachineConnection, type Pty, type WorkspaceActive, type WorkspaceRow } from '@wangcai/sdk';
import type { Context } from '@wangcai/sdk/channel';
import type { FileClick, Machine, MachineState, Workspace } from './shared';

// Which fields this plugin takes from init.ts, and the default each one falls back to.
export const config = {
  font: {
    family: { type: 'string', default: '"DejaVuSansM Nerd Font Mono", monospace' },
    size: { type: 'number', default: 13 },
    lineHeight: { type: 'number', default: 1 },
  },
  machines: { type: 'array', default: [] },
};

const LOCAL: Machine = { id: 'local', name: '本机' };

/** The hosts init.ts names, with the local machine always first; a host is both the id and the identity. */
function machineList(given: unknown[]): Machine[] {
  const machines = [LOCAL];
  for (const entry of given) {
    const { name, host } = (entry ?? {}) as { name?: unknown; host?: unknown };
    if (typeof name !== 'string' || !name.trim() || typeof host !== 'string' || host === 'local' || host.startsWith('-') || !/^[\w.@:+-]+$/.test(host)) {
      console.error('Unusable machine in init.ts, expected { name, host }:', entry);
      continue;
    }
    if (machines.some((machine) => machine.id === host)) continue;
    machines.push({ id: host, name: name.trim(), host });
  }
  return machines;
}

export async function activate(context: Context) {
  const path = join(await context.host.request('dataDirectory'), 'config.json');
  const settings = await context.host.request<{ machines: unknown[] }>('config');
  const machines = machineList(settings.machines);
  let workspaces: Workspace[] = [];
  let active: string | undefined;
  const connections = new Map<string, MachineConnection>();
  const pending = new Map<string, { controller: AbortController; result: Promise<MachineState> }>();
  const terminals = new Map<string, Pty>();
  const states = new Map<string, MachineState>();
  const failures = new Map<string, string>();
  const handlers: (() => void)[] = [];

  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { workspaces: Workspace[] };
    const kept: Workspace[] = [];
    // A workspace on a machine init.ts no longer names has nowhere to run, so it is dropped.
    for (const workspace of stored.workspaces) {
      if (typeof workspace?.id !== 'string' || !machines.some((machine) => machine.id === workspace.machineId) || kept.some((item) => item.id === workspace.id)) continue;
      kept.push(workspace);
    }
    workspaces = kept;
  }

  function save() {
    writeFileSync(`${path}.tmp`, JSON.stringify({ workspaces }, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  function disconnect(id: string) {
    pending.get(id)?.controller.abort();
    pending.delete(id);
    connections.get(id)?.disconnect();
    connections.delete(id);
    for (const key of terminals.keys()) if (key.startsWith(`${id}:`)) terminals.delete(key);
  }

  async function open(id: string): Promise<MachineState> {
    const connected = connections.get(id);
    if (connected) return { ...connected.state, machineId: id };
    const opening = pending.get(id);
    if (opening) return opening.result;
    const machine = machines.find((machine) => machine.id === id);
    if (!machine) throw new Error('Unknown machine');
    const state: MachineState = { machineId: id, status: 'connecting', sessions: states.get(id)?.sessions ?? [], generation: 0 };
    states.set(id, state);
    void context.ui.publish('state', state);
    const controller = new AbortController();
    const result = (async () => {
      try {
        const node = await connect(machine.host
          ? { type: 'ssh', host: machine.host, agent: await context.host.request<AgentInfo>('agent'), signal: controller.signal }
          : { type: 'local', binary: join(await context.host.request('resourcesDirectory'), 'wangcai'), signal: controller.signal });
        if (controller.signal.aborted) { node.disconnect(); throw new Error('Connection cancelled'); }
        connections.set(id, node);
        node.onState((value) => {
          const state = { ...value, machineId: id };
          states.set(id, state);
          void context.ui.publish('state', state);
          void announce();
        });
        return { ...node.state, machineId: id };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const failed: MachineState = { ...state, status: 'disconnected', error: String(error) };
        states.set(id, failed);
        void context.ui.publish('state', failed);
        throw error;
      } finally {
        if (pending.get(id)?.controller === controller) pending.delete(id);
      }
    })();
    pending.set(id, { controller, result });
    return result;
  }

  /** A workspace needs a live terminal on a connected machine; a dead or missing one is replaced. */
  async function ensure(workspace: Workspace) {
    const node = connections.get(workspace.machineId)!;
    const session = workspace.sessionId === undefined ? undefined : (await node.pty.list()).find((item) => item.id === workspace.sessionId);
    if (session && session.exit_code === null) return;
    if (workspace.sessionId !== undefined) await node.pty.close(workspace.sessionId).catch(() => {});
    workspace.sessionId = (await node.pty.create({ rows: 24, cols: 80 })).id;
  }

  function sessionFor(workspace: Workspace) {
    return states.get(workspace.machineId)?.sessions.find((item) => item.id === workspace.sessionId);
  }

  function rows(): WorkspaceRow[] {
    return workspaces.map((workspace, index) => {
      const session = sessionFor(workspace);
      return {
        id: workspace.id,
        label: workspace.name ?? `工作区 ${index + 1}`,
        machine: machines.find((machine) => machine.id === workspace.machineId)!.name,
        running: session?.exit_code === null,
      };
    });
  }

  let announced = '';
  // The window draws the list from this, and the tab views follow whichever workspace is in front.
  async function announce() {
    await context.ui.publish('config', { workspaces, active });
    const list = rows();
    // A listener acts on a change; republishing a list it already has only sends it round again.
    const current = JSON.stringify(list);
    if (current !== announced) {
      announced = current;
      await context.global.publish('workspaces', list);
    }
    const workspace = workspaces.find((item) => item.id === active);
    const machine = workspace && machines.find((machine) => machine.id === workspace.machineId);
    const session = workspace && sessionFor(workspace);
    // A tab view that opens later asks for this again, so it is answered every time it is asked.
    const front: WorkspaceActive | null = machine && workspace && session?.exit_code === null ? { machine, sessionId: session.id, workspaceId: workspace.id } : null;
    await context.global.publish('workspace:active', front);
  }

  handlers.push(context.ui.handle('click', async ({ id, sessionId, location }: { id: string; sessionId: string; location: Pick<FileClick, 'path' | 'line' | 'column'> }) => {
    const machine = machines.find((machine) => machine.id === id);
    const node = connections.get(id);
    if (!machine || !node) throw new Error('Machine is not connected');
    const path = posix.isAbsolute(location.path) ? posix.resolve(location.path) : posix.resolve(await node.pty.cwd(sessionId), location.path);
    const stat = await node.fs.stat(path);
    if (!stat) return;
    await context.global.publish('onclick', { type: stat.isDirectory ? 'directory' : 'file', machine, ...location, path });
  }));
  handlers.push(context.ui.handle('config', () => ({ workspaces, active })));
  handlers.push(context.ui.handle('workspaces', rows));
  handlers.push(context.ui.handle('states', () => [...states.values()]));
  handlers.push(context.ui.handle('workspace-menu', () => machines.map((machine) => ({
    key: machine.id,
    label: machine.name,
    hint: machine.host,
    error: failures.get(machine.id),
  }))));
  handlers.push(context.ui.handle('workspace-create', async ({ key }: { key: string }) => {
    const machine = machines.find((machine) => machine.id === key);
    if (!machine) throw new Error('Unknown machine');
    try {
      await open(machine.id);
      failures.delete(machine.id);
    } catch (error) {
      failures.set(machine.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const workspace: Workspace = { id: randomUUID(), machineId: machine.id };
    workspaces.push(workspace);
    active = workspace.id;
    await ensure(workspace);
    save();
    await announce();
    return { id: workspace.id };
  }));
  handlers.push(context.ui.handle('workspace-select', async ({ id }: { id: string }) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error('Unknown workspace');
    active = id;
    try {
      await open(workspace.machineId);
      failures.delete(workspace.machineId);
      await ensure(workspace);
      save();
    } catch (error) {
      failures.set(workspace.machineId, error instanceof Error ? error.message : String(error));
      await announce();
      throw error;
    }
    await announce();
  }));
  handlers.push(context.ui.handle('workspace-close', async ({ id }: { id: string }) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    if (workspace.sessionId !== undefined) {
      terminals.delete(`${workspace.machineId}:${workspace.sessionId}`);
      await connections.get(workspace.machineId)?.pty.close(workspace.sessionId).catch(() => {});
    }
    workspaces = workspaces.filter((item) => item.id !== id);
    if (active === id) active = undefined;
    save();
    await announce();
  }));
  handlers.push(context.ui.handle('workspace-move', ({ id, before }: { id: string; before?: string }) => {
    if (id === before) return;
    const index = workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) return;
    const [workspace] = workspaces.splice(index, 1);
    const target = workspaces.findIndex((item) => item.id === before);
    workspaces.splice(target < 0 ? workspaces.length : target, 0, workspace);
    save();
    void announce();
  }));
  handlers.push(context.global.subscribe('workspace:query', () => { void announce(); }));
  handlers.push(context.ui.handle('pty', async ({ id, op, params }: { id: string; op: string; params: { session_id: string; data: string; rows: number; cols: number } }) => {
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
        terminal.onSnapshot((event) => { void context.ui.publish('terminal', { ...event, event: 'snapshot', machineId: id, session_id: terminal.id }); });
        terminal.onData((event) => { void context.ui.publish('terminal', { ...event, event: 'output', machineId: id, session_id: terminal.id }); });
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
  const homes = new Map<string, Promise<string>>();
  function homeOf(machineId: string, node: MachineConnection) {
    let value = homes.get(machineId);
    if (!value) {
      value = node.subprocess.exec('/bin/sh', ['-c', 'printf %s "$HOME"'], { cwd: '/' })
        .then((result) => result.code === 0 ? Buffer.from(result.stdout).toString().trim() : '')
        .catch(() => '');
      homes.set(machineId, value);
    }
    return value;
  }

  let renaming = false;
  async function rename() {
    if (renaming) return;
    renaming = true;
    try {
      let changed = false;
      for (const workspace of workspaces) {
        const node = connections.get(workspace.machineId);
        if (!node || !workspace.sessionId) continue;
        let cwd: string;
        try { cwd = await node.pty.cwd(workspace.sessionId); } catch { continue; }
        const home = await homeOf(workspace.machineId, node);
        const name = cwd === home ? '~' : posix.basename(cwd) || '/';
        if (name !== workspace.name) {
          workspace.name = name;
          changed = true;
        }
      }
      if (changed) {
        save();
        await announce();
      }
    } finally {
      renaming = false;
    }
  }
  const renamer = setInterval(() => void rename(), 1000);
  return () => {
    clearInterval(renamer);
    for (const remove of handlers) remove();
    for (const id of new Set([...connections.keys(), ...pending.keys()])) disconnect(id);
  };
}
