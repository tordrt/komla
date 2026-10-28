import { describe, expect, it } from 'vitest';

import { toGitBranchQuickStatus } from '../../../src/shared/lib/workspace-branch-status';

describe('toGitBranchQuickStatus', () => {
  it('maps a companion branch observation and applies the retained default branch', () => {
    expect(
      toGitBranchQuickStatus(
        {
          currentBranch: 'feature',
          targetBranch: 'release',
          aheadTargetBranch: 2,
          behindTargetBranch: 1,
          hasRemote: true,
          hasOriginRemote: true,
          unpushedCommits: 2,
          behindRemote: 0,
          targetBranchHasRemote: true,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 1,
        },
        'main'
      )
    ).toEqual({
      currentBranch: 'feature',
      mainBranch: 'release',
      defaultBranch: 'main',
      aheadTargetBranch: 2,
      behindTargetBranch: 1,
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 2,
      behindRemote: 0,
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 1,
    });
  });

  it('prefers the observed default branch and otherwise falls back to the target', () => {
    const branch = {
      currentBranch: 'feature',
      targetBranch: 'release',
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };

    expect(toGitBranchQuickStatus({ ...branch, defaultBranch: 'trunk' }, 'main').defaultBranch).toBe(
      'trunk'
    );
    expect(toGitBranchQuickStatus(branch).defaultBranch).toBe('release');
  });

  it('keeps a paused rebase', () => {
    const branch = {
      currentBranch: 'HEAD',
      targetBranch: 'main',
      aheadTargetBranch: 0,
      behindTargetBranch: 0,
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };

    expect(toGitBranchQuickStatus({ ...branch, rebaseInProgress: true }).rebaseInProgress).toBe(
      true
    );
  });
});
