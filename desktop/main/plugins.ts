import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { Dispose, MainContext } from '@shu/sdk/plugin';
import type { PluginInfo } from '../shared';

export async function loadPlugins(sdkPath: string, resourcesDirectory: string, emit: (id: string, event: string, data: unknown) => void, broadcast: (event: string, data: unknown) => void) {
  const { build } = await import('esbuild');
  const directory = join(homedir(), '.local/shared/shu/plugins');
  const cache = join(homedir(), '.cache/shu/plugins');
  const plugins: PluginInfo[] = [];
  const handlers = new Map<string, Map<string, (params: any) => unknown>>();
  const disposers: Dispose[] = [];
  const channels = new Set<Map<string, Set<(data: any) => void | Promise<void>>>>();
  async function publish(event: string, data: unknown) {
    broadcast(event, data);
    await Promise.all([...channels].flatMap((subscriptions) => [...subscriptions.get(event) ?? []].map(async (callback) => {
      try { await callback(data); } catch (error) { console.error(`Plugin event ${event}:`, error); }
    })));
  }
  const requirePlugin = createRequire(__filename);
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const id = entry.name;
    const source = join(directory, id);
    const output = join(cache, id);
    const info: PluginInfo = { id };
    plugins.push(info);
    const methods = new Map<string, (params: any) => unknown>();
    handlers.set(id, methods);
    const subscriptions = new Map<string, Set<(data: any) => void | Promise<void>>>();
    channels.add(subscriptions);
    try {
      rmSync(output, { recursive: true, force: true });
      mkdirSync(output, { recursive: true });
      await build({
        entryPoints: [join(source, 'main.ts')], outfile: join(output, 'main.cjs'),
        bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: 'inline',
        plugins: [{ name: 'shu-sdk', setup(builder) {
          builder.onResolve({ filter: /^@shu\/sdk$/ }, () => ({ path: sdkPath, external: true }));
        } }],
      });
      if (existsSync(join(source, 'ui.tsx'))) {
        await build({
          entryPoints: [join(source, 'ui.tsx'), ...(existsSync(join(source, 'ui.worker.ts')) ? [join(source, 'ui.worker.ts')] : [])], outdir: output,
          loader: { '.ttf': 'file' },
          bundle: true, platform: 'browser', format: 'esm', target: 'chrome140', jsx: 'automatic',
          define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: 'inline',
          plugins: [{ name: 'node-sdk-boundary', setup(builder) {
            builder.onResolve({ filter: /^@shu\/sdk$/ }, () => ({ errors: [{ text: '@shu/sdk is only available in main.ts' }] }));
          } }],
        });
        info.ui = `shu-plugin://plugins/${encodeURIComponent(id)}/ui.js`;
        if (existsSync(join(output, 'ui.css'))) info.css = `shu-plugin://plugins/${encodeURIComponent(id)}/ui.css`;
      }
      const dataDirectory = join(homedir(), '.local/shared/shu/data', id);
      const logDirectory = join(homedir(), '.local/shared/shu/logs', id);
      mkdirSync(dataDirectory, { recursive: true });
      mkdirSync(logDirectory, { recursive: true });
      const context: MainContext = {
        dataDirectory, logDirectory, resourcesDirectory,
        publish,
        subscribe(event, callback) {
          let callbacks = subscriptions.get(event);
          if (!callbacks) subscriptions.set(event, callbacks = new Set());
          callbacks.add(callback);
          return () => { callbacks.delete(callback); };
        },
        handle(method, handler) {
          if (methods.has(method)) throw new Error(`Duplicate plugin method: ${method}`);
          methods.set(method, handler);
          return () => { methods.delete(method); };
        },
        emit: (event, data) => emit(id, event, data),
      };
      const module = requirePlugin(join(output, 'main.cjs'));
      const dispose = await module.activate(context);
      if (dispose) disposers.push(dispose);
    } catch (error) {
      info.error = error instanceof Error ? error.message : String(error);
      info.ui = undefined;
      info.css = undefined;
      methods.clear();
      subscriptions.clear();
      console.error(`Plugin ${id}:`, error);
    }
  }
  return {
    plugins, cache, publish,
    request(id: string, method: string, params: unknown) {
      const handler = handlers.get(id)?.get(method);
      if (!handler) throw new Error(`Unknown plugin method: ${id}/${method}`);
      return handler(params);
    },
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try { await dispose(); } catch (error) { console.error('Plugin cleanup:', error); }
      }
      handlers.clear();
      channels.clear();
    },
  };
}
