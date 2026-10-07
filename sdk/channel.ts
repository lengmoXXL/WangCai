import type { MachineConnection } from './connection';

export type Dispose = () => void | Promise<void>;

/** A sidebar tab the window opens for a plugin: what it is called, and what it draws. */
export interface TabOptions { id: string; title: string; tooltip?: string; workspaceId?: string; onClose?(): void; mount(container: HTMLElement): TabContent }
export interface TabContent { dispose: Dispose; onSelect?(): void }
/** A tab the window remembers from the last run, so the plugin can open it again. */
export interface TabRecord { plugin: string; id: string; workspaceId?: string }

/** The bus every plugin shares: what one publishes reaches the others, in either realm. */
export interface Bus {
  publish(topic: string, data: unknown): Promise<void>;
  subscribe<T>(topic: string, callback: (data: T) => void | Promise<void>): () => void;
}

/** What a main.cjs gets: the methods its own ui.js calls, and the machine it runs on. */
export interface MainContext {
  global: Bus;
  ui: {
    handle<T = unknown>(method: string, handler: (params: T) => unknown): Dispose;
    // Reaches this plugin's own ui as '<id>:<topic>'.
    publish(topic: string, data: unknown): void;
  };
  // A machine is what the plugin knows of it: `host` names an SSH one, nothing means the app's own. Which
  // way one is reached, and the connection kept for it, belongs to the app.
  connect(machine: { host?: string }, signal?: AbortSignal): Promise<MachineConnection>;
  host: {
    dataDirectory: string;
    // The app's profile with this plugin's settings resolved on top: its schema says what is in it.
    config: any;
  };
}

/** What a ui.js gets: its plugin's methods, and the window it is drawn in. */
export interface UiContext {
  global: Bus;
  ui: {
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    // The topics this plugin's main.cjs publishes, as '<id>:<topic>'.
    subscribe<T>(topic: string, callback: (data: T) => void | Promise<void>): () => void;
  };
  host: {
    config: any;
    preview: { url: string; message: string };
    tabs(options: TabOptions): void;
  };
}
