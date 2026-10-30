import { describe, expect, it } from 'vitest';

import {
  buildDiffChangePills,
  buildWorkspaceChangePills,
  hasGitStatusToShow,
} from '@/components/workspaces/git-status-summary';

import type { FileChange, GitBranchQuickStatus } from '@/types';

function file(status: FileChange['status']): FileChange {
  return {
    path: `${status}.bin`,
    status,
    staged: false,
    additions: 0,
    deletions: 0,
  };
}

describe('buildWorkspaceChangePills', () => {
  it('prefers line stats when additions or deletions exist', () => {
    expect(
      buildWorkspaceChangePills({
        additions: 12,
        deletions: 3,
        files: [file('added'), file('deleted'), file('modified')],
      })
    ).toEqual([
      { kind: 'additions', label: '+12', count: 12 },
      { kind: 'deletions', label: '-3', count: 3 },
    ]);
  });

  it('falls back to changed file counts when line stats are empty', () => {
    expect(
      buildWorkspaceChangePills({
        additions: 0,
        deletions: 0,
        files: [file('added'), file('untracked'), file('deleted'), file('modified')],
      })
    ).toEqual([
      { kind: 'new-files', label: '2', count: 2 },
      { kind: 'deleted-files', label: '1', count: 1 },
    ]);
  });

  it('shows modified file counts when no new or deleted files are present', () => {
    expect(
      buildWorkspaceChangePills({
        additions: 0,
        deletions: 0,
        files: [file('modified'), file('renamed')],
      })
    ).toEqual([{ kind: 'modified-files', label: '2', count: 2 }]);
  });

  it('returns no pills when there are no changed lines or files', () => {
    expect(buildWorkspaceChangePills({ additions: 0, deletions: 0, files: [] })).toEqual([]);
  });
});

it('labels partial totals when an untracked line count is unavailable', () => {
  const pills = buildWorkspaceChangePills({
    additions: 12,
    deletions: 3,
    files: [{ ...file('untracked'), lineCountsUnavailable: true }],
  });
  expect(pills[0]).toMatchObject({ label: '+12*', title: expect.stringContaining('unavailable') });
  expect(pills[1]).toMatchObject({ label: '-3' });
});

describe('buildDiffChangePills', () => {
  it('has no pills for a diff that has yet to load', () => {
    expect(buildDiffChangePills(undefined)).toEqual([]);
  });

  it('builds pills from the diff summary and files', () => {
    const summary = { additions: 0, deletions: 0, filesChanged: 1 };
    expect(buildDiffChangePills({ files: [file('modified')], summary })).toEqual([
      { kind: 'modified-files', label: '1', count: 1 },
    ]);
  });
});

describe('hasGitStatusToShow', () => {
  const clean = { behindTargetBranch: 0, aheadTargetBranch: 0 } as GitBranchQuickStatus;

  it('has nothing to show until the status loads, even with change pills', () => {
    expect(hasGitStatusToShow(undefined, true)).toBe(false);
  });

  it('has nothing to show while clean and up to date', () => {
    expect(hasGitStatusToShow(clean, false)).toBe(false);
  });

  it.each([
    ['change pills', clean, true],
    ['commits ahead', { ...clean, aheadTargetBranch: 1 }, false],
    ['commits behind', { ...clean, behindTargetBranch: 1 }, false],
    ['a paused rebase', { ...clean, rebaseInProgress: true }, false],
  ])('shows %s', (_label, status, hasChangePills) => {
    expect(hasGitStatusToShow(status, hasChangePills)).toBe(true);
  });
});
