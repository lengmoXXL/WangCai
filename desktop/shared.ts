import type { Profile } from '@lengmoxxl/sdk';
import type { TabRecord } from '@lengmoxxl/sdk/channel';

// The shell's own font: the app decides this, plugins decide theirs.
export const uiFont = '"DejaVuSansM Nerd Font Mono", monospace';

// The shell serves this document for a plugin to frame as a preview of an HTML file.
export const previewScheme = 'wangcai-preview';
export const previewUrl = `${previewScheme}://preview/`;
export const previewMessage = 'wangcai-preview';

export interface PluginInfo { id: string; config: Record<string, unknown>; ui?: string; css?: string; error?: string; workspaces?: boolean }

// What a plugin init.ts lists is doing, as the manager page reports it.
export type InstallStage = 'cloning' | 'installing' | 'building' | 'ready' | 'failed';
export interface InstallStatus { id: string; stage: InstallStage; message?: string }
export interface PluginBridge {
  publish(event: string, data: unknown): Promise<void>;
  subscribe(event: string, callback: (data: unknown) => void): () => void;
  plugins(): Promise<PluginInfo[]>;
  config(): Promise<Profile>;
  request<T = any>(id: string, method: string, params?: unknown): Promise<T>;
  installs(): Promise<InstallStatus[]>;
  loadTabs(): Promise<TabRecord[]>;
  saveTabs(tabs: TabRecord[]): Promise<void>;
}
declare global { interface Window { wangcai: PluginBridge } }
