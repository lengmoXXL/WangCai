import type { AgentInfo, Profile } from '@lengmoxxl/sdk';
import type { InstallStatus } from '../shared';
import type { PluginSpec } from './config';
import { installPlugin } from './install';
import { loadPlugins } from './plugins';

/** The plugins init.ts lists: what still has to be installed, and the loader the window reads them from. */
export function pluginManager(options: {
  resourcesDirectory: string; agent: AgentInfo; profile: Profile;
  specs: PluginSpec[]; node: string; broadcast: (event: string, data: unknown) => void;
}) {
  const { resourcesDirectory, agent, profile, specs, node, broadcast } = options;
  const statuses: InstallStatus[] = specs.map(({ id }) => ({ id, stage: 'ready' }));
  const announce = (status: InstallStatus) => {
    statuses[statuses.findIndex((entry) => entry.id === status.id)] = status;
    broadcast('install-statuses', statuses);
  };
  // The page installs a plugin again on request, so which ones are out is kept between runs.
  const failed = new Set<string>();
  const load = () => loadPlugins({
    resourcesDirectory, agent, profile, broadcast,
    // A plugin that did not install is left out rather than activated from half a checkout: the rest of
    // the app runs without it, and the page says what went wrong.
    specs: specs.filter((spec) => !failed.has(spec.id)),
  });
  /** Installs the targets and answers whether any of them had work left to do. */
  const install = async (targets: PluginSpec[]) => {
    let worked = false;
    for (const spec of targets) {
      if (!spec.repo) continue;
      try {
        const changed = await installPlugin(spec, node, (stage, message) => announce({ id: spec.id, stage, message }));
        if (changed) worked = true;
        failed.delete(spec.id);
      } catch (error) {
        failed.add(spec.id);
        announce({ id: spec.id, stage: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return worked;
  };
  // Everything that needs a plugin waits for this.
  let loading = install(specs).then(load);
  return {
    /** The loader every plugin consumer reads; an update replaces it. */
    loaded: () => loading,
    statuses,
    /**
     * Installs the named specs and answers whether that moved plugin files. The loader is rebuilt when it
     * did: what the plugins mounted are the files of the build before it, and only a fresh mount shows the
     * new ones.
     */
    async update(ids: string[]) {
      if (!(await install(specs.filter(({ id }) => ids.includes(id))))) return false;
      await (await loading).dispose();
      loading = load();
      return true;
    },
  };
}
