/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { branchPickerProps, commitComposerProps, requestRebaseAbort, gitState } = vi.hoisted(() => ({
  branchPickerProps: vi.fn(),
  commitComposerProps: vi.fn(),
  requestRebaseAbort: vi.fn(),
  gitState: { rebaseInProgress: false },
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
  useProjectsStore: () => ({ projects: [] }),
}));
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: () => ({
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
  }),
}));
vi.mock('../../../../src/renderer/stores/git-status.store', () => ({
  useGitStatusStore: () => ({
    getStatus: () => ({
      status: {
        behindTargetBranch: 1,
        aheadTargetBranch: 0,
        mainBranch: 'main',
        defaultBranch: 'main',
        hasRemote: true,
        hasOriginRemote: true,
        unpushedCommits: 0,
        behindRemote: 0,
        currentBranch: 'feature',
        targetBranchHasRemote: true,
        targetBranchAheadRemote: 0,
        targetBranchBehindRemote: 0,
        rebaseInProgress: gitState.rebaseInProgress,
      },
    }),
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
  useToastStore: () => ({ addToast: vi.fn() }),
}));
vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: () => ({ config: {}, updateConfig: vi.fn() }),
}));
vi.mock('../../../../src/renderer/stores/project-sync-status.store', () => ({
  useProjectSyncStatusStore: () => ({ getStatus: vi.fn(), refreshStatus: vi.fn() }),
}));
vi.mock('../../../../src/renderer/stores/file-viewer.store', () => ({
  useFileViewerStore: Object.assign(() => ({ requestFileViewerTransition: vi.fn() }), {
    getState: () => ({
      fileViewerWorkspaceId: null,
      setFileViewerDiffComparisonBranch: vi.fn(),
    }),
  }),
}));
vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: Object.assign(() => ({}), { getState: () => ({ actions: [] }) }),
}));

import { UnifiedMenu } from '../../../../src/renderer/components/layout/UnifiedMenu';
import { useGitProgressStore } from '../../../../src/renderer/stores/git-progress.store';

describe('UnifiedMenu commit entry', () => {
  beforeEach(() => {
    commitComposerProps.mockClear();
    rebaseWorkspaceOnBranch.mockClear();
    fetchStatus.mockClear();
    requestRebaseAbort.mockClear();
    gitState.rebaseInProgress = false;
    useGitProgressStore.setState(useGitProgressStore.getInitialState(), true);
    window.api = {
      rebaseWorkspaceOnBranch,
    } as typeof window.api;
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
