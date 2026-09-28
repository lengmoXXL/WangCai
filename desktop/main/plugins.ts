import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { Channel, Context } from '@wangcai/sdk/channel';
import { denied, type Dispose, type PluginInfo } from '../shared';

export async function loadPlugins(sdkPath: string, resourcesDirectory: string, emit: (id: string, event: string, data: unknown) => void, broadcast: (event: string, data: unknown) => void) {
  const { build } = await import('esbuild');
  const directory = join(homedir(), '.local/shared/wangcai/plugins');
  const cache = join(homedir(), '.cache/wangcai/plugins');
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
      await build({
        entryPoints: [join(source, 'main.ts')], outfile: join(output, 'main.cjs'),
        bundle: true, platform: 'node', target: 'node22', sourcemap: 'inline',
        plugins: [{ name: 'wangcai-sdk', setup(builder) {
          builder.onResolve({ filter: /^@wangcai\/sdk$/ }, () => ({ path: sdkPath, external: true }));
        } }],
      });
      if (existsSync(join(source, 'ui.tsx'))) {
        await build({
          entryPoints: [join(source, 'ui.tsx'), ...(existsSync(join(source, 'ui.worker.ts')) ? [join(source, 'ui.worker.ts')] : [])], outdir: output,
          loader: { '.ttf': 'file' },
          bundle: true, format: 'esm', target: 'chrome140', jsx: 'automatic',
          define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: 'inline',
          plugins: [{ name: 'node-sdk-boundary', setup(builder) {
            builder.onResolve({ filter: /^@wangcai\/sdk$/ }, () => ({ errors: [{ text: '@wangcai/sdk is only available in main.ts' }] }));
          } }],
        });
        info.ui = `wangcai-plugin://plugins/${encodeURIComponent(id)}/ui.js`;
        if (existsSync(join(output, 'ui.css'))) info.css = `wangcai-plugin://plugins/${encodeURIComponent(id)}/ui.css`;
      }
      const dataDirectory = join(homedir(), '.local/shared/wangcai/data', id);
      const logDirectory = join(homedir(), '.local/shared/wangcai/logs', id);
      mkdirSync(dataDirectory, { recursive: true });
      mkdirSync(logDirectory, { recursive: true });
      const context: Context = {
        global: {
          publish,
          subscribe(topic, callback) {
            let callbacks = subscriptions.get(topic);
            if (!callbacks) subscriptions.set(topic, callbacks = new Set());
            callbacks.add(callback);
            return () => { callbacks.delete(callback); };
          },
          request: denied('global', 'request'),
          handle: denied('global', 'handle'),
        },
        ui: {
          publish: async (topic, data) => { emit(id, topic, data); },
          subscribe: denied('ui', 'subscribe'),
          request: denied('ui', 'request'),
          handle(topic, handler) {
            if (topic.includes(':')) throw new Error(`Plugin method names cannot contain ":": ${topic}`);
            if (methods.has(topic)) throw new Error(`Duplicate plugin method: ${topic}`);
            methods.set(topic, handler);
            return () => { methods.delete(topic); };
          },
        },
        host: {
          publish: denied('host', 'publish'),
          subscribe: denied('host', 'subscribe'),
          request: (async (topic: string) => {
            if (topic === 'dataDirectory') return dataDirectory;
            if (topic === 'logDirectory') return logDirectory;
            if (topic === 'resourcesDirectory') return resourcesDirectory;
            throw new Error(`Unsupported host topic: ${topic}`);
          }) as Channel['request'],
          handle: denied('host', 'handle'),
        },
      };
      const dispose = await requirePlugin(join(output, 'main.cjs')).activate(context);
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
