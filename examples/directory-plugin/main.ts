import type { MainContext } from '@lengmoxxl/sdk/channel';

export const config = {
  host: { type: 'string', default: '' },
  directory: { type: 'string', default: '/' },
};

export function activate(context: MainContext) {
  return context.ui.handle<{ path: string }>('list', async ({ path }) => {
    const machine = await context.connect({
      host: context.host.config.host || undefined,
    });
    try {
      const entries = await machine.fs.readDirectory(path);
      context.ui.publish('listed', { path, count: entries.length });
      return entries;
    } finally {
      machine.disconnect();
    }
  });
}
