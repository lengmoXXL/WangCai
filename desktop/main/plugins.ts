import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import type { AgentInfo, Profile } from '@wangcai/sdk';
import type { Channel, Context } from '@wangcai/sdk/channel';
import { denied, type Dispose, type PluginInfo } from '../shared';
import { configDirectory, type PluginSpec } from './config';

// A schema is an object of leaves, each naming the type it takes and the default to use without one.
// Only keys the schema lists survive, so a plugin decides for itself which config it accepts.
function resolveConfig(schema: unknown, values: unknown): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (typeof schema !== 'object' || schema === null) return settings;
  const given = (typeof values === 'object' && values !== null ? values : {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(schema as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const declared = entry as { type?: unknown; default?: unknown };
    if (typeof declared.type === 'string') {
      const value = typeof given[key] === declared.type ? given[key] : declared.default;
      if (value !== undefined) settings[key] = value;
      continue;
    }
    const nested = resolveConfig(entry, given[key]);
    if (Object.keys(nested).length) settings[key] = nested;
  }
  return settings;
}

export async function loadPlugins(sdkPath: string, resourcesDirectory: string, bundled: string, agent: AgentInfo, profile: Profile, specs: PluginSpec[], emit: (id: string, event: string, data: unknown) => void, broadcast: (event: string, data: unknown) => void) {
  const userPlugins = join(configDirectory, 'plugins');
  const plugins: PluginInfo[] = [];
  const directories = new Map<string, string>();
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
  // Plugins mount in id order, not in the order init.ts lists them: a plugin publishes events as it
  // mounts, so what one plugin observes must not depend on the config file.
  for (const spec of [...specs].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = spec.id;
    const info: PluginInfo = { id, config: {} };
    plugins.push(info);
    const methods = new Map<string, (params: any) => unknown>();
    handlers.set(id, methods);
    const subscriptions = new Map<string, Set<(data: any) => void | Promise<void>>>();
    channels.add(subscriptions);
    try {
      const directory = spec.directory ?? (existsSync(join(userPlugins, id)) ? join(userPlugins, id) : join(bundled, id));
      const filename = join(directory, 'main.cjs');
      if (!existsSync(filename)) throw new Error('Plugin is not installed');
      if (existsSync(join(directory, 'ui.js'))) {
        info.ui = `wangcai-plugin://plugins/${encodeURIComponent(id)}/ui.js`;
        if (existsSync(join(directory, 'ui.css'))) info.css = `wangcai-plugin://plugins/${encodeURIComponent(id)}/ui.css`;
      }
      const localRequire = createRequire(filename);
      // Prebuilt plugins use the host SDK so its connection pool stays shared across plugins.
      const pluginRequire = Object.assign((name: string) => name === '@wangcai/sdk' ? requirePlugin(sdkPath) : localRequire(name), localRequire);
      const module = { exports: {} as { activate(context: Context): void | Dispose | Promise<void | Dispose>; config?: unknown } };
      compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'], { filename })
        .call(module.exports, pluginRequire, module, module.exports, filename, dirname(filename));
      // The app knows nothing about the fields a plugin takes.
      const settings = resolveConfig(module.exports.config, spec.config);
      info.config = settings;
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
            if (topic === 'agent') return agent;
            if (topic === 'config') return { ...profile, ...settings };
            throw new Error(`Unsupported host topic: ${topic}`);
          }) as Channel['request'],
          handle: denied('host', 'handle'),
        },
      };
      const dispose = await module.exports.activate(context);
      if (dispose) disposers.push(dispose);
      directories.set(id, directory);
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
    plugins, directories, publish,
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
