import { openMachine, type ConnectionOptions, type MachineConnection } from '@lengmoxxl/sdk';

// One connection per machine for the whole app: a plugin that asks for a machine another plugin already
// holds gets that connection and counts as a holder of it, the last holder to disconnect closes it, and the
// entry goes with it. Asking while one is still opening waits for that one rather than opening a second.
const machines = new Map<string, MachineConnection>();
const opening = new Map<string, Promise<MachineConnection>>();

export async function connect(options: ConnectionOptions) {
  options.signal?.throwIfAborted();
  const target = options.type === 'ssh' ? `ssh:${options.host}` : `local:${options.binary ?? 'wangcai'}`;
  const held = machines.get(target);
  if (held) {
    held.retain();
    return held;
  }
  const joined = opening.get(target);
  const flight = joined ?? (async () => {
    const machine = await openMachine(options);
    machines.set(target, machine);
    machine.onState((state) => { if (state.status === 'disconnected' && machines.get(target) === machine) machines.delete(target); });
    return machine;
  })();
  opening.set(target, flight);
  try {
    const machine = await flight;
    if (joined) machine.retain();
    return machine;
  } finally {
    if (!joined) opening.delete(target);
  }
}
