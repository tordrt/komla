import { describe, expect, it } from 'vitest';

import {
  isMainBranch,
  needsRepoPublish,
  resolveBehindAction,
  resolveAheadAction,
  resolveActionId,
  resolveRemoteWriteAction,
  resolveUnpushedDisplay,
} from '../../src/shared/lib/ahead-action';

describe('isMainBranch', () => {
  it('returns true for "main"', () => {
    expect(isMainBranch('main')).toBe(true);
  });

  it('returns true for "master"', () => {
    expect(isMainBranch('master')).toBe(true);
  });

  it('returns true for undefined', () => {
    expect(isMainBranch(undefined)).toBe(true);
  });

  it('returns true for null', () => {
    expect(isMainBranch(null)).toBe(true);
  });

  it('returns false for feature branches', () => {
    expect(isMainBranch('feature/foo')).toBe(false);
    expect(isMainBranch('develop')).toBe(false);
    expect(isMainBranch('staging')).toBe(false);
  });
});

describe('resolveAheadAction', () => {
  describe('explicit (non-auto) actions', () => {
    it('returns "pr" when explicitly set', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'pr' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('returns "merge" when explicitly set', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'merge' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('merge');
    });

    it('returns "disabled" when explicitly set', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'disabled' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('disabled');
    });

    it('returns "agent-prompt" when explicitly set', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'agent-prompt' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('agent-prompt');
    });

    it('ignores target branch when explicit action is set', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'pr' },
          targetBranch: 'feature/foo',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('ignores autoMainBranchAction/autoOtherBranchAction when explicit', () => {
      expect(
        resolveAheadAction({
          project: {
            aheadTargetAction: 'merge',
            autoMainBranchAction: 'pr',
            autoOtherBranchAction: 'disabled',
          },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('merge');
    });
  });

  describe('auto mode (explicit "auto")', () => {
    it('defaults to PR for main when has remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('defaults to merge for main when no remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto' },
          targetBranch: 'main',
          hasOriginRemote: false,
        })
      ).toBe('merge');
    });

    it('defaults to PR for master when has remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto' },
          targetBranch: 'master',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('defaults to merge for other branches', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto' },
          targetBranch: 'develop',
          hasOriginRemote: true,
        })
      ).toBe('merge');
    });

    it('uses autoMainBranchAction when set and target is main', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto', autoMainBranchAction: 'agent-prompt' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('agent-prompt');
    });

    it('uses autoOtherBranchAction when set and target is non-main', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto', autoOtherBranchAction: 'pr' },
          targetBranch: 'feature/foo',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('uses different actions for main vs other branches', () => {
      const project = {
        aheadTargetAction: 'auto' as const,
        autoMainBranchAction: 'pr' as const,
        autoOtherBranchAction: 'agent-prompt' as const,
      };

      expect(resolveAheadAction({ project, targetBranch: 'main', hasOriginRemote: true })).toBe(
        'pr'
      );
      expect(
        resolveAheadAction({ project, targetBranch: 'feature/x', hasOriginRemote: true })
      ).toBe('agent-prompt');
    });

    it('defaults to PR for undefined target branch (assumed main)', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto' },
          targetBranch: undefined,
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });
  });

  describe('auto-default mode', () => {
    it('returns PR for main with remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto-default' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('returns merge for main without remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto-default' },
          targetBranch: 'main',
          hasOriginRemote: false,
        })
      ).toBe('merge');
    });

    it('returns merge for other branches', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto-default' },
          targetBranch: 'develop',
          hasOriginRemote: true,
        })
      ).toBe('merge');
    });

    it('ignores custom per-branch overrides', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'auto-default', autoMainBranchAction: 'disabled' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });
  });

  describe('undefined aheadTargetAction (defaults to auto-default)', () => {
    it('returns PR for main with remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: undefined },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('returns merge for other branches', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: undefined },
          targetBranch: 'develop',
          hasOriginRemote: true,
        })
      ).toBe('merge');
    });

    it('ignores custom per-branch overrides (treated as auto-default)', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: undefined, autoMainBranchAction: 'disabled' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });
  });

  describe('unconfigured (treated as auto-default)', () => {
    it('returns "pr" when targeting main with origin remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'unconfigured' },
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('returns "merge" when targeting main without origin remote', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'unconfigured' },
          targetBranch: 'main',
          hasOriginRemote: false,
        })
      ).toBe('merge');
    });

    it('returns "merge" when targeting non-main branch', () => {
      expect(
        resolveAheadAction({
          project: { aheadTargetAction: 'unconfigured' },
          targetBranch: 'develop',
          hasOriginRemote: true,
        })
      ).toBe('merge');
    });
  });

  describe('no project', () => {
    it('defaults to PR for main with remote when project is undefined', () => {
      expect(
        resolveAheadAction({
          project: undefined,
          targetBranch: 'main',
          hasOriginRemote: true,
        })
      ).toBe('pr');
    });

    it('defaults to merge for main without remote when project is null', () => {
      expect(
        resolveAheadAction({
          project: null,
          targetBranch: 'main',
          hasOriginRemote: false,
        })
      ).toBe('merge');
    });

    it('defaults to merge for other branches when project is undefined', () => {
      expect(
        resolveAheadAction({
          project: undefined,
          targetBranch: 'feature/foo',
          hasOriginRemote: true,
        })
      ).toBe('merge');
    });
  });
});

describe('resolveRemoteWriteAction', () => {
  it('returns none when repo has no origin remote', () => {
    expect(resolveRemoteWriteAction({ hasOriginRemote: false, hasRemote: false })).toBe('none');
  });

  it('returns publish when origin exists but branch is not on remote', () => {
    expect(resolveRemoteWriteAction({ hasOriginRemote: true, hasRemote: false })).toBe('publish');
  });

  it('returns push when branch is already on remote', () => {
    expect(resolveRemoteWriteAction({ hasOriginRemote: true, hasRemote: true })).toBe('push');
  });
});

describe('needsRepoPublish', () => {
  it('offers publishing a repo without origin', () => {
    expect(
      needsRepoPublish({ hasOriginRemote: false, hasRemote: false, targetBranchHasRemote: false })
    ).toBe(true);
  });

  it('offers publishing again when origin has neither branch, as after a failed first push', () => {
    expect(
      needsRepoPublish({ hasOriginRemote: true, hasRemote: false, targetBranchHasRemote: false })
    ).toBe(true);
  });

  it('does not offer it once origin has the target or the workspace branch', () => {
    expect(
      needsRepoPublish({ hasOriginRemote: true, hasRemote: false, targetBranchHasRemote: true })
    ).toBe(false);
    expect(
      needsRepoPublish({ hasOriginRemote: true, hasRemote: true, targetBranchHasRemote: false })
    ).toBe(false);
  });
});

describe('resolveActionId', () => {
  describe('explicit (non-auto) action', () => {
    it('returns project-level action ID', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'agent-prompt',
            aheadTargetActionId: 'tmpl-1',
          },
          targetBranch: 'main',
        })
      ).toBe('tmpl-1');
    });

    it('returns undefined when no action configured', () => {
      expect(
        resolveActionId({
          project: { aheadTargetAction: 'agent-prompt' },
          targetBranch: 'main',
        })
      ).toBeUndefined();
    });

    it('ignores auto action IDs when explicit action set', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'agent-prompt',
            aheadTargetActionId: 'tmpl-1',
            autoMainActionId: 'tmpl-main',
            autoOtherActionId: 'tmpl-other',
          },
          targetBranch: 'main',
        })
      ).toBe('tmpl-1');
    });
  });

  describe('auto mode', () => {
    it('returns main action for main branch', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'auto',
            autoMainActionId: 'tmpl-main',
            autoOtherActionId: 'tmpl-other',
          },
          targetBranch: 'main',
        })
      ).toBe('tmpl-main');
    });

    it('returns other action for non-main branch', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'auto',
            autoMainActionId: 'tmpl-main',
            autoOtherActionId: 'tmpl-other',
          },
          targetBranch: 'feature/foo',
        })
      ).toBe('tmpl-other');
    });

    it('returns undefined for main when no main action set', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'auto',
            autoOtherActionId: 'tmpl-other',
          },
          targetBranch: 'main',
        })
      ).toBeUndefined();
    });

    it('returns undefined for non-main when no other action set', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'auto',
            autoMainActionId: 'tmpl-main',
          },
          targetBranch: 'develop',
        })
      ).toBeUndefined();
    });

    it('returns main action for master branch', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'auto',
            autoMainActionId: 'tmpl-main',
          },
          targetBranch: 'master',
        })
      ).toBe('tmpl-main');
    });
  });

  describe('auto-default mode', () => {
    it('returns undefined (no action IDs for auto-default)', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'auto-default',
            autoMainActionId: 'tmpl-main',
          },
          targetBranch: 'main',
        })
      ).toBeUndefined();
    });
  });

  describe('unconfigured mode', () => {
    it('returns undefined for unconfigured action', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: 'unconfigured',
            aheadTargetActionId: 'some-id',
          },
          targetBranch: 'main',
        })
      ).toBeUndefined();
    });
  });

  describe('undefined aheadTargetAction (defaults to auto-default)', () => {
    it('returns undefined for main branch', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: undefined,
            autoMainActionId: 'tmpl-main',
          },
          targetBranch: 'main',
        })
      ).toBeUndefined();
    });

    it('returns undefined for non-main branch', () => {
      expect(
        resolveActionId({
          project: {
            aheadTargetAction: undefined,
            autoOtherActionId: 'tmpl-other',
          },
          targetBranch: 'develop',
        })
      ).toBeUndefined();
    });
  });

  describe('no project', () => {
    it('returns undefined when project is undefined', () => {
      expect(
        resolveActionId({
          project: undefined,
          targetBranch: 'main',
        })
      ).toBeUndefined();
    });

    it('returns undefined when project is null', () => {
      expect(
        resolveActionId({
          project: null,
          targetBranch: 'main',
        })
      ).toBeUndefined();
    });
  });
});

describe('resolveBehindAction', () => {
  describe('explicit behindTargetAction', () => {
    it('returns "rebase" when explicitly set', () => {
      expect(
        resolveBehindAction({ project: { behindTargetAction: 'rebase' }, hasRemote: false })
      ).toBe('rebase');
    });

    it('returns "merge" when explicitly set', () => {
      expect(
        resolveBehindAction({ project: { behindTargetAction: 'merge' }, hasRemote: false })
      ).toBe('merge');
    });

    it('ignores hasRemote when behindTargetAction is explicit', () => {
      expect(
        resolveBehindAction({ project: { behindTargetAction: 'rebase' }, hasRemote: true })
      ).toBe('rebase');
    });
  });

  describe('auto behindTargetAction', () => {
    it('returns merge when auto and branch has remote', () => {
      expect(
        resolveBehindAction({ project: { behindTargetAction: 'auto' }, hasRemote: true })
      ).toBe('merge');
    });

    it('returns rebase when auto and branch has no remote', () => {
      expect(
        resolveBehindAction({ project: { behindTargetAction: 'auto' }, hasRemote: false })
      ).toBe('rebase');
    });
  });

  describe('default behavior (no behindTargetAction set)', () => {
    it('defaults to merge when branch has a remote tracking ref', () => {
      expect(
        resolveBehindAction({ project: { behindTargetAction: undefined }, hasRemote: true })
      ).toBe('merge');
    });

    it('defaults to rebase when branch has no remote tracking ref', () => {
      expect(
        resolveBehindAction({ project: { behindTargetAction: undefined }, hasRemote: false })
      ).toBe('rebase');
    });

    it('defaults to merge when project is undefined and branch has remote', () => {
      expect(resolveBehindAction({ project: undefined, hasRemote: true })).toBe('merge');
    });

    it('defaults to rebase when project is undefined and branch has no remote', () => {
      expect(resolveBehindAction({ project: undefined, hasRemote: false })).toBe('rebase');
    });

    it('defaults to merge when project is null and branch has remote', () => {
      expect(resolveBehindAction({ project: null, hasRemote: true })).toBe('merge');
    });
  });
});

describe('resolveUnpushedDisplay', () => {
  it('shows the commits a tracked branch has not pushed', () => {
    expect(resolveUnpushedDisplay({ hasRemote: true, unpushedCommits: 3 })).toEqual({
      show: true,
      count: 3,
    });
  });

  it('hides when a tracked branch has pushed everything', () => {
    expect(resolveUnpushedDisplay({ hasRemote: true, unpushedCommits: 0 })).toEqual({
      show: false,
      count: 0,
    });
  });

  it('hides for a branch not published to origin', () => {
    expect(resolveUnpushedDisplay({ hasRemote: false, unpushedCommits: 0 })).toEqual({
      show: false,
      count: 0,
    });
  });
});

describe("origin's default branch", () => {
  it('opens a PR for a target named by origin/HEAD that is not main/master', () => {
    expect(
      resolveAheadAction({
        project: { aheadTargetAction: 'unconfigured' },
        targetBranch: 'develop',
        remoteDefaultBranch: 'develop',
        hasOriginRemote: true,
      })
    ).toBe('pr');
  });

  it('uses the default-branch action in custom per-branch mode', () => {
    const project = {
      aheadTargetAction: 'auto' as const,
      autoMainBranchAction: 'agent-prompt' as const,
      autoOtherBranchAction: 'merge' as const,
      autoMainActionId: 'tmpl-main',
      autoOtherActionId: 'tmpl-other',
    };
    const target = { targetBranch: 'trunk', remoteDefaultBranch: 'trunk' };

    expect(resolveAheadAction({ project, ...target, hasOriginRemote: true })).toBe('agent-prompt');
    expect(resolveActionId({ project, ...target })).toBe('tmpl-main');
  });

  it('still fast-forwards other targets', () => {
    expect(
      resolveAheadAction({
        project: { aheadTargetAction: 'auto-default' },
        targetBranch: 'feature/base',
        remoteDefaultBranch: 'develop',
        hasOriginRemote: true,
      })
    ).toBe('merge');
  });

  it('keeps main and master as PR targets when origin names another branch', () => {
    expect(
      resolveAheadAction({
        project: undefined,
        targetBranch: 'main',
        remoteDefaultBranch: 'develop',
        hasOriginRemote: true,
      })
    ).toBe('pr');
  });
});
