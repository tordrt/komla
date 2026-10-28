import { describe, expect, it } from 'vitest';

import { parseNameStatusZ } from '../../../../src/main/services/git/git-status';

describe('parseNameStatusZ', () => {
  it('lists a copy as a new file and a rename with its previous path', () => {
    const files = parseNameStatusZ(
      ['C075', 'source.ts', 'copy.ts', 'R100', 'old.ts', 'new.ts', ''].join('\0'),
      new Map()
    );

    expect(files).toEqual([
      { path: 'copy.ts', status: 'added', staged: false, additions: 0, deletions: 0 },
      {
        path: 'new.ts',
        originalPath: 'old.ts',
        status: 'renamed',
        staged: false,
        additions: 0,
        deletions: 0,
      },
    ]);
  });
});
