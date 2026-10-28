/**
 * Deduplicates PTY output across two overlapping sources on terminal mount:
 *
 *   - A live subscription that delivers chunks as the main process broadcasts
 *     them (each chunk carries a monotonic `seq`).
 *   - A snapshot fetched via `getPtyBuffer` that replays accumulated output for
 *     terminals re-mounted after a move (the snapshot carries the `seq` of its
 *     last included chunk).
 *
 * Any chunk emitted by the shell in the window between the renderer
 * registering the live listener and the snapshot IPC handler running in main
 * ends up in BOTH streams. Without dedup, those chunks render twice.
 *
 * The module accepts live chunks and the snapshot in any order. Live chunks
 * arriving before the snapshot are queued; once the snapshot resolves, the
 * snapshot is written first, then queued chunks with `seq > snapshot.seq` are
 * flushed in order. Subsequent live chunks are filtered by the same rule.
 */

type WriteSink = (data: string) => void;
type SnapshotSink = (snapshot: string, newer: string) => void;

interface QueuedChunk {
  data: string;
  seq: number;
}

export class PtyStreamDedup {
  private snapshotSeq: number | null = null;
  private queue: QueuedChunk[] = [];
  private disposed = false;

  /**
   * @param writeSnapshot  Called once with snapshot output and, apart, any queued
   *                       live chunks that weren't covered by it, to write in that
   *                       order. Not called if there's nothing to write.
   * @param writeLive      Called for each live chunk that arrives after the
   *                       snapshot resolves and is not already in it.
   */
  constructor(
    private readonly writeSnapshot: SnapshotSink,
    private readonly writeLive: WriteSink
  ) {}

  /** Feed a live chunk from the PTY_DATA broadcast. */
  handleLive(data: string, seq: number): void {
    if (this.disposed) return;
    if (this.snapshotSeq === null) {
      this.queue.push({ data, seq });
      return;
    }
    if (seq <= this.snapshotSeq) return;
    this.writeLive(data);
  }

  /**
   * Apply the snapshot returned by `getPtyBuffer`. Idempotent — a second call
   * is ignored. Call with buffer='' and seq=0 on snapshot failure so queued
   * live chunks still reach the terminal. Returns whether the snapshot was accepted.
   */
  applySnapshot(buffer: string, seq: number): boolean {
    if (this.disposed || this.snapshotSeq !== null) return false;
    this.snapshotSeq = seq;

    const drained: string[] = [];
    for (const chunk of this.queue) {
      if (chunk.seq > seq) drained.push(chunk.data);
    }
    this.queue = [];

    const newer = drained.join('');
    if (buffer.length > 0 || newer.length > 0) {
      this.writeSnapshot(buffer, newer);
    }
    return true;
  }

  /** A PTY restart invalidates the pending snapshot and all pre-reset output. */
  reset(): void {
    this.queue = [];
    // Continue with live output immediately; any outstanding snapshot is stale.
    this.snapshotSeq = 0;
  }

  /** Drop any queued chunks and ignore subsequent calls. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
  }

  /** Exposed for diagnostics / tests. */
  get queuedChunkCount(): number {
    return this.queue.length;
  }
}
