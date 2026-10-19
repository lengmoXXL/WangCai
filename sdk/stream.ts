/** One node stream's events, in the order it sent them, kept for a reader that has not asked yet. */
export class Stream<T extends { seq: number }> {
  // What the node sent last, and what no reader has taken yet.
  private sequence = -1;
  private missed: T[] = [];
  private readers = new Set<(event: T) => void>();
  /** Why the stream was released; a released stream takes no more events. */
  protected failure?: Error;

  /** Takes one event in order, unless a release or a later sequence makes it stale. */
  protected deliver(event: T) {
    if (this.failure || event.seq <= this.sequence) return;
    this.sequence = event.seq;
    if (!this.readers.size) this.missed.push(event);
    for (const reader of this.readers) reader(event);
  }

  /** Replaces the order from a snapshot: what came before it is no longer what the stream holds. */
  protected reset(seq: number) {
    this.sequence = seq;
    this.missed = [];
  }

  /** Everything from here on, and first what no reader has taken yet. */
  onData(reader: (event: T) => void) {
    this.readers.add(reader);
    for (const event of this.missed) reader(event);
    this.missed = [];
    return () => { this.readers.delete(reader); };
  }

  protected release(error: Error) {
    this.failure = error;
    this.readers.clear();
    this.missed = [];
  }
}
