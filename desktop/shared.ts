export interface PluginInfo { id: string; renderer?: string; css?: string; error?: string }
export type Dispose = () => void | Promise<void>;
export interface MainContext {
  dataDirectory: string;
  resourcesDirectory: string;
  handle<T>(method: string, handler: (params: T) => unknown | Promise<unknown>): () => void;
  emit(event: string, data: unknown): void;
}
export interface RendererContext {
  request<T = any>(method: string, params?: unknown): Promise<T>;
  on<T>(event: string, callback: (data: T) => void): () => void;
}
export interface PluginBridge {
  plugins(): Promise<PluginInfo[]>;
  request<T = any>(id: string, method: string, params?: unknown): Promise<T>;
  on(callback: (id: string, event: string, data: unknown) => void): () => void;
}
declare global { interface Window { shu: PluginBridge } }
