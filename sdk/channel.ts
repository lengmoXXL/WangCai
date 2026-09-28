export interface Channel {
  publish(topic: string, data: unknown): Promise<void>;
  subscribe<T>(topic: string, callback: (data: T) => void | Promise<void>): () => void;
  request<T = unknown>(topic: string, params?: unknown): Promise<T>;
  handle<T = unknown>(topic: string, handler: (params: T) => unknown): () => void;
}

export interface Context {
  global: Channel;
  ui: Channel;
  host: Channel;
}
