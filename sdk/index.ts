import { MachineConnection } from './connection';
import type { ConnectionOptions } from './types';
export type { ConnectionOptions, MachineState, Session, Size, Output, Snapshot, TerminalEvent, DirectoryEntry, ExecOptions, ExecResult, Profile, Theme } from './types';
export type { MachineConnection } from './connection';
export type { Pty } from './pty';

const connections = new Map<string, MachineConnection>();

export async function connect(options: ConnectionOptions) {
  options.signal?.throwIfAborted();
  const target = options.type === 'ssh' ? `ssh:${options.host}` : `local:${options.binary ?? 'wangcai'}`;
  const shared = connections.get(target);
  const machine = shared ?? new MachineConnection(options);
  if (shared) machine.retain();
  else {
    connections.set(target, machine);
    machine.onState((state) => { if (state.status === 'disconnected' && connections.get(target) === machine) connections.delete(target); });
  }
  const aborted = new Promise<never>((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('Connection cancelled')), { once: true });
  });
  try {
    await Promise.race([machine.ready, aborted]);
    return machine;
  } catch (error) {
    machine.disconnect();
    throw error;
  }
}
