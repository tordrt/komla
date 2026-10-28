import { describe, it, expect, vi } from 'vitest';

import { PtyStreamDedup } from '../../../src/renderer/lib/pty-stream-dedup';

function setup() {
  const writeSnapshot = vi.fn<(snapshot: string, newer: string) => void>();
  const writeLive = vi.fn<(data: string) => void>();
  const dedup = new PtyStreamDedup(writeSnapshot, writeLive);
  return { dedup, writeSnapshot, writeLive };
}

describe('PtyStreamDedup', () => {
  describe('race: live arrives before snapshot', () => {
    it('dedupes chunks already covered by the snapshot', () => {
      // Chunks seq 1..3 arrive via live, then snapshot covers seq=3 (includes all three).
      // Without dedup, all three would render twice. After dedup: nothing queued is
      // written (snapshot already has them), and writeSnapshot fires with just the
      // snapshot buffer.
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.handleLive('a', 1);
      dedup.handleLive('b', 2);
      dedup.handleLive('c', 3);
      dedup.applySnapshot('abc', 3);

      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('abc', '');
      expect(writeLive).not.toHaveBeenCalled();
    });

    it('writes queued chunks that arrived after the snapshot cutoff', () => {
      // Snapshot includes up through seq=2. Live chunks with seq=3,4 must still be
      // rendered after the snapshot — they would be lost if we discarded the queue.
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.handleLive('a', 1);
      dedup.handleLive('b', 2);
      dedup.handleLive('c', 3);
      dedup.handleLive('d', 4);
      dedup.applySnapshot('ab', 2);

      // Snapshot, then the drained queue, written together in chronological order.
      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('ab', 'cd');
      expect(writeLive).not.toHaveBeenCalled();
    });

    it('boundary: seq === snapshot.seq is dropped, seq > snapshot.seq is kept', () => {
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.handleLive('covered', 5);
      dedup.handleLive('new', 6);
      dedup.applySnapshot('snap', 5);

      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('snap', 'new');
      expect(writeLive).not.toHaveBeenCalled();
    });

    it('empty snapshot buffer with queued post-snapshot chunks still flushes them', () => {
      // Snapshot raced ahead of the buffer append; queue has chunks the snapshot didn't
      // capture. They still need to reach the terminal.
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.handleLive('fresh', 1);
      dedup.applySnapshot('', 0);

      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('', 'fresh');
      expect(writeLive).not.toHaveBeenCalled();
    });

    it('empty snapshot and empty queue writes nothing', () => {
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.applySnapshot('', 0);

      expect(writeSnapshot).not.toHaveBeenCalled();
      expect(writeLive).not.toHaveBeenCalled();
    });
  });

  describe('post-snapshot live stream', () => {
    it('writes chunks with seq > snapshot.seq directly via writeLive', () => {
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.applySnapshot('snap', 3);
      dedup.handleLive('d', 4);
      dedup.handleLive('e', 5);

      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('snap', '');
      expect(writeLive).toHaveBeenNthCalledWith(1, 'd');
      expect(writeLive).toHaveBeenNthCalledWith(2, 'e');
    });

    it('drops a late-arriving chunk whose seq is already covered by the snapshot', () => {
      // IPC doesn't guarantee live chunk arrival order relative to the snapshot
      // resolving. If a chunk with seq <= snapshot.seq arrives after applySnapshot,
      // it's already in the snapshot and must be ignored.
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.applySnapshot('snap', 5);
      dedup.handleLive('stale', 5);
      dedup.handleLive('stale-earlier', 3);

      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('snap', '');
      expect(writeLive).not.toHaveBeenCalled();
    });
  });

  describe('idempotence', () => {
    it('ignores a second applySnapshot call', () => {
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.applySnapshot('first', 1);
      dedup.applySnapshot('second', 10);

      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('first', '');
      // Second snapshot's seq=10 doesn't take effect: a post-first-snapshot chunk
      // should still be written, not dropped by the would-be second cursor.
      dedup.handleLive('live', 2);
      expect(writeLive).toHaveBeenCalledExactlyOnceWith('live');
    });
  });

  describe('disposal', () => {
    it('ignores live chunks after dispose()', () => {
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.dispose();
      dedup.handleLive('ignored', 1);
      dedup.applySnapshot('ignored', 5);

      expect(writeSnapshot).not.toHaveBeenCalled();
      expect(writeLive).not.toHaveBeenCalled();
    });

    it('drops queued chunks on dispose before snapshot arrives', () => {
      const { dedup, writeSnapshot, writeLive } = setup();

      dedup.handleLive('a', 1);
      dedup.handleLive('b', 2);
      expect(dedup.queuedChunkCount).toBe(2);

      dedup.dispose();
      expect(dedup.queuedChunkCount).toBe(0);

      dedup.applySnapshot('x', 0);
      expect(writeSnapshot).not.toHaveBeenCalled();
      expect(writeLive).not.toHaveBeenCalled();
    });
  });

  describe('ordering', () => {
    it('preserves chronological order when queue drains out of seq order', () => {
      // Chunks can in principle be pushed in any order via handleLive — the module
      // must filter by seq but preserve insertion order (which mirrors arrival
      // order, i.e. the order the main process sent them).
      const { dedup, writeSnapshot } = setup();

      dedup.handleLive('chunk-a', 10);
      dedup.handleLive('chunk-b', 11);
      dedup.handleLive('chunk-c', 12);
      dedup.applySnapshot('snap', 10);

      expect(writeSnapshot).toHaveBeenCalledExactlyOnceWith('snap', 'chunk-bchunk-c');
    });
  });
});
