/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGitStatusStore } from '../../../src/renderer/stores/git-status.store';
import { useRebaseAbortStore } from '../../../src/renderer/stores/rebase-abort.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import {
  abortWorkspaceRebase,
  addRebaseFailureToast,
} from '../../../src/renderer/utils/rebase-abort';

const workspace = { id: 'ws-1', workingDirectory: '/repo/feature', projectId: 'project-1' };

const branchStatus = {
  behindTargetBranch: 0,
  aheadTargetBranch: 1,
  mainBranch: 'main',
  defaultBranch: 'main',
  hasRemote: false,
  hasOriginRemote: false,
  unpushedCommits: 0,
  behindRemote: 0,
  currentBranch: 'HEAD',
  targetBranchHasRemote: false,
  targetBranchAheadRemote: 0,
  targetBranchBehindRemote: 0,
};

function setStatus(rebaseInProgress: boolean) {
  useGitStatusStore.setState({
    statusMap: new Map([
      [
        workspace.id,
        { status: { ...branchStatus, rebaseInProgress }, lastFetched: 1, isLoading: false },
      ],
    ]),
  });
}

describe('rebase abort helpers', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useRebaseAbortStore.setState({ pending: null });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        abortRebase: vi.fn().mockResolvedValue({
          success: true,
          message: 'Rebase aborted. feature was restored.',
        }),
        getWorkspaceGitBranchStatus: vi
          .fn()
          .mockResolvedValue({ ...branchStatus, rebaseInProgress: false }),
      },
    });
  });

  it('offers to abort a rebase that Git left paused, and still times out', () => {
    setStatus(true);

    addRebaseFailureToast('Rebase onto main paused because a.ts has conflicts.', workspace);

    const [toast] = useToastStore.getState().toasts;
    expect(toast).toMatchObject({
      message: 'Rebase onto main paused because a.ts has conflicts.',
      type: 'error',
      action: { label: 'Abort rebase' },
      dismissOnTimeout: true,
    });
  });

  it('asks for confirmation before the toast aborts anything', () => {
    setStatus(true);
    addRebaseFailureToast('Rebase onto main paused because a.ts has conflicts.', {
      ...workspace,
      name: 'Feature',
    } as typeof workspace);

    useToastStore.getState().toasts[0].action?.onClick();

    expect(useRebaseAbortStore.getState().pending).toEqual(workspace);
    expect(window.api.abortRebase).not.toHaveBeenCalled();
  });

  it('reports other rebase failures without an abort action', () => {
    setStatus(false);

    addRebaseFailureToast('Cannot rebase onto the current branch', workspace);

    expect(useToastStore.getState().toasts[0].action).toBeUndefined();
  });

  it('aborts the rebase quietly and refreshes branch status', async () => {
    setStatus(true);

    await abortWorkspaceRebase(workspace);

    expect(window.api.abortRebase).toHaveBeenCalledWith('/repo/feature');
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledWith('ws-1', 'project-1');
    expect(useGitStatusStore.getState().getStatus(workspace.id)?.status.rebaseInProgress).toBe(
      false
    );
  });

  it('retires the conflict toast once an abort starts', async () => {
    setStatus(true);
    addRebaseFailureToast('Rebase onto main paused because a.ts has conflicts.', workspace);

    await abortWorkspaceRebase(workspace);

    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('ignores a second abort while the first is still running', async () => {
    setStatus(true);

    await Promise.all([abortWorkspaceRebase(workspace), abortWorkspaceRebase(workspace)]);

    expect(window.api.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('reports an abort that Git refuses', async () => {
    vi.mocked(window.api.abortRebase).mockResolvedValue({
      success: false,
      message: 'fatal: No rebase in progress?',
    });

    await abortWorkspaceRebase(workspace);

    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: 'fatal: No rebase in progress?',
      type: 'error',
    });
  });
});
