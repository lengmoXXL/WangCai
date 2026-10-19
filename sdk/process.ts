import type { ProcessEvent, ProcessOutput } from './types';
import { Stream } from './stream';

// The node takes one base64 payload per write request, and applies them in the order they arrive.
const CHUNK = 32 * 1024;

export class Process extends Stream<ProcessOutput> {
  private ended = false;
  private code?: number;
  private exits = new Set<(code?: number) => void>();

  constructor(readonly id: string,
    private request: (op: string, params: Record<string, unknown>) => Promise<unknown>,
  ) { super(); }

  receive(event: ProcessEvent) {
    if (this.failure) return;
    if (event.event === 'exit' || event.event === 'lost') {
      this.ended = true;
      this.code = event.event === 'exit' ? event.code : undefined;
      for (const callback of this.exits) callback(this.code);
      this.exits.clear();
      return;
    }
    this.deliver({ data: event.data, seq: event.seq, stream: event.event });
  }

  /** Its exit code, or nothing when the node lost the stream and the process may still be running. */
  onExit(callback: (code?: number) => void) {
    this.exits.add(callback);
    if (this.ended) callback(this.code);
    return () => { this.exits.delete(callback); };
  }

  async write(data: Uint8Array) {
    if (this.failure) throw this.failure;
    const requests: Promise<unknown>[] = [];
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const chunk = Buffer.from(data.subarray(offset, offset + CHUNK)).toString('base64');
      requests.push(this.request('process_write', { session_id: this.id, data: chunk }));
    }
    await Promise.all(requests);
  }

  release(error = new Error('Process detached')) {
    super.release(error);
    this.exits.clear();
  }
}
