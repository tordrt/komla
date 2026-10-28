import { describe, expect, it } from 'vitest';

import {
  workspaceCommitDiffArgsSchema,
  workspaceCommitFileDiffArgsSchema,
  workspaceCommitGraphArgsSchema,
} from '../../../../src/main/ipc/validation/git-ipc.schemas';

const HASH = 'a'.repeat(40);

describe('workspace commit IPC schemas', () => {
  it("accepts a page of a branch's history of one file, kept as given", () => {
    const query = { limit: 50, skip: 100, ref: 'origin/feature-1', path: ' spaced name.ts' };
    expect(workspaceCommitGraphArgsSchema.parse(['ws', query])).toEqual(['ws', query]);
    expect(workspaceCommitGraphArgsSchema.parse(['ws', { limit: 1 }])).toEqual([
      'ws',
      { limit: 1 },
    ]);
    expect(workspaceCommitFileDiffArgsSchema.parse(['ws', HASH, 'src/a.ts '])).toEqual([
      'ws',
      HASH,
      'src/a.ts ',
    ]);
  });

  it('rejects refs that read as options or that git would refuse, and queries out of bounds', () => {
    for (const ref of ['-x', '--output=/tmp/x', 'a b', 'a\\b', 'a:b', 'a~1', '', 'x'.repeat(257)]) {
      expect(() => workspaceCommitGraphArgsSchema.parse(['ws', { limit: 1, ref }])).toThrow();
    }
    for (const query of [
      { limit: 0 },
      { limit: 501 },
      { limit: 1, skip: -1 },
      { limit: 1, skip: 1e21 },
      { limit: 1, path: 'a\0b' },
      { limit: 1, extra: true },
    ]) {
      expect(() => workspaceCommitGraphArgsSchema.parse(['ws', query])).toThrow();
    }
  });

  it('takes commits only by their hash', () => {
    expect(workspaceCommitDiffArgsSchema.parse(['ws', 'abc1234'])).toEqual(['ws', 'abc1234']);
    for (const hash of ['--output=x', 'HEAD', 'abc', 'g'.repeat(40)]) {
      expect(() => workspaceCommitDiffArgsSchema.parse(['ws', hash])).toThrow();
      expect(() => workspaceCommitFileDiffArgsSchema.parse(['ws', hash, 'a.ts'])).toThrow();
    }
  });
});
