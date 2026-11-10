/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { branchPickerProps, commitComposerProps, requestRebaseAbort, addToast, gitState } =
  vi.hoisted(() => ({
    branchPickerProps: vi.fn(),
    commitComposerProps: vi.fn(),
    requestRebaseAbort: vi.fn(),
    addToast: vi.fn(),
    gitState: { rebaseInProgress: false, behindRemote: 0, hasOriginRemote: true },
  }));
const rebaseWorkspaceOnBranch = vi.fn().mockResolvedValue({
  success: true,
  message: 'Rebased on main successfully',
});
const fetchStatus = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/CommitComposer', () => ({
  CommitComposer: (props: unknown) => {
    commitComposerProps(props);
    return null;
  },
}));
vi.mock('../../../../src/renderer/components/layout/BranchActionPicker', () => ({
  BranchActionPicker: (props: unknown) => {
    branchPickerProps(props);
    return null;
  },
}));
vi.mock('../../../../src/renderer/components/layout/PublishRepoDialog', () => ({
  PublishRepoDialog: () => null,
}));
vi.mock('../../../../src/renderer/components/ui/dropdown-menu', async () => {
  const React = await import('react');
  const Container = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement('div', props, children);
  const Item = ({
    children,
    onClick,
    onSelect,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { onSelect?: () => void }) =>
    React.createElement(
      'button',
      {
        ...props,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          onClick?.(event);
          onSelect?.();
        },
      },
      children
    );
  return {
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuItem: Item,
    DropdownMenuLabel: Container,
    DropdownMenuSeparator: () => React.createElement('hr'),
    DropdownMenuTrigger: Container,
  };
});

vi.mock('../../../../src/renderer/components/ui/tooltip', async () => {
  const React = await import('react');
  const Passthrough = ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children);
  return {
    Tooltip: Passthrough,
    TooltipTrigger: Passthrough,
    TooltipContent: () => null,
  };
});

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ projects: [] }),
}));
vi.mock('../../../../src/renderer/stores/workspaces.store', async () => {
  const { create } = await vi.importActual<typeof import('zustand')>('zustand');
  return {
    useWorkspacesStore: create(() => ({
      selectedWorkspaceId: 'ws',
      workspaces: [
        {
          id: 'ws',
          branchName: 'feature',
          workingDirectory: '/repo',
          backend: {
            kind: 'ssh',
            hostId: 'host-1',
            remoteDirectory: '/repo',
            remoteRepoPath: '/repo.git',
            remoteProjectRoot: '/repo',
            gitUrl: 'git@example.com:repo.git',
            baseBranch: 'trunk',
          },
          projectId: null,
          isWorktree: true,
        },
      ],
      addTerminal: vi.fn(),
    })),
  };
});
vi.mock('../../../../src/renderer/stores/git-status.store', () => ({
  useGitStatusStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      statusMap: {
        get: () => ({
          status: {
            behindTargetBranch: 1,
            aheadTargetBranch: 0,
            mainBranch: 'main',
            defaultBranch: 'main',
            hasRemote: true,
            hasOriginRemote: gitState.hasOriginRemote,
            unpushedCommits: 0,
            behindRemote: gitState.behindRemote,
            currentBranch: 'feature',
            targetBranchHasRemote: true,
            targetBranchAheadRemote: 0,
            targetBranchBehindRemote: 0,
            rebaseInProgress: gitState.rebaseInProgress,
          },
        }),
      },
      invalidateStatus: vi.fn(),
      fetchStatus,
      fetchStatusIfStale: vi.fn(),
    }),
}));
vi.mock('../../../../src/renderer/utils/rebase-abort', () => ({
  requestRebaseAbort,
  addRebaseFailureToast: vi.fn(),
}));
vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ addToast }),
}));
vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ config: {}, updateConfig: vi.fn() }),
}));
vi.mock('../../../../src/renderer/stores/project-sync-status.store', () => ({
  useProjectSyncStatusStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ statuses: new Map(), refreshStatus: vi.fn() }),
}));
vi.mock('../../../../src/renderer/stores/file-viewer.store', () => ({
  useFileViewerStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ requestFileViewerTransition: vi.fn() }),
    {
      getState: () => ({
        fileViewerWorkspaceId: null,
        setFileViewerDiffComparisonBranch: vi.fn(),
      }),
    }
  ),
}));
vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: Object.assign(() => ({}), { getState: () => ({ actions: [] }) }),
}));

import { UnifiedMenu } from '../../../../src/renderer/components/layout/UnifiedMenu';
import { useGitProgressStore } from '../../../../src/renderer/stores/git-progress.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { addRebaseFailureToast } from '../../../../src/renderer/utils/rebase-abort';

const initialWorkspacesState = useWorkspacesStore.getState();

describe('UnifiedMenu commit entry', () => {
  beforeEach(() => {
    commitComposerProps.mockClear();
    rebaseWorkspaceOnBranch.mockClear();
    fetchStatus.mockClear();
    requestRebaseAbort.mockClear();
    addToast.mockClear();
    gitState.rebaseInProgress = false;
    gitState.behindRemote = 0;
    gitState.hasOriginRemote = true;
    useGitProgressStore.setState(useGitProgressStore.getInitialState(), true);
    useWorkspacesStore.setState(initialWorkspacesState, true);
    window.api = {
      rebaseWorkspaceOnBranch,
    } as typeof window.api;
  });

  // Agents update their workspaces all the time; the menu shows only the active one.
  it('does not re-render when another workspace changes', () => {
    let renders = 0;
    render(
      <Profiler id="menu" onRender={() => (renders += 1)}>
        <UnifiedMenu />
      </Profiler>
    );
    const settledRenders = renders;

    act(() => {
      useWorkspacesStore.setState((state) => ({
        workspaces: [...state.workspaces, { id: 'other', branchName: 'other', terminals: [] }],
      }));
    });

    expect(renders).toBe(settledRenders);
  });

  it('opens the commit composer from the Git dropdown', async () => {
    const user = userEvent.setup();
    render(<UnifiedMenu />);

    expect(commitComposerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: 'ws',
        workingDirectory: '/repo',
        open: false,
        showTrigger: false,
      })
    );

    await user.click(screen.getByRole('button', { name: 'Commit changes…' }));

    expect(commitComposerProps).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
  });

  it('truncates the current branch label and exposes its full name on hover', () => {
    render(<UnifiedMenu />);

    const branchLabel = screen
      .getAllByTitle('feature')
      .find((element) => element.classList.contains('min-w-0'));

    expect(branchLabel).toHaveClass('flex-1', 'truncate');
    expect(branchLabel?.parentElement?.querySelector('svg')).toHaveClass('shrink-0');
  });

  it('uses the SSH backend target when status still reports a fallback', async () => {
    const user = userEvent.setup();
    render(<UnifiedMenu />);

    await user.click(screen.getByRole('button', { name: /rebase on trunk/i }));

    await waitFor(() => {
      expect(rebaseWorkspaceOnBranch).toHaveBeenCalledWith('ws', 'trunk', undefined);
    });
  });

  it('creates and switches to a branch on the SSH host', async () => {
    const createWorkspaceBranch = vi.fn().mockResolvedValue(undefined);
    const switchWorkspaceBranch = vi.fn().mockResolvedValue({ success: true, message: '' });
    const listWorkspaceBranches = vi.fn().mockResolvedValue([]);
    window.api = {
      createWorkspaceBranch,
      switchWorkspaceBranch,
      listWorkspaceBranches,
    } as unknown as typeof window.api;
    render(<UnifiedMenu />);

    const { onCreate } = branchPickerProps.mock.lastCall![0] as {
      onCreate: (branchName: string) => Promise<void>;
    };
    await act(() => onCreate('topic'));

    expect(createWorkspaceBranch).toHaveBeenCalledWith('ws', 'topic');
    expect(switchWorkspaceBranch).toHaveBeenCalledWith('ws', 'topic');
  });

  it('marks a paused rebase on the branch button and offers to abort it', async () => {
    gitState.rebaseInProgress = true;
    const user = userEvent.setup();
    render(<UnifiedMenu />);

    expect(screen.getByText('rebasing')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /abort rebase/i }));

    expect(requestRebaseAbort).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws' }));
  });

  it('holds back sync and target-branch actions while a rebase is paused', () => {
    gitState.rebaseInProgress = true;
    render(<UnifiedMenu />);

    expect(screen.queryByRole('button', { name: /rebase on trunk/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /merge trunk/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^push$/i })).not.toBeInTheDocument();
  });

  it('does not offer to abort when no rebase is paused', () => {
    render(<UnifiedMenu />);

    expect(screen.queryByText('rebasing')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /abort rebase/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rebase on trunk/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /merge trunk/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^push$/i })).toBeInTheDocument();
  });

  it('shows a running operation in the branch button, leaving the menu unchanged', () => {
    const { container } = render(<UnifiedMenu />);
    const menuText = () => {
      const trigger = screen.getAllByTitle('feature')[0].closest('button')!;
      return container.textContent!.replace(trigger.textContent!, '');
    };
    const before = menuText();

    act(() => useGitProgressStore.getState().startOperation('push-1', 'push', '/repo'));

    const trigger = container.querySelector('[aria-busy="true"]')!;
    expect(trigger).toHaveTextContent('Pushing…');
    // The branch stays in place, hidden, so the button keeps its width.
    expect(screen.getAllByTitle('feature')[0].parentElement).toHaveClass('invisible');
    expect(menuText()).toBe(before);
  });

  it('ignores operations running in other workspaces', () => {
    useGitProgressStore.getState().startOperation('push-1', 'push', '/other');
    const { container } = render(<UnifiedMenu />);

    expect(container.querySelector('[aria-busy]')).not.toBeInTheDocument();
  });
});

describe('UnifiedMenu Pull', () => {
  beforeEach(() => {
    commitComposerProps.mockClear();
    rebaseWorkspaceOnBranch.mockClear();
    fetchStatus.mockClear();
    requestRebaseAbort.mockClear();
    addToast.mockClear();
    gitState.rebaseInProgress = false;
    gitState.behindRemote = 0;
    gitState.hasOriginRemote = true;
    useGitProgressStore.setState(useGitProgressStore.getInitialState(), true);
    useWorkspacesStore.setState(initialWorkspacesState, true);
    window.api = {
      rebaseWorkspaceOnBranch,
    } as typeof window.api;
  });

  // Pull fetches first, so it needs no separate Fetch to reveal it.
  it('offers Pull before a fetch has found new commits, and reports when nothing came in', async () => {
    const pullWorkspace = vi
      .fn()
      .mockResolvedValue({ success: true, message: 'Already up to date' });
    window.api = { pullWorkspace } as unknown as typeof window.api;
    const user = userEvent.setup();
    render(<UnifiedMenu />);

    const pull = screen.getByRole('button', { name: /^pull$/i });
    expect(pull).not.toHaveTextContent('↓');

    await user.click(pull);

    await waitFor(() => expect(pullWorkspace).toHaveBeenCalledWith('ws'));
    expect(addToast).toHaveBeenCalledWith('Already up to date', 'success');
  });

  it('shows how far behind origin the branch is on Pull', () => {
    gitState.behindRemote = 3;
    render(<UnifiedMenu />);

    expect(screen.getByRole('button', { name: /^pull/i })).toHaveTextContent('↓3');
  });

  it('holds back Pull while a rebase is paused', () => {
    gitState.rebaseInProgress = true;
    render(<UnifiedMenu />);

    expect(screen.queryByRole('button', { name: /^pull/i })).not.toBeInTheDocument();
  });

  // A branch tracking a remote other than origin offers Pull but not Push.
  it('keeps Pull in its own group when the branch tracks a remote other than origin', () => {
    gitState.hasOriginRemote = false;
    render(<UnifiedMenu />);

    const pull = screen.getByRole('button', { name: /^pull$/i });
    expect(screen.queryByRole('button', { name: /^push$/i })).not.toBeInTheDocument();
    expect(pull.nextElementSibling?.tagName).toBe('HR');
  });
});

// The menu reads how an operation ended from its result, never from the message's wording.
describe('UnifiedMenu operation outcomes', () => {
  beforeEach(() => {
    rebaseWorkspaceOnBranch.mockClear();
    branchPickerProps.mockClear();
    addToast.mockClear();
    vi.mocked(addRebaseFailureToast).mockClear();
    gitState.rebaseInProgress = false;
    gitState.behindRemote = 0;
    gitState.hasOriginRemote = true;
    useGitProgressStore.setState(useGitProgressStore.getInitialState(), true);
    useWorkspacesStore.setState(initialWorkspacesState, true);
    window.api = { rebaseWorkspaceOnBranch } as typeof window.api;
  });

  it('offers to stash and retry a rebase that uncommitted changes blocked', async () => {
    rebaseWorkspaceOnBranch.mockResolvedValueOnce({
      success: false,
      message: 'Blocked',
      outcome: { kind: 'uncommitted-changes' },
    });
    const user = userEvent.setup();
    render(<UnifiedMenu />);

    await user.click(screen.getByRole('button', { name: /rebase on trunk/i }));

    expect(await screen.findByText(/this branch has uncommitted changes/i)).toBeInTheDocument();
    expect(addRebaseFailureToast).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /stash, rebase & unstash/i }));

    await waitFor(() => {
      expect(rebaseWorkspaceOnBranch).toHaveBeenLastCalledWith('ws', 'trunk', { stash: true });
    });
  });

  it('reports a rebase that failed, however its message begins', async () => {
    rebaseWorkspaceOnBranch.mockResolvedValueOnce({
      success: false,
      message: 'Commit or stash changes before rebasing',
      outcome: { kind: 'failed' },
    });
    const user = userEvent.setup();
    render(<UnifiedMenu />);

    await user.click(screen.getByRole('button', { name: /rebase on trunk/i }));

    await waitFor(() => {
      expect(addRebaseFailureToast).toHaveBeenCalledWith(
        'Commit or stash changes before rebasing',
        expect.objectContaining({ id: 'ws' })
      );
    });
    expect(screen.queryByText(/this branch has uncommitted changes/i)).not.toBeInTheDocument();
  });

  it('asks before deleting a branch Git reports as not fully merged', async () => {
    const deleteBranch = vi.fn().mockResolvedValue({
      success: false,
      message: 'Unmerged',
      errorCode: 'not-fully-merged',
    });
    window.api = { deleteBranch } as unknown as typeof window.api;
    render(<UnifiedMenu />);

    const { onDelete } = branchPickerProps.mock.lastCall![0] as {
      onDelete: (branchName: string, isRemote: boolean) => Promise<void>;
    };
    await act(() => onDelete('topic', false));

    expect(deleteBranch).toHaveBeenCalledWith('/repo', 'topic', false);
    expect(await screen.findByText('Delete Unmerged Branch')).toBeInTheDocument();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('reports a branch deletion that failed for another reason', async () => {
    const deleteBranch = vi.fn().mockResolvedValue({
      success: false,
      message: 'error: branch topic is not fully merged, and is locked',
    });
    window.api = { deleteBranch } as unknown as typeof window.api;
    render(<UnifiedMenu />);

    const { onDelete } = branchPickerProps.mock.lastCall![0] as {
      onDelete: (branchName: string, isRemote: boolean) => Promise<void>;
    };
    await act(() => onDelete('topic', false));

    expect(addToast).toHaveBeenCalledWith(
      'error: branch topic is not fully merged, and is locked',
      'error'
    );
    expect(screen.queryByText('Delete Unmerged Branch')).not.toBeInTheDocument();
  });
});
