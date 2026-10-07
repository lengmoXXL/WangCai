import { MachineConnection } from './connection';
import type { ConnectionOptions } from './types';
export type { AgentInfo, ConnectionOptions, FileClick, Machine, MachineState, Session, Size, Output, Snapshot, TerminalEvent, DirectoryEntry, ExecOptions, ExecResult, Profile, Theme, WorkspaceActive, WorkspaceRow, WorkspaceMenuItem } from './types';
export type { MachineConnection } from './connection';
export type { Pty } from './pty';

/** Opens one connection to a machine and waits for it to be ready. */
export async function openMachine(options: ConnectionOptions) {
  options.signal?.throwIfAborted();
  const machine = new MachineConnection(options);
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
