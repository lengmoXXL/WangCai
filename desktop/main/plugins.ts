import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import type { AgentInfo, Profile } from '@wangcai/sdk';
import type { Dispose, MainContext } from '@wangcai/sdk/channel';
import type { PluginInfo } from '../shared';
import { pluginDirectory, storageDirectory, type PluginSpec } from './config';

// A schema is an object of leaves, each naming the type it takes and the default to use without one.
// An 'array' leaf takes whatever list init.ts holds and leaves its entries to the plugin to check.
// Only keys the schema lists survive, so a plugin decides for itself which config it accepts.
function resolveConfig(schema: unknown, values: unknown): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (typeof schema !== 'object' || schema === null) return settings;
  const given = (typeof values === 'object' && values !== null ? values : {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(schema as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const declared = entry as { type?: unknown; default?: unknown };
    if (declared.type === 'array' || typeof declared.type === 'string') {
      const matches = declared.type === 'array' ? Array.isArray(given[key]) : typeof given[key] === declared.type;
      const value = matches ? given[key] : declared.default;
      if (value !== undefined) settings[key] = value;
      continue;
    }
    const nested = resolveConfig(entry, given[key]);
    if (Object.keys(nested).length) settings[key] = nested;
  }
  return settings;
}

export async function loadPlugins(options: {
  sdkPath: string; resourcesDirectory: string; agent: AgentInfo; profile: Profile;
  specs: PluginSpec[]; broadcast: (event: string, data: unknown) => void;
}) {
  const { sdkPath, resourcesDirectory, agent, profile, specs, broadcast } = options;
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
      const directory = pluginDirectory(spec);
      const filename = join(directory, 'main.cjs');
      if (!existsSync(filename)) throw new Error('Plugin is not installed');
      if (existsSync(join(directory, 'ui.js'))) {
        info.ui = `wangcai-plugin://plugins/${encodeURIComponent(id)}/ui.js`;
        if (existsSync(join(directory, 'ui.css'))) info.css = `wangcai-plugin://plugins/${encodeURIComponent(id)}/ui.css`;
      }
      const localRequire = createRequire(filename);
      // Prebuilt plugins use the host SDK so its connection pool stays shared across plugins.
      const pluginRequire = Object.assign((name: string) => name === '@wangcai/sdk' ? requirePlugin(sdkPath) : localRequire(name), localRequire);
      const module = { exports: {} as { activate(context: MainContext): void | Dispose | Promise<void | Dispose>; config?: unknown } };
      compileFunction(readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'], { filename })
        .call(module.exports, pluginRequire, module, module.exports, filename, dirname(filename));
      // The app knows nothing about the fields a plugin takes.
      const settings = resolveConfig(module.exports.config, spec.config);
      info.config = settings;
      info.workspaces = spec.workspaces;
      const dataDirectory = join(storageDirectory, 'data', id);
      mkdirSync(dataDirectory, { recursive: true });
      const context: MainContext = {
        global: {
          publish,
          subscribe(topic, callback) {
            let callbacks = subscriptions.get(topic);
            if (!callbacks) subscriptions.set(topic, callbacks = new Set());
            callbacks.add(callback);
            return () => { callbacks.delete(callback); };
          },
        },
        ui: {
          publish: (topic, data) => { broadcast(`${id}:${topic}`, data); },
          handle(topic, handler) {
            if (topic.includes(':')) throw new Error(`Plugin method names cannot contain ":": ${topic}`);
            if (methods.has(topic)) throw new Error(`Duplicate plugin method: ${topic}`);
            methods.set(topic, handler);
            return () => { methods.delete(topic); };
          },
        },
        host: { dataDirectory, resourcesDirectory, agent, config: { ...profile, ...settings } },
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
