/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addToast, branchPickerProps, branchCleanupProps } = vi.hoisted(() => ({
  addToast: vi.fn(),
  branchPickerProps: vi.fn(),
  branchCleanupProps: vi.fn(),
}));

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/CommitComposer', () => ({
  CommitComposer: () => null,
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
vi.mock('../../../../src/renderer/components/projects/BranchCleanupDialog', () => ({
  BranchCleanupDialog: (props: unknown) => {
    branchCleanupProps(props);
    return null;
  },
}));
vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: React.PropsWithChildren<{ disabled?: boolean; onClick?: () => void }>) => (
    <button role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));
vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip">{children}</div>
  ),
}));

const state = {
  projectId: 'project-1' as string | null,
  backend: undefined as object | undefined,
  behindTargetBranch: 0,
  aheadTargetBranch: 0,
  hasOriginRemote: false,
  hasRemote: false,
  unpushedCommits: 0,
};

vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      projects: [{ id: 'project-1', name: 'Project', repositoryPath: '/repo', kind: 'git' }],
    }),
}));
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedWorkspaceId: 'ws',
      workspaces: [
        {
          id: 'ws',
          branchName: 'feature',
          workingDirectory: '/worktrees/feature',
          projectId: state.projectId,
          backend: state.backend,
          isWorktree: true,
        },
      ],
      addTerminal: vi.fn(),
      updateWorkspace: vi.fn(),
    }),
}));
vi.mock('../../../../src/renderer/stores/git-status.store', () => ({
  useGitStatusStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      statusMap: {
        get: () => ({
          status: {
            behindTargetBranch: state.behindTargetBranch,
            aheadTargetBranch: state.aheadTargetBranch,
            mainBranch: 'develop',
            defaultBranch: 'main',
            hasRemote: state.hasRemote,
            hasOriginRemote: state.hasOriginRemote,
            unpushedCommits: state.unpushedCommits,
            behindRemote: 0,
            currentBranch: 'feature',
            targetBranchHasRemote: false,
            targetBranchAheadRemote: 0,
            targetBranchBehindRemote: 0,
          },
        }),
      },
      invalidateStatus: vi.fn(),
      fetchStatus: vi.fn(),
      fetchStatusIfStale: vi.fn(),
    }),
}));
vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ addToast }),
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
    { getState: () => ({ setFileViewerDiffComparisonBranch: vi.fn() }) }
  ),
}));
vi.mock('../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: Object.assign(() => ({}), { getState: () => ({ actions: [] }) }),
}));

import { UnifiedMenu } from '../../../../src/renderer/components/layout/UnifiedMenu';
import { useGitProgressStore } from '../../../../src/renderer/stores/git-progress.store';

type PickerProps = { onFetch: (e?: React.MouseEvent) => Promise<void> };

describe('UnifiedMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGitProgressStore.setState(useGitProgressStore.getInitialState(), true);
    state.projectId = 'project-1';
    state.backend = undefined;
    state.behindTargetBranch = 0;
    state.aheadTargetBranch = 0;
    state.hasOriginRemote = false;
    state.hasRemote = false;
    state.unpushedCommits = 0;
    window.api = {
      fetchProject: vi.fn().mockResolvedValue({ success: true, message: 'Fetched' }),
      fetchFromRemote: vi.fn().mockResolvedValue({ success: true, message: 'Fetched' }),
      listWorkspaceBranches: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.api;
  });

  it('marks the branch button as a menu with a caret and a tooltip', () => {
    render(<UnifiedMenu />);

    expect(screen.getByText('Branch actions')).toBeInTheDocument();
    const trigger = screen.getAllByTitle('feature')[0].closest('button');
    expect(trigger?.querySelectorAll('svg')).toHaveLength(2);
  });

  it("says the branch's cloud count is commits origin doesn't have", () => {
    state.hasOriginRemote = true;
    state.hasRemote = true;
    state.unpushedCommits = 2;
    state.aheadTargetBranch = 5;
    render(<UnifiedMenu />);

    expect(screen.getByTestId('tooltip')).toHaveTextContent(
      'Branch actions 2 commits not pushed to origin'
    );
  });

  it('shows unpushed commits as a cloud count, keeping ↑N for ahead of target', () => {
    state.hasOriginRemote = true;
    state.hasRemote = true;
    state.unpushedCommits = 2;
    state.aheadTargetBranch = 5;
    render(<UnifiedMenu />);

    const trigger = screen.getAllByTitle('feature')[0].closest('button')!;
    expect(trigger).toHaveTextContent('2 not pushed');
    expect(trigger).not.toHaveTextContent('↑');
  });

  it('shows no cloud count for a branch not yet published to origin', () => {
    state.hasOriginRemote = true;
    state.aheadTargetBranch = 2;
    render(<UnifiedMenu />);

    const trigger = screen.getAllByTitle('feature')[0].closest('button')!;
    expect(trigger).not.toHaveTextContent('not pushed');
    expect(screen.getByTestId('tooltip')).not.toHaveTextContent('not pushed to origin');
  });

  it('tells what a running operation is doing in the tooltip', () => {
    useGitProgressStore.getState().startOperation('fetch-1', 'fetch', '/worktrees/feature');
    useGitProgressStore.getState().updateProgress('/worktrees/feature', 45, 'Receiving objects');
    render(<UnifiedMenu />);

    expect(screen.getByTestId('tooltip')).toHaveTextContent('Fetching…Receiving objects 45%');
    expect(screen.queryByText('Branch actions')).not.toBeInTheDocument();
  });

  it('explains why Fast-forward target is disabled while the branch is behind', () => {
    state.aheadTargetBranch = 2;
    state.behindTargetBranch = 3;
    render(<UnifiedMenu />);

    const mergeItem = screen.getByRole('menuitem', { name: /Fast-forward develop/ });
    expect(mergeItem).toBeDisabled();
    expect(mergeItem).toHaveTextContent('Update from develop first (↓3)');
  });

  it('does not show the reason when Fast-forward target is available', () => {
    state.aheadTargetBranch = 2;
    render(<UnifiedMenu />);

    const mergeItem = screen.getByRole('menuitem', { name: /Fast-forward develop/ });
    expect(mergeItem).toBeEnabled();
    expect(mergeItem).not.toHaveTextContent('first');
  });

  it('reports a failed fetch for a workspace without a project', async () => {
    state.projectId = null;
    vi.mocked(window.api.fetchFromRemote).mockResolvedValue({
      success: false,
      message: 'Could not reach origin',
    });
    render(<UnifiedMenu />);

    await (branchPickerProps.mock.lastCall![0] as PickerProps).onFetch();

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Could not reach origin', 'error'));
  });

  it('reports a fetch that throws', async () => {
    vi.mocked(window.api.fetchProject).mockRejectedValue(new Error('Network down'));
    render(<UnifiedMenu />);

    await (branchPickerProps.mock.lastCall![0] as PickerProps).onFetch();

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Network down'), 'error')
    );
  });

  it("opens the project's branch cleanup from the project section", () => {
    render(<UnifiedMenu />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Clean up branches…' }));

    expect(branchCleanupProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'project-1', hostId: null, open: true })
    );
  });

  it("opens branch cleanup for the host's clone in an SSH workspace", () => {
    state.backend = { kind: 'ssh', hostId: 'host-1', remoteDirectory: '/repo' };
    render(<UnifiedMenu />);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Clean up branches…' }));

    expect(branchCleanupProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'project-1', hostId: 'host-1', open: true })
    );
  });
});
