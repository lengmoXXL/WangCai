import type { InstallAgent, Profile } from '@lengmoxxl/sdk';
import type { InstallStatus } from '../shared';
import type { Network, PluginSpec } from './config';
import { installPlugin } from './install';
import { loadPlugins } from './plugins';

export function pluginManager(options: {
  resourcesDirectory: string; agent: InstallAgent; profile: Profile; network: Network;
  specs: PluginSpec[]; node: string; broadcast: (event: string, data: unknown) => void;
}) {
  const { resourcesDirectory, agent, profile, network, specs, node, broadcast } = options;
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
  const install = async (targets: PluginSpec[], follow = false) => {
    let worked = false;
    for (const spec of targets) {
      try {
        if (await installPlugin(spec, node, network, (stage, message) => announce({ id: spec.id, stage, message }), follow)) worked = true;
        failed.delete(spec.id);
      } catch (error) {
        failed.add(spec.id);
        announce({ id: spec.id, stage: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return worked;
  };
  let loading = install(specs).then(load);
  return {
    loaded: () => loading,
    statuses,
    /** Existing mounts use the previous build, so changed plugin files need a fresh loader. */
    async update(ids: string[]) {
      if (!(await install(specs.filter(({ id }) => ids.includes(id)), true))) return false;
      await (await loading).dispose();
      loading = load();
      return true;
    },
  };
}
