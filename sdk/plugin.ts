export type Dispose = () => void | Promise<void>;
export interface MainContext {
  dataDirectory: string;
  logDirectory: string;
  resourcesDirectory: string;
  handle<T>(method: string, handler: (params: T) => unknown | Promise<unknown>): () => void;
  emit(event: string, data: unknown): void;
}
export interface UIContext {
  request<T = any>(method: string, params?: unknown): Promise<T>;
  on<T>(event: string, callback: (data: T) => void): () => void;
}
