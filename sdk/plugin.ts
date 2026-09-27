export type Dispose = () => void | Promise<void>;
export interface Channel {
  publish(event: string, data: unknown): Promise<void>;
  subscribe<T>(event: string, callback: (data: T) => void | Promise<void>): () => void;
}
export interface FileClick {
  type: 'file' | 'directory';
  machine: { id: string; name: string; host?: string };
  path: string;
  line?: number;
  column?: number;
}
export interface ActiveTerminal {
  machine: FileClick['machine'];
  sessionId: string;
}
export interface MainContext extends Channel {
  dataDirectory: string;
  logDirectory: string;
  resourcesDirectory: string;
  handle<T>(method: string, handler: (params: T) => unknown | Promise<unknown>): () => void;
  emit(event: string, data: unknown): void;
}
export interface TabContent { dispose: Dispose; onSelect?(): void }
export interface UIContext extends Channel {
  readonly sidebar: HTMLElement;
  tabs: {
    open(options: { id: string; title: string; tooltip?: string; mount(container: HTMLElement): TabContent }): void;
  };
  request<T = any>(method: string, params?: unknown): Promise<T>;
  on<T>(event: string, callback: (data: T) => void): () => void;
}
