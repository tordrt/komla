import { describe, expect, it } from 'vitest';

import { pickBestLiveFollowFile } from '@/components/terminal/live-follow-picker';

import type { FileChange } from '@/types';

function file(partial: Partial<FileChange> & { path: string }): FileChange {
  return {
    path: partial.path,
    status: partial.status ?? 'modified',
    staged: partial.staged ?? false,
    isDirectory: partial.isDirectory ?? false,
    additions: partial.additions ?? 0,
    deletions: partial.deletions ?? 0,
  };
}

describe('pickBestLiveFollowFile', () => {
  it('returns null on the first load (no previous files)', () => {
    expect(pickBestLiveFollowFile(null, [file({ path: 'a.ts', additions: 5 })])).toBeNull();
  });

  it('returns null when no file has meaningful change', () => {
    const prev = [file({ path: 'a.ts', additions: 3, deletions: 1 })];
    const next = [file({ path: 'a.ts', additions: 3, deletions: 1 })];
    expect(pickBestLiveFollowFile(prev, next)).toBeNull();
  });

  it('prefers new files over larger deltas on existing files', () => {
    const prev = [file({ path: 'a.ts', additions: 10, deletions: 5 })];
    const next = [
      file({ path: 'a.ts', additions: 200, deletions: 200 }),
      file({ path: 'b.ts', additions: 1, deletions: 0 }),
    ];
    expect(pickBestLiveFollowFile(prev, next)).toBe('b.ts');
  });

  it('scores existing files by absolute delta in additions + deletions', () => {
    const prev = [
      file({ path: 'a.ts', additions: 10, deletions: 0 }),
      file({ path: 'b.ts', additions: 0, deletions: 0 }),
    ];
    const next = [
      file({ path: 'a.ts', additions: 12, deletions: 1 }),
      file({ path: 'b.ts', additions: 5, deletions: 0 }),
    ];
    // a.ts delta = |12-10| + |1-0| = 3; b.ts delta = |5-0| = 5
    expect(pickBestLiveFollowFile(prev, next)).toBe('b.ts');
  });

  it('skips directories when scoring', () => {
    const prev = [file({ path: 'dir', isDirectory: true, additions: 0, deletions: 0 })];
    const next = [
      file({ path: 'dir', isDirectory: true, additions: 100, deletions: 100 }),
      file({ path: 'a.ts', additions: 1, deletions: 0 }),
    ];
    expect(pickBestLiveFollowFile(prev, next)).toBe('a.ts');
  });

  it('returns the first file when multiple share the best score', () => {
    const prev = [
      file({ path: 'a.ts', additions: 0, deletions: 0 }),
      file({ path: 'b.ts', additions: 0, deletions: 0 }),
    ];
    const next = [
      file({ path: 'a.ts', additions: 5, deletions: 0 }),
      file({ path: 'b.ts', additions: 5, deletions: 0 }),
    ];
    expect(pickBestLiveFollowFile(prev, next)).toBe('a.ts');
  });
});
