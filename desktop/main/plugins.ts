import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { Dispose, MainContext, PluginInfo } from '../shared';

export async function loadPlugins(sdkPath: string, resourcesDirectory: string, emit: (id: string, event: string, data: unknown) => void) {
  const { build } = await import('esbuild');
  const directory = join(homedir(), '.local/shared/shu/plugins');
  const cache = join(homedir(), '.cache/shu/plugins');
  const plugins: PluginInfo[] = [];
  const handlers = new Map<string, Map<string, (params: any) => unknown>>();
  const disposers: Dispose[] = [];
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
      if (existsSync(join(source, 'renderer.tsx'))) {
        await build({
          entryPoints: [join(source, 'renderer.tsx')], outfile: join(output, 'renderer.js'),
          bundle: true, platform: 'browser', format: 'esm', target: 'chrome140', jsx: 'automatic',
          define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: 'inline',
          plugins: [{ name: 'node-sdk-boundary', setup(builder) {
            builder.onResolve({ filter: /^@shu\/sdk$/ }, () => ({ errors: [{ text: '@shu/sdk is only available in main.ts' }] }));
          } }],
        });
        info.renderer = `shu-plugin://plugins/${encodeURIComponent(id)}/renderer.js`;
        if (existsSync(join(output, 'renderer.css'))) info.css = `shu-plugin://plugins/${encodeURIComponent(id)}/renderer.css`;
      }
      const dataDirectory = join(homedir(), '.local/shared/shu/data', id);
      mkdirSync(dataDirectory, { recursive: true });
      const context: MainContext = {
        dataDirectory, resourcesDirectory,
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
      info.renderer = undefined;
      info.css = undefined;
      methods.clear();
      console.error(`Plugin ${id}:`, error);
    }
  }
  return {
    plugins, cache,
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
    },
  };
}
