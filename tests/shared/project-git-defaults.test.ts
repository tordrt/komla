import { describe, expect, it } from 'vitest';

import {
  aheadPreset,
  resolveBranchPrefix,
  withGitDefaults,
} from '../../src/shared/lib/project-git-defaults';

import type { GitDefaults, Project } from '../../src/shared/types/project';

const project: Project = {
  id: 'p1',
  name: 'Repo',
  repositoryPath: '/repo',
  defaultBranchPrefix: '',
  createdAt: 0,
  order: 0,
  managed: true,
};

const defaults: GitDefaults = {
  branchPrefix: 'me/',
  aheadMainAction: 'merge',
  aheadOtherAction: 'pr',
  autoPushAfterMerge: false,
  behindTargetAction: 'rebase',
};

describe('aheadPreset', () => {
  it.each([
    ['pr', 'merge', 'auto-default'],
    ['merge', 'merge', 'merge'],
    ['disabled', 'disabled', 'disabled'],
    ['merge', 'pr', undefined],
    ['agent-prompt', 'agent-prompt', undefined],
  ] as const)('matches %s and %s to %s', (main, other, preset) => {
    expect(aheadPreset(main, other)).toBe(preset);
  });
});

describe('resolveBranchPrefix', () => {
  it('uses the project prefix, then the app-wide one', () => {
    expect(resolveBranchPrefix({ defaultBranchPrefix: 'own/' }, defaults)).toBe('own/');
    expect(resolveBranchPrefix(project, defaults)).toBe('me/');
    expect(resolveBranchPrefix(project, undefined)).toBe('');
    expect(resolveBranchPrefix(undefined, defaults)).toBe('me/');
  });
});

describe('withGitDefaults', () => {
  it('fills in the built-in behavior when neither the project nor the app sets anything', () => {
    expect(withGitDefaults(project, undefined)).toMatchObject({
      defaultBranchPrefix: '',
      aheadTargetAction: 'unconfigured',
      autoPushAfterMerge: true,
      behindTargetAction: 'auto',
    });
  });

  it('follows the app-wide defaults where the project sets nothing', () => {
    expect(withGitDefaults(project, defaults)).toMatchObject({
      defaultBranchPrefix: 'me/',
      aheadTargetAction: 'auto',
      autoMainBranchAction: 'merge',
      autoOtherBranchAction: 'pr',
      autoPushAfterMerge: false,
      behindTargetAction: 'rebase',
    });
  });

  it('keeps PR-or-fast-forward as its preset, which fast-forwards repositories without origin', () => {
    expect(
      withGitDefaults(project, { aheadMainAction: 'pr', aheadOtherAction: 'merge' })
    ).toMatchObject({ aheadTargetAction: 'auto-default' });
  });

  it("keeps the project's own settings", () => {
    const own: Project = {
      ...project,
      defaultBranchPrefix: 'own/',
      aheadTargetAction: 'disabled',
      autoPushAfterMerge: true,
      behindTargetAction: 'merge',
    };
    expect(withGitDefaults(own, defaults)).toMatchObject({
      defaultBranchPrefix: 'own/',
      aheadTargetAction: 'disabled',
      autoPushAfterMerge: true,
      behindTargetAction: 'merge',
    });
  });

  it('brings the app-wide quick command along with its choice', () => {
    const quickCommand: GitDefaults = {
      aheadMainAction: 'agent-prompt',
      aheadMainActionId: 'pr-draft',
      aheadOtherAction: 'merge',
    };
    expect(withGitDefaults(project, quickCommand)).toMatchObject({
      aheadTargetAction: 'auto',
      autoMainBranchAction: 'agent-prompt',
      autoMainActionId: 'pr-draft',
      autoOtherBranchAction: 'merge',
    });
    const ownOther: Project = {
      ...project,
      aheadTargetAction: 'auto',
      autoOtherBranchAction: 'agent-prompt',
      autoOtherActionId: 'own',
    };
    expect(withGitDefaults(ownOther, quickCommand)).toMatchObject({
      autoMainBranchAction: 'agent-prompt',
      autoMainActionId: 'pr-draft',
      autoOtherBranchAction: 'agent-prompt',
      autoOtherActionId: 'own',
    });
  });

  it('fast-forwards the default branch of a repository without origin instead of an inherited quick command', () => {
    const quickCommand: GitDefaults = {
      aheadMainAction: 'agent-prompt',
      aheadMainActionId: 'pr-draft',
      aheadOtherAction: 'merge',
    };
    const noOrigin = { hasOriginRemote: false };
    expect(withGitDefaults(project, quickCommand, noOrigin)).toMatchObject({
      aheadTargetAction: 'merge',
    });
    const ownOther: Project = {
      ...project,
      aheadTargetAction: 'auto',
      autoOtherBranchAction: 'pr',
    };
    expect(withGitDefaults(ownOther, quickCommand, noOrigin)).toMatchObject({
      autoMainBranchAction: 'merge',
      autoMainActionId: undefined,
    });
    const ownMain: Project = {
      ...project,
      aheadTargetAction: 'auto',
      autoMainBranchAction: 'agent-prompt',
      autoMainActionId: 'own',
    };
    expect(withGitDefaults(ownMain, quickCommand, noOrigin)).toMatchObject({
      autoMainBranchAction: 'agent-prompt',
      autoMainActionId: 'own',
    });
    // Until the repository's status is known, nothing changes.
    expect(withGitDefaults(project, quickCommand, {})).toMatchObject({
      autoMainBranchAction: 'agent-prompt',
      autoMainActionId: 'pr-draft',
    });
  });

  it('takes a per-branch choice the project leaves unset from the app-wide one', () => {
    const custom: Project = {
      ...project,
      aheadTargetAction: 'auto',
      autoMainBranchAction: 'agent-prompt',
    };
    expect(withGitDefaults(custom, defaults)).toMatchObject({
      aheadTargetAction: 'auto',
      autoMainBranchAction: 'agent-prompt',
      autoOtherBranchAction: 'pr',
    });
  });
});
