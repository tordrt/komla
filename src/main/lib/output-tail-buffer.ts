/**
 * Keeps the last `limit` characters of a stream of chunks.
 *
 * Appending is O(1) amortized: whole chunks are dropped from the front once the
 * rest still covers the limit, and the tail is only joined when read. This
 * avoids re-copying the full window on every PTY chunk (`(buf + data).slice(-limit)`).
 */
export class OutputTailBuffer {
  private chunks: string[] = [];
  private head = 0;
  private length = 0;

  constructor(
    private readonly limit: number,
    // Called with each chunk as it leaves the front of the tail.
    private readonly onDrop?: (chunk: string) => void
  ) {}

  append(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.length += data.length;
    while (this.length - this.chunks[this.head].length >= this.limit) {
      this.length -= this.chunks[this.head].length;
      this.onDrop?.(this.chunks[this.head]);
      // Release the dropped chunk now; a large chunk must not outlive the limit.
      this.chunks[this.head] = '';
      this.head++;
    }
    // Compact occasionally so the emptied slots don't grow the array without bound.
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  /** Characters currently retained (at most `limit` plus one chunk). */
  get retainedLength(): number {
    return this.length;
  }

  /** Every character still held: the last `limit`, plus up to one chunk before them. */
  retained(): string {
    return this.head === 0 ? this.chunks.join('') : this.chunks.slice(this.head).join('');
  }

  toString(): string {
    const joined = this.retained();
    return joined.length > this.limit ? joined.slice(-this.limit) : joined;
  }
}
