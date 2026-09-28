export interface PluginInfo { id: string; ui?: string; css?: string; error?: string }
export interface TabRecord { plugin: string; workspaceId?: string; id: string }
export type Dispose = () => void | Promise<void>;
export const denied = (scope: string, member: string) => () => { throw new Error(`${member} is not available on the ${scope} channel`); };
export interface PluginBridge {
  publish(event: string, data: unknown): Promise<void>;
  subscribe(event: string, callback: (data: unknown) => void): () => void;
  plugins(): Promise<PluginInfo[]>;
  request<T = any>(id: string, method: string, params?: unknown): Promise<T>;
  on(callback: (id: string, event: string, data: unknown) => void): () => void;
  loadTabs(): Promise<TabRecord[]>;
  saveTabs(tabs: TabRecord[]): Promise<void>;
}
declare global { interface Window { wangcai: PluginBridge } }
