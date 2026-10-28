import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUnsavedWorkByWorkspace } from '../../../src/renderer/lib/workspace-unsaved-work';
import { createWorkspace, createWorktreeWorkspace } from '../../factories';

describe('getUnsavedWorkByWorkspace', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        getWorkspaceDiff: vi.fn(async () => ({ files: [] })),
        getWorkspaceGitBranchStatus: vi.fn(async () => ({
          hasRemote: true,
          unpushedCommits: 2,
          aheadTargetBranch: 5,
        })),
      },
    });
    return () => vi.unstubAllGlobals();
  });

  it('counts only the commits a pushed branch has not pushed yet', async () => {
    const worktree = createWorktreeWorkspace({ id: 'ws-worktree' });

    const unsavedWork = await getUnsavedWorkByWorkspace([worktree]);

    expect(unsavedWork.get('ws-worktree')).toEqual({ uncommittedFiles: 0, unpushedCommits: 2 });
  });

  it('does not ask git about a workspace that is not a worktree', async () => {
    const folder = createWorkspace({ id: 'ws-folder', isWorktree: false });

    const unsavedWork = await getUnsavedWorkByWorkspace([folder]);

    expect(unsavedWork.get('ws-folder')).toEqual({ uncommittedFiles: 0, unpushedCommits: 0 });
    expect(window.api.getWorkspaceDiff).not.toHaveBeenCalled();
  });

  it('checks every workspace of a group bigger than one batch', async () => {
    const group = Array.from({ length: 9 }, (_, index) =>
      createWorktreeWorkspace({ id: `ws-${index}` })
    );

    const unsavedWork = await getUnsavedWorkByWorkspace(group);

    expect([...unsavedWork.keys()].sort()).toEqual(group.map((w) => w.id).sort());
  });
});
