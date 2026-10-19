// What a Core and the shell that carries it agree on: the schemes the window is served under, the channels and
// topics of the bridge between them, the version of the contract they answer, and the shapes that cross it.
// Both sides reach this module through their own copy of the SDK, so the version is what catches a shell and a
// Core that were built against different contracts.

// What a Core expects of the shell it is given, and reports back. The shell refuses a build that reports nothing
// (made before the number existed) or an older number; one that reports a newer number is let through, since the
// way back from a refusal is to rebuild Core, which fetches the newest one.
export const contractVersion = 1;

// The shell's own font, which plugins do not inherit.
export const uiFont = '"DejaVuSansM Nerd Font Mono", monospace';

// The shell draws the window out of Core's own bundle, which it serves under this scheme; the other two are
// what Core answers for itself. The shell declares all three privileged before it is ready.
export const coreScheme = 'wangcai-core';
export const pluginScheme = 'wangcai-plugin';
// The shell serves this document for a plugin to frame as a preview of an HTML file.
export const previewScheme = 'wangcai-preview';

// A plugin's own files: one host under its scheme, one directory per plugin.
export const pluginsHost = 'plugins';
export const pluginsUrl = `${pluginScheme}://${pluginsHost}/`;
export const previewUrl = `${previewScheme}://preview/`;
export const previewMessage = 'wangcai-preview';

// The two channels the shell's preload and Core share: one asks for a method by name, one carries topics.
export const link = { invoke: 'wangcai:invoke', channel: 'wangcai:channel' } as const;

// What the shell says to the window over the bridge channel: which page to open, what its install rows are doing,
// and what rebuilding Core is doing. The page a topic names is the one that draws it.
export const pluginPageTopic = 'plugin-page';
export const installStatusesTopic = 'install-statuses';
export const corePageTopic = 'core-page';
export const coreStatusTopic = 'core-status';
// Not a page: whether the window is full screen, which the chrome around a page follows.
export const fullscreenTopic = 'fullscreen';

/** How a run reaches the network: `proxy` is an http://, https:// or socks5:// address, and `mirror` is a
 * prefix every https://github.com/ URL goes out through. */
export interface Network { proxy?: string; mirror?: string }

/** A plugin that is built and ready: where its files are, and how init.ts named it. */
export interface PluginEntry { id: string; workspaces: boolean; directory: string; config?: Record<string, unknown> }

/** What the window is told about a plugin that was loaded: its settings, its files, and why it failed. */
export interface PluginInfo { id: string; config: Record<string, unknown>; ui?: string; css?: string; error?: string; workspaces?: boolean }

// The stages one clone-and-build goes through, for a plugin or for Core itself.
export type InstallStage = 'cloning' | 'updating' | 'installing' | 'building' | 'ready' | 'failed';

// What a plugin init.ts lists is doing, as the shell's installer reports it and the plugin page draws it.
export interface InstallStatus { id: string; stage: InstallStage; message?: string }

// What rebuilding Core reports: the same stages, without a plugin's id.
export type CoreStatus = Omit<InstallStatus, 'id'>;

// What a stage is called on the page that reports it.
export const stageNames: Record<InstallStage, string> = { cloning: '克隆中', updating: '同步中', installing: '安装依赖', building: '构建中', ready: '就绪', failed: '失败' };

// The left sidebar's own bookkeeping: workspaces a provider serves, gathered under a named group, which the provider
// never hears of.
export interface WorkspaceGroup {
  id: string;
  name: string;
  collapsed: boolean;
  workspaces: string[];
  // How many top-level rows the group is drawn under, and under every row when it records none.
  after?: number;
}

/** What the shell's preload hands the window. */
export interface PluginBridge {
  call(method: string, ...args: unknown[]): Promise<any>;
  subscribe(event: string, callback: (data: unknown) => void): () => void;
}