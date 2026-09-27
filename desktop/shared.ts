import type { Channel } from '@shu/sdk/plugin';

export interface PluginInfo { id: string; ui?: string; css?: string; error?: string }
export interface PluginBridge extends Channel {
  plugins(): Promise<PluginInfo[]>;
  request<T = any>(id: string, method: string, params?: unknown): Promise<T>;
  on(callback: (id: string, event: string, data: unknown) => void): () => void;
}
declare global { interface Window { shu: PluginBridge } }
