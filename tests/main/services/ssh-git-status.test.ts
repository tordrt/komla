import { describe, expect, it } from 'vitest';

import { parsePorcelainZ } from '../../../src/main/services/ssh-git-status';

describe('parsePorcelainZ', () => {
  it('derives aggregate HEAD-to-working-tree status from both porcelain columns', () => {
    const files = parsePorcelainZ(
      [
        'AM added.ts',
        'AD absent.ts',
        'MD deleted.ts',
        'MM modified.ts',
        'RM renamed.ts',
        'old-name.ts',
        'RD gone.ts',
        'was.ts',
        'C  copy.ts',
        'source.ts',
        'CD dropped-copy.ts',
        'other-source.ts',
        '?? untracked.ts',
        '',
      ].join('\0'),
      ''
    );

    expect(files).toEqual([
      expect.objectContaining({ path: 'added.ts', status: 'added', staged: false }),
      expect.objectContaining({ path: 'deleted.ts', status: 'deleted', staged: false }),
      expect.objectContaining({ path: 'modified.ts', status: 'modified', staged: false }),
      expect.objectContaining({ path: 'renamed.ts', status: 'renamed', staged: false }),
      // A rename whose new file is gone again leaves only its previous path's deletion.
      expect.objectContaining({ path: 'was.ts', status: 'deleted', staged: false }),
      // A copy's source is untouched, so the copy is just a new file.
      expect.objectContaining({ path: 'copy.ts', status: 'added', staged: false }),
      expect.objectContaining({ path: 'untracked.ts', status: 'untracked', staged: false }),
    ]);
    expect(files.filter((file) => file.originalPath).map((file) => file.path)).toEqual([
      'renamed.ts',
    ]);
  });

  it('preserves rename sources and counts untracked additions from numstat', () => {
    const files = parsePorcelainZ(
      ['R  new-name.ts', 'old-name.ts', '?? notes.txt', ''].join('\0'),
      ['2\t1\t\0old-name.ts\0new-name.ts\0', '3\t0\tnotes.txt\0', ''].join('')
    );

    expect(files).toEqual([
      expect.objectContaining({
        path: 'new-name.ts',
        originalPath: 'old-name.ts',
        additions: 2,
        deletions: 1,
      }),
      expect.objectContaining({ path: 'notes.txt', additions: 3, deletions: 0 }),
    ]);
  });
});

it('marks omitted untracked counts unavailable without confusing binary or empty files', () => {
  const files = parsePorcelainZ(
    '?? large.txt\0?? binary.bin\0?? empty.txt\0 M tracked.txt\0',
    ['-\t-\tbinary.bin', '0\t0\tempty.txt', '3\t2\ttracked.txt', ''].join('\0')
  );
  expect(files[0]).toMatchObject({ path: 'large.txt', lineCountsUnavailable: true });
  expect(files.slice(1).every((file) => !file.lineCountsUnavailable)).toBe(true);
  expect(files[3]).toMatchObject({ additions: 3, deletions: 2 });
});
