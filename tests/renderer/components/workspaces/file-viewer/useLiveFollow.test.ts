import { describe, expect, it } from 'vitest';

import { pickMostChangedFile } from '../../../../../src/renderer/components/workspaces/file-viewer/useLiveFollow';

import type { FileChange } from '../../../../../src/renderer/types';

function file(path: string, additions: number, deletions: number, isDirectory = false): FileChange {
  return {
    path,
    additions,
    deletions,
    status: 'modified',
    isDirectory,
  } as FileChange;
}

describe('pickMostChangedFile', () => {
  it('returns null when no current files have changes', () => {
    expect(pickMostChangedFile([], [])).toBeNull();
  });

  it('picks the file with the largest delta from previous state', () => {
    const prev = [file('a.ts', 1, 0), file('b.ts', 5, 5)];
    const next = [file('a.ts', 10, 0), file('b.ts', 5, 6)];
    // a delta = 9, b delta = 1 => pick a
    expect(pickMostChangedFile(prev, next)).toBe('a.ts');
  });

  it('treats brand-new files as biggest changes (>= 10000 score)', () => {
    const prev = [file('existing.ts', 1000, 1000)];
    // existing delta = 0 (no change), new file gets 10000+
    const next = [file('existing.ts', 1000, 1000), file('brand-new.ts', 1, 0)];
    expect(pickMostChangedFile(prev, next)).toBe('brand-new.ts');
  });

  it('skips directories', () => {
    const prev: FileChange[] = [];
    const next = [file('dir', 1000, 1000, true), file('a.ts', 1, 0)];
    expect(pickMostChangedFile(prev, next)).toBe('a.ts');
  });

  it('returns null when no file has any change-score', () => {
    // Same files, same numbers => all deltas 0; skip
    const prev = [file('a.ts', 1, 0)];
    const next = [file('a.ts', 1, 0)];
    expect(pickMostChangedFile(prev, next)).toBeNull();
  });
});
