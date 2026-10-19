import type { Output, Snapshot, TerminalEvent, Size } from './types';
import { Stream } from './stream';

export class Pty extends Stream<Output> {
  private snapshot?: Snapshot;
  private snapshots = new Set<(event: Snapshot) => void>();

  constructor(readonly id: string,
    private request: (op: string, params: Record<string, unknown>) => Promise<unknown>,
    private remove: () => void,
  ) { super(); }

  receive(event: TerminalEvent) {
    if (this.failure) return;
    // A snapshot replaces the screen and the order before it, so what no reader has taken is dropped.
    if (event.event === 'snapshot') {
      this.snapshot = event;
      this.reset(event.seq);
      for (const callback of this.snapshots) callback(event);
      return;
    }
    this.deliver(event);
  }

  onSnapshot(callback: (event: Snapshot) => void) {
    this.snapshots.add(callback);
    if (this.snapshot) callback(this.snapshot);
    return () => { this.snapshots.delete(callback); };
  }

  async write(data: string) {
    if (this.failure) throw this.failure;
    const parts = Array.from(data);
    const requests: Promise<unknown>[] = [];
    for (let offset = 0; offset < parts.length; offset += 8000) {
      requests.push(this.request('input', { session_id: this.id, data: parts.slice(offset, offset + 8000).join('') }));
    }
    await Promise.all(requests);
  }

  async resize(size: Size) {
    if (this.failure) throw this.failure;
    await this.request('resize', { session_id: this.id, ...size });
  }

  async detach() {
    if (this.failure) return;
    this.remove();
    this.release();
    await this.request('detach', { session_id: this.id });
  }

  release(error = new Error('Terminal detached')) {
    super.release(error);
    this.snapshots.clear();
    this.snapshot = undefined;
  }
}
