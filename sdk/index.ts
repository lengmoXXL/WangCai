import { MachineConnection } from './connection';
import type { ConnectionOptions } from './types';
export type { ConnectionOptions, MachineState, Session, Size, Output, Snapshot } from './types';
export type { MachineConnection } from './connection';
export type { Pty } from './pty';

export async function connect(options: ConnectionOptions) {
  options.signal?.throwIfAborted();
  const machine = new MachineConnection(options);
  const cancel = () => machine.disconnect();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    await machine.ready;
    return machine;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
