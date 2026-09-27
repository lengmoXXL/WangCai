export type Dispose = () => void | Promise<void>;
export interface Channel {
  publish(event: string, data: unknown): Promise<void>;
  subscribe<T>(event: string, callback: (data: T) => void | Promise<void>): () => void;
}
export interface FileClick {
  type: 'file';
  machine: { id: string; name: string; host?: string };
  path: string;
  line?: number;
  column?: number;
}
export interface MainContext extends Channel {
  dataDirectory: string;
  logDirectory: string;
  resourcesDirectory: string;
  handle<T>(method: string, handler: (params: T) => unknown | Promise<unknown>): () => void;
  emit(event: string, data: unknown): void;
}
export interface UIContext extends Channel {
  request<T = any>(method: string, params?: unknown): Promise<T>;
  on<T>(event: string, callback: (data: T) => void): () => void;
}
