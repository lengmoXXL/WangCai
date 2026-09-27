import type { Output, Snapshot, TerminalEvent, Size } from './types';

export class Pty {
  private sequence = -1;
  private error?: Error;
  private snapshot?: Snapshot;
  private buffered: Output[] = [];
  private snapshots = new Set<(event: Snapshot) => void>();
  private outputs = new Set<(event: Output) => void>();
  private errors = new Set<(error: Error) => void>();

  constructor(readonly id: string,
    private request: (op: string, params: Record<string, unknown>) => Promise<unknown>,
    private remove: () => void,
  ) {}

  receive(event: TerminalEvent) {
    if (this.error) return;
    if (event.event === 'snapshot') {
      this.sequence = event.seq;
      this.buffered = [];
      this.snapshot = event;
      for (const callback of this.snapshots) callback(event);
      return;
    }
    if (event.seq <= this.sequence) return;
    this.sequence = event.seq;
    if (!this.outputs.size) this.buffered.push(event);
    for (const callback of this.outputs) callback(event);
  }

  onSnapshot(callback: (event: Snapshot) => void) {
    this.snapshots.add(callback);
    if (this.snapshot) callback(this.snapshot);
    return () => { this.snapshots.delete(callback); };
  }

  onData(callback: (event: Output) => void) {
    this.outputs.add(callback);
    for (const event of this.buffered) callback(event);
    this.buffered = [];
    return () => { this.outputs.delete(callback); };
  }

  onError(callback: (error: Error) => void) {
    this.errors.add(callback);
    if (this.error) callback(this.error);
    return () => { this.errors.delete(callback); };
  }

  async write(data: string) {
    if (this.error) throw this.error;
    const parts = Array.from(data);
    const requests: Promise<unknown>[] = [];
    for (let offset = 0; offset < parts.length; offset += 8000) {
      requests.push(this.request('input', { session_id: this.id, data: parts.slice(offset, offset + 8000).join('') }));
    }
    await Promise.all(requests);
  }

  async resize(size: Size) {
    if (this.error) throw this.error;
    await this.request('resize', { session_id: this.id, ...size });
  }

  async detach() {
    if (this.error) return;
    this.remove();
    this.release();
    await this.request('detach', { session_id: this.id });
  }

  release(error = new Error('Terminal detached')) {
    this.error = error;
    for (const callback of this.errors) callback(error);
    this.snapshots.clear(); this.outputs.clear(); this.errors.clear();
    this.snapshot = undefined;
    this.buffered = [];
  }
}
