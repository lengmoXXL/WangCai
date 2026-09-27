import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { ConnectionOptions, MachineState, Session, TerminalEvent, Size } from './types';
import { Pty } from './pty';

const exec = promisify(execFile);
interface Info { pid: number; port: number; instance_id: string; protocol: number }

export class MachineConnection {
  private listeners = new Set<(state: MachineState) => void>();
  private terminals = new Map<string, Pty>();
  private instance?: string;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  state: MachineState;
  private ws?: WebSocket;
  private tunnel?: ChildProcess;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stopped = false;
  private attempt = 0;
  private epoch = 0;
  private serial = 0;

  constructor(private options: ConnectionOptions) {
    this.state = { status: 'connecting', sessions: [], generation: 0 };
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.open();
  }

  async connected() { await this.ready; return this; }

  onState(callback: (state: MachineState) => void) {
    this.listeners.add(callback);
    callback({ ...this.state });
    return () => { this.listeners.delete(callback); };
  }

  private publish() {
    for (const callback of this.listeners) callback({ ...this.state });
  }

  disconnect() {
    this.stopped = true;
    this.cleanup();
    this.rejectReady(new Error('Connection cancelled'));
    for (const terminal of this.terminals.values()) terminal.release();
    this.terminals.clear();
    this.state.status = 'disconnected';
    this.state.error = undefined;
    this.publish();
    this.listeners.clear();
  }

  pty = {
    list: async () => await this.request('list') as Session[],
    create: async (size: Size = { rows: 24, cols: 80 }) => await this.request('create', { ...size }) as Session,
    attach: async (id: string) => {
      const existing = this.terminals.get(id);
      if (existing) return existing;
      const terminal = new Pty(id, (op, params) => this.request(op, params), () => { this.terminals.delete(id); });
      this.terminals.set(id, terminal);
      try { await this.request('attach', { session_id: id }); }
      catch (error) { this.terminals.delete(id); terminal.release(); throw error; }
      return terminal;
    },
    close: async (id: string) => {
      await this.request('close', { session_id: id });
      this.terminals.get(id)?.release();
      this.terminals.delete(id);
    },
  };

  fs = {
    readFile: async (path: string): Promise<Uint8Array> => {
      const result = await this.request('read_file', { path }) as { data: string };
      return Buffer.from(result.data, 'base64');
    },
  };

  private cleanup() {
    this.epoch++;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const socket = this.ws;
    this.ws = undefined;
    socket?.terminate();
    this.tunnel?.kill();
    this.tunnel = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection lost; input was not replayed.'));
    }
    this.pending.clear();
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    if (this.state.generation === 0) {
      this.rejectReady(error instanceof Error ? error : new Error(String(error)));
      this.disconnect();
      return;
    }
    this.cleanup();
    this.state.status = 'connecting';
    this.state.error = error instanceof Error ? error.message : String(error);
    this.publish();
    this.retry = setTimeout(() => void this.open(), Math.min(1000 * 2 ** this.attempt++, 15_000));
  }

  private async open() {
    const epoch = ++this.epoch;
    const current = () => !this.stopped && this.epoch === epoch;
    this.state.status = 'connecting';
    this.publish();
    try {
      let info: Info;
      let port: number;
      if (this.options.type === 'local') {
        await exec(this.options.binary ?? 'shu', ['server', 'start'], { timeout: 15_000 });
        if (!current()) return;
        const { stdout } = await exec(this.options.binary ?? 'shu', ['server', 'status', '--json'], { timeout: 5000 });
        info = JSON.parse(stdout);
        port = info.port;
      } else {
        const { stdout } = await exec('ssh', [
          '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', this.options.host,
          'export PATH="$HOME/.local/bin:$PATH"; shu server status --json',
        ], { timeout: 15_000, maxBuffer: 64 * 1024 });
        info = JSON.parse(stdout.trim());
        if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new Error('Node returned an invalid port.');
        if (!current()) return;
        port = await this.forward(info.port, current);
      }
      if (!current()) return;
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
      this.ws = socket;
      socket.on('message', (data, binary) => {
        if (!current()) return;
        try {
          if (binary) {
            const bytes = data as Buffer;
            const length = bytes.readUInt32BE(0);
            if (length > bytes.length - 4) throw new Error('Invalid terminal packet');
            const header = JSON.parse(bytes.subarray(4, 4 + length).toString());
            this.terminals.get(header.session_id)?.receive({ ...header, data: new Uint8Array(bytes.subarray(4 + length)) } as TerminalEvent);
          } else {
            const message = JSON.parse(data.toString());
            if (message.id) {
              const pending = this.pending.get(message.id);
              if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve(message.result);
              }
            } else if (message.event === 'sessions_changed') {
              void this.refresh().catch(() => {});
            }
          }
        } catch (error) { this.fail(error); }
      });
      // Keep an error listener installed through open and close.
      socket.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      if (!current()) { socket.terminate(); return; }
      socket.on('close', () => { if (current()) this.fail(new Error('Disconnected. Reconnecting…')); });
      const actual = await this.request('info') as Info;
      if (actual.instance_id !== info.instance_id || actual.protocol !== 1) throw new Error('Node instance or protocol mismatch.');
      await this.refresh();
      if (!current()) return;
      if (this.instance && this.instance !== actual.instance_id) {
        for (const terminal of this.terminals.values()) terminal.release(new Error('Node restarted; terminal no longer exists'));
        this.terminals.clear();
      }
      this.instance = actual.instance_id;
      for (const [id, terminal] of this.terminals) {
        try { await this.request('attach', { session_id: id }); }
        catch (error) {
          if (!current()) return;
          terminal.release(error as Error);
          this.terminals.delete(id);
        }
      }
      if (!current()) return;
      this.state.status = 'connected';
      this.state.error = undefined;
      this.state.generation++;
      this.attempt = 0;
      this.resolveReady();
      this.publish();
      let alive = true;
      socket.on('pong', () => { alive = true; });
      this.heartbeat = setInterval(() => {
        if (!alive) { this.fail(new Error('Node stopped responding. Reconnecting…')); return; }
        alive = false;
        socket.ping();
      }, 10_000);
    } catch (error) { if (current()) this.fail(error); }
  }

  private async forward(remotePort: number, current: () => boolean): Promise<number> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current()) throw new Error('Connection cancelled');
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
      });
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      if (!current()) throw new Error('Connection cancelled');
      const tunnel = spawn('ssh', [
        '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
        '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`, (this.options as Extract<ConnectionOptions, { type: 'ssh' }>).host,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      this.tunnel = tunnel;
      let stderr = '';
      tunnel.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
      try {
        await new Promise<void>((resolve, reject) => {
          let finished = false;
          const finish = (error?: Error) => {
            if (finished) return;
            finished = true;
            clearInterval(poll);
            clearTimeout(timeout);
            tunnel.off('exit', exited);
            if (error) reject(error); else resolve();
          };
          const exited = () => finish(new Error(stderr.trim() || 'SSH tunnel exited.'));
          const poll = setInterval(() => {
            if (!current()) { finish(new Error('Connection cancelled')); return; }
            const probe = createConnection({ host: '127.0.0.1', port });
            probe.once('connect', () => { probe.destroy(); finish(); });
            probe.once('error', () => probe.destroy());
            probe.setTimeout(200, () => probe.destroy());
          }, 100);
          const timeout = setTimeout(() => finish(new Error(stderr.trim() || 'SSH tunnel timed out.')), 10_000);
          tunnel.once('exit', exited);
          tunnel.once('error', (error) => finish(error));
        });
        tunnel.on('exit', () => { if (current()) this.fail(new Error(stderr.trim() || 'SSH tunnel closed.')); });
        return port;
      } catch (error) {
        tunnel.kill();
        if (this.tunnel === tunnel) this.tunnel = undefined;
        lastError = error;
        if (!/address already in use|cannot listen to port|port forwarding failed/i.test(String(error))) throw error;
      }
    }
    throw lastError;
  }

  private async request(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Machine is not connected.');
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out; it was not retried.`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...params, op, id }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private async refresh() {
    const sessions = await this.request('list') as Session[];
    this.state.sessions = sessions;
    this.publish();
  }
}
