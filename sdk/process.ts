import type { ProcessEvent, ProcessOutput } from './types';

// The node takes one base64 payload per write request, and applies them in the order they arrive.
const CHUNK = 32 * 1024;

export class Process {
  private sequence = -1;
  private error?: Error;
  private ended = false;
  private code?: number;
  private buffered: ProcessOutput[] = [];
  private outputs = new Set<(event: ProcessOutput) => void>();
  private exits = new Set<(code?: number) => void>();

  constructor(readonly id: string,
    private request: (op: string, params: Record<string, unknown>) => Promise<unknown>,
  ) {}

  receive(event: ProcessEvent) {
    if (this.error) return;
    if (event.event === 'exit' || event.event === 'lost') {
      this.ended = true;
      this.code = event.event === 'exit' ? event.code : undefined;
      for (const callback of this.exits) callback(this.code);
      this.exits.clear();
      return;
    }
    if (event.seq <= this.sequence) return;
    this.sequence = event.seq;
    const output: ProcessOutput = { data: event.data, seq: event.seq, stream: event.event };
    if (!this.outputs.size) this.buffered.push(output);
    for (const callback of this.outputs) callback(output);
  }

  onData(callback: (event: ProcessOutput) => void) {
    this.outputs.add(callback);
    for (const event of this.buffered) callback(event);
    this.buffered = [];
    return () => { this.outputs.delete(callback); };
  }

  /** Its exit code, or nothing when the node lost the stream and the process may still be running. */
  onExit(callback: (code?: number) => void) {
    this.exits.add(callback);
    if (this.ended) callback(this.code);
    return () => { this.exits.delete(callback); };
  }

  async write(data: Uint8Array) {
    if (this.error) throw this.error;
    const requests: Promise<unknown>[] = [];
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const chunk = Buffer.from(data.subarray(offset, offset + CHUNK)).toString('base64');
      requests.push(this.request('process_write', { session_id: this.id, data: chunk }));
    }
    await Promise.all(requests);
  }

  release(error = new Error('Process detached')) {
    this.error = error;
    this.outputs.clear(); this.exits.clear();
    this.buffered = [];
  }
}