/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addToast, fetchStatus, invalidateStatus, refreshProjectSyncStatus, updateProject } =
  vi.hoisted(() => ({
    addToast: vi.fn(),
    updateProject: vi.fn(),
    fetchStatus: vi.fn(),
    invalidateStatus: vi.fn(),
    refreshProjectSyncStatus: vi.fn(),
  }));

vi.mock('../../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: React.PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => (
    <div>
      <button onClick={() => onOpenChange?.(true)}>open menu</button>
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: React.PropsWithChildren<{ onClick?: () => void }>) => (
    <button role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
}));
vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('../../../../src/renderer/components/layout/PublishRepoDialog', () => ({
  PublishRepoDialog: () => null,
}));

const workspacesState = {
  selectedWorkspaceId: 'ws-1',
  workspaces: [
    {
      id: 'ws-1',
      projectId: 'project-1',
      workingDirectory: '/worktrees/feature',
      branchName: 'feature',
      isWorktree: true,
      baseBranch: undefined as string | undefined,
      backend: undefined as object | undefined,
    },
  ],
  updateWorkspace: vi.fn(),
};
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: Object.assign(
    (selector: (state: typeof workspacesState) => unknown) => selector(workspacesState),
    { getState: () => workspacesState }
  ),
}));
vi.mock('../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      projects: [{ id: 'project-1', name: 'Project', repositoryPath: '/repo', kind: 'git' }],
      updateProject,
    }),
}));
vi.mock('../../../../src/renderer/stores/git-status.store', () => ({
  useGitStatusStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      statusMap: {
        get: () => ({
          status: {
            behindTargetBranch: 0,
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
          },
        }),
      },
      invalidateStatus,
      fetchStatus,
      fetchStatusIfStale: vi.fn(),
    }),
}));
const projectSync = vi.hoisted(() => ({
  status: undefined as { aheadRemote: number; behindRemote: number; hasRemote: boolean } | undefined,
}));
vi.mock('../../../../src/renderer/stores/project-sync-status.store', () => ({
  useProjectSyncStatusStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      statuses: { get: () => projectSync.status },
      refreshStatus: refreshProjectSyncStatus,
    }),
}));
vi.mock('../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ config: { remoteBranchesExpanded: false }, updateConfig: vi.fn() }),
}));
vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: typeof addToast }) => unknown) =>
    selector({ addToast }),
}));
vi.mock('../../../../src/renderer/stores/git-progress.store', () => ({
  useGitProgressStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ startOperation: vi.fn(), endOperation: vi.fn() }),
}));

import { TargetBranchSelector } from '../../../../src/renderer/components/layout/TargetBranchSelector';

const fetchProject = vi.fn();
const listBranches = vi.fn();

async function openMenu(): Promise<void> {
  render(<TargetBranchSelector />);
  fireEvent.click(screen.getByRole('button', { name: 'open menu' }));
  await screen.findByTitle('Fetch from remote');
}

describe('TargetBranchSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectSync.status = undefined;
    workspacesState.workspaces[0].baseBranch = undefined;
    workspacesState.workspaces[0].backend = undefined;
    fetchProject.mockResolvedValue({ success: true, message: 'Fetched' });
    listBranches.mockResolvedValue([
      { name: 'main', isRemoteOnly: false },
      { name: 'develop', isRemoteOnly: false },
      { name: 'feature', isRemoteOnly: false },
    ]);
    window.api = { fetchProject, listBranches } as unknown as typeof window.api;
  });

  it('labels the selected branch as the target, not the current branch', async () => {
    await openMenu();

    const mainRow = screen
      .getAllByRole('menuitem')
      .find((item) => item.textContent?.startsWith('main'));
    expect(mainRow).toBeDefined();
    expect(within(mainRow!).getByText('target')).toBeInTheDocument();
    expect(within(mainRow!).queryByText('current')).toBeNull();
  });

  it('labels the checked-out branch distinctly from the target', async () => {
    await openMenu();

    const featureRow = screen
      .getAllByRole('menuitem')
      .find((item) => item.textContent?.startsWith('feature'));
    expect(within(featureRow!).getByText('checked out')).toBeInTheDocument();
    expect(within(featureRow!).queryByText('target')).toBeNull();
  });

  it('offers only Pull, not a duplicate Sync, when the target is just behind its remote', async () => {
    projectSync.status = { aheadRemote: 0, behindRemote: 2, hasRemote: true };
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /Pull/ })).toHaveTextContent('↓2');
    expect(screen.queryByRole('menuitem', { name: /Sync/ })).toBeNull();
  });

  it('shows target commits origin lacks as a cloud count, not ↑N', async () => {
    projectSync.status = { aheadRemote: 2, behindRemote: 0, hasRemote: true };
    await openMenu();

    const trigger = screen.getByTitle('main').closest('button')!;
    expect(trigger).toHaveTextContent('2 not pushed');
    expect(trigger).not.toHaveTextContent('↑');
    expect(screen.getByRole('menuitem', { name: /Push/ })).not.toHaveTextContent('↑');
  });

  it('keeps Sync when the target is up to date with its remote', async () => {
    projectSync.status = { aheadRemote: 0, behindRemote: 0, hasRemote: true };
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /Sync/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Pull/ })).toBeNull();
  });

  it('keeps Sync next to Merge remote when the target has diverged', async () => {
    projectSync.status = { aheadRemote: 1, behindRemote: 2, hasRemote: true };
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /Sync/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Merge remote/ })).toBeInTheDocument();
  });

  it('refreshes sync and git status after fetching so ahead/behind counts update', async () => {
    await openMenu();

    fireEvent.click(screen.getByTitle('Fetch from remote'));

    await waitFor(() => {
      expect(refreshProjectSyncStatus).toHaveBeenCalledWith('project-1', true);
      expect(fetchStatus).toHaveBeenCalledWith('ws-1', '/worktrees/feature', 'project-1');
    });
    expect(invalidateStatus).toHaveBeenCalledWith('ws-1');
    expect(addToast).not.toHaveBeenCalled();
  });

  it('reports a failed fetch instead of silently dropping it', async () => {
    fetchProject.mockResolvedValue({ success: false, message: 'Could not reach origin' });
    await openMenu();

    fireEvent.click(screen.getByTitle('Fetch from remote'));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Could not reach origin', 'error'));
    expect(refreshProjectSyncStatus).not.toHaveBeenCalled();
  });

  for (const ssh of [false, true]) {
    it(`creates a new target branch ${ssh ? 'on the SSH host' : 'locally'}, starting from the current target`, async () => {
      if (ssh) {
        workspacesState.workspaces[0].backend = {
          kind: 'ssh',
          hostId: 'host-1',
          remoteDirectory: '/home/dev/feature',
        };
      }
      const createWorkspaceBranch = vi.fn().mockResolvedValue(undefined);
      const branches = vi.fn().mockResolvedValue([{ name: 'main', isRemoteOnly: false }]);
      const updateWorkspace = vi.fn().mockResolvedValue(undefined);
      window.api = {
        createWorkspaceBranch,
        listBranches: branches,
        listWorkspaceBranches: branches,
        updateWorkspace,
      } as unknown as typeof window.api;
      render(<TargetBranchSelector />);
      fireEvent.click(screen.getByRole('button', { name: 'open menu' }));
      await waitFor(() => expect(branches).toHaveBeenCalled());

      fireEvent.change(screen.getByPlaceholderText('Filter or create branch...'), {
        target: { value: 'release' },
      });
      fireEvent.click(screen.getByRole('menuitem', { name: /Create release/ }));

      await waitFor(() =>
        expect(updateWorkspace).toHaveBeenCalledWith('ws-1', { baseBranch: 'release' })
      );
      expect(createWorkspaceBranch).toHaveBeenCalledWith('ws-1', 'release', 'main');
      expect(addToast).not.toHaveBeenCalled();
    });
  }

  it("makes a row the project's target from its star, leaving this workspace's target alone", async () => {
    const updateWorkspace = vi.fn();
    window.api = { ...window.api, updateWorkspace } as unknown as typeof window.api;
    await openMenu();

    const row = (name: string) =>
      screen.getAllByRole('menuitem').find((item) => item.textContent?.startsWith(name))!;
    // The star alone marks the project's target, so the row doesn't read "target project".
    expect(within(row('main')).queryByText('project')).toBeNull();
    expect(
      within(row('main')).getByLabelText("main is the project's target branch")
    ).toBeInTheDocument();
    expect(within(row('main')).queryByRole('button')).toBeNull();
    // The star says what it changes.
    expect(
      within(row('develop')).getByText(/Workspaces without a target of their own follow it/)
    ).toBeInTheDocument();
    // Its own checked-out branch is no target for the project.
    expect(within(row('feature')).queryByRole('button')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: "Make develop the project's target branch" })
    );

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith('project-1', { baseBranch: 'develop' })
    );
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith("Set develop as the project's target branch", 'success');
  });

  it('returns an SSH workspace to the branch it was created from, not the remote default', async () => {
    workspacesState.workspaces[0].baseBranch = 'release';
    workspacesState.workspaces[0].backend = {
      kind: 'ssh',
      hostId: 'host-1',
      remoteDirectory: '/home/dev/feature',
      baseBranch: 'develop',
      defaultBranch: 'main',
    };
    const listWorkspaceBranches = vi.fn().mockResolvedValue([
      { name: 'main', isRemoteOnly: false },
      { name: 'develop', isRemoteOnly: false },
      { name: 'release', isRemoteOnly: false },
    ]);
    const updateWorkspace = vi.fn().mockResolvedValue(undefined);
    window.api = { listWorkspaceBranches, updateWorkspace } as unknown as typeof window.api;
    render(<TargetBranchSelector />);
    fireEvent.click(screen.getByRole('button', { name: 'open menu' }));
    await waitFor(() => expect(listWorkspaceBranches).toHaveBeenCalled());

    expect(screen.getByText('Use default (develop)')).toBeInTheDocument();

    const mainRow = await waitFor(() =>
      screen.getAllByRole('menuitem').find((item) => item.textContent?.startsWith('main'))!
    );
    fireEvent.click(mainRow);

    await waitFor(() =>
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', { baseBranch: 'main' })
    );
  });

  it('reports a fetch that throws', async () => {
    fetchProject.mockRejectedValue(new Error('Network down'));
    await openMenu();

    fireEvent.click(screen.getByTitle('Fetch from remote'));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining('Network down'), 'error')
    );
  });
});
