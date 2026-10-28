/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { GitStatusIndicator } from '../../../../src/renderer/components/workspaces/GitStatusIndicator';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useActionsStore } from '../../../../src/renderer/stores/actions.store';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useFileListStore } from '../../../../src/renderer/stores/file-list.store';
import { useGitStatusStore } from '../../../../src/renderer/stores/git-status.store';
import { useLayoutStore } from '../../../../src/renderer/stores/layout.store';
import { useProjectsStore } from '../../../../src/renderer/stores/projects.store';
import { useRebaseAbortStore } from '../../../../src/renderer/stores/rebase-abort.store';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';
import { useWorkspaceObservationStore } from '../../../../src/renderer/stores/workspace-observation.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createProject, createTerminal, createWorkspace } from '../../../factories';

const workspace = createWorkspace({
  id: 'ssh-workspace',
  projectId: 'project-1',
  workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/komla/feature',
  branchName: 'feature/card-actions',
  backend: {
    kind: 'ssh',
    hostId: 'ssh-dev',
    remoteDirectory: '/home/dev/.komla/worktrees/komla/feature',
    remoteRepoPath: '/home/dev/.komla/repos/komla/repo.git',
    remoteProjectRoot: '/home/dev/.komla/worktrees/komla',
    gitUrl: 'git@github.com:example/komla.git',
    branchName: 'feature/card-actions',
    baseBranch: 'main',
  },
});

const project = createProject({
  id: 'project-1',
  aheadTargetAction: 'merge',
  behindTargetAction: 'rebase',
  autoPushAfterMerge: false,
});

const { addTerminalCommand: realAddTerminalCommand } = useWorkspacesStore.getState();

const branchStatus = {
  behindTargetBranch: 2,
  aheadTargetBranch: 3,
  mainBranch: 'main',
  defaultBranch: 'main',
  hasRemote: true,
  hasOriginRemote: true,
  unpushedCommits: 0,
  behindRemote: 0,
  currentBranch: 'feature/card-actions',
  targetBranchHasRemote: true,
  targetBranchAheadRemote: 0,
  targetBranchBehindRemote: 0,
};

function renderIndicator(indicatorWorkspace = workspace) {
  return render(
    <TooltipProvider>
      <GitStatusIndicator
        workspaceId={indicatorWorkspace.id}
        workingDirectory={indicatorWorkspace.workingDirectory}
        projectId={indicatorWorkspace.projectId}
      />
    </TooltipProvider>
  );
}

describe('GitStatusIndicator SSH actions', () => {
  beforeEach(() => {
    const api = {
      getWorkspaceDiff: vi.fn().mockResolvedValue({
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      }),
      getWorkspaceGitBranchStatus: vi.fn().mockResolvedValue(branchStatus),
      rebaseWorkspaceOnBranch: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'Rebased remotely' }),
      mergeWorkspaceFrom: vi.fn().mockResolvedValue({ success: true, message: 'Merged remotely' }),
      mergeWorkspaceToTargetBranch: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'Fast-forwarded main remotely' }),
      pushWorkspaceTargetBranch: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'Pushed target remotely' }),
      pullWorkspaceTargetBranch: vi
        .fn()
        .mockResolvedValue({ success: true, message: 'Pulled target remotely' }),
      pushWorkspace: vi.fn().mockResolvedValue({ success: true, message: 'Published remotely' }),
      openExternal: vi.fn().mockResolvedValue(undefined),
      getChangedFilesWithSummary: vi.fn(),
      rebaseOnTargetBranch: vi.fn(),
      mergeFrom: vi.fn(),
      mergeToTargetBranch: vi.fn(),
      push: vi.fn(),
      getCreatePrUrl: vi.fn(),
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });

    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });
    useProjectsStore.setState({ projects: [project] });
    useGitStatusStore.setState({
      statusMap: new Map([
        [workspace.id, { status: branchStatus, lastFetched: Date.now(), isLoading: false }],
      ]),
    });
    useFileListStore.setState({
      statusCache: new Map(),
      diffCache: new Map(),
      fileDiffCache: new Map(),
    });
    useWorkspaceObservationStore.setState({ projections: new Map() });
  });

  afterEach(() => {
    useWorkspacesStore.setState({ addTerminalCommand: realAddTerminalCommand });
    useActionsStore.setState({ actions: [] });
  });

  // Every sidebar card and Overview row has an indicator, so each would re-render.
  it("does not re-render for another workspace's status", async () => {
    let renders = 0;
    render(
      <Profiler id="indicator" onRender={() => renders++}>
        <TooltipProvider>
          <GitStatusIndicator
            workspaceId={workspace.id}
            workingDirectory={workspace.workingDirectory}
            projectId={workspace.projectId}
          />
        </TooltipProvider>
      </Profiler>
    );
    await act(async () => {});
    const rendersBefore = renders;

    act(() => useGitStatusStore.getState().hydrateStatus('other-workspace', branchStatus));

    expect(renders).toBe(rendersBefore);
  });

  it('describes stale aggregate state as remote workspace status', () => {
    useWorkspaceObservationStore.setState({
      projections: new Map([
        [
          workspace.id,
          {
            workspaceId: workspace.id,
            revision: 1,
            repositoryRevision: 1,
            workingTree: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
            branch: {
              currentBranch: branchStatus.currentBranch,
              targetBranch: branchStatus.mainBranch,
              aheadTargetBranch: branchStatus.aheadTargetBranch,
              behindTargetBranch: branchStatus.behindTargetBranch,
              hasRemote: branchStatus.hasRemote,
              hasOriginRemote: branchStatus.hasOriginRemote,
              unpushedCommits: branchStatus.unpushedCommits,
              behindRemote: branchStatus.behindRemote,
              targetBranchHasRemote: branchStatus.targetBranchHasRemote,
              targetBranchAheadRemote: branchStatus.targetBranchAheadRemote,
              targetBranchBehindRemote: branchStatus.targetBranchBehindRemote,
            },
            confirmation: {
              kind: 'stale',
              staleSince: 2,
              lastConfirmedAt: 1,
              reason: 'source-unreachable',
            },
          },
        ],
      ]),
    });

    renderIndicator();

    expect(
      screen.getByTitle(
        'Remote workspace status may be stale; waiting for the companion to reconnect'
      )
    ).toBeInTheDocument();
  });

  it('marks restored SSH status stale until the first companion confirmation', () => {
    renderIndicator();

    expect(
      screen.getByTitle(
        'Remote workspace status may be stale; waiting for the companion to reconnect'
      )
    ).toBeInTheDocument();
  });

  it('does not connect for an unselected restored SSH workspace', async () => {
    useWorkspacesStore.setState({ selectedWorkspaceId: null });

    renderIndicator();

    await Promise.resolve();
    expect(window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();
    expect(window.api.getWorkspaceDiff).not.toHaveBeenCalled();
  });

  it('defers remote Git metadata until terminal reconnection finishes', async () => {
    useWorkspacesStore.setState({ reconnectingSshWorkspaceIds: new Set([workspace.id]) });
    useGitStatusStore.setState({ statusMap: new Map() });

    renderIndicator();

    await Promise.resolve();
    expect(window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();
    expect(window.api.getWorkspaceDiff).not.toHaveBeenCalled();

    act(() => {
      useWorkspacesStore.setState({ reconnectingSshWorkspaceIds: new Set() });
    });

    await waitFor(() => {
      expect(window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledWith(
        workspace.id,
        workspace.projectId
      );
      expect(window.api.getWorkspaceDiff).toHaveBeenCalledWith(workspace.id);
    });
  });

  it('loads the remote diff summary and routes rebase by workspace id', async () => {
    renderIndicator();

    await waitFor(() => expect(window.api.getWorkspaceDiff).toHaveBeenCalledWith(workspace.id));
    expect(window.api.getChangedFilesWithSummary).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '↓2' }));
    await waitFor(() =>
      expect(window.api.rebaseWorkspaceOnBranch).toHaveBeenCalledWith(workspace.id, 'main', {
        stash: true,
      })
    );
    expect(window.api.rebaseOnTargetBranch).not.toHaveBeenCalled();
  });

  it.each(['rebase', 'merge'] as const)(
    'waits for watcher status after successful local %s but refreshes on failure',
    async (action) => {
      const localWorkspace = { ...workspace, workingDirectory: '/repo', backend: undefined };
      useWorkspacesStore.setState({ workspaces: [localWorkspace] });
      useProjectsStore.setState({ projects: [{ ...project, behindTargetAction: action }] });
      vi.mocked(window.api.getChangedFilesWithSummary).mockResolvedValue({
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });
      const operation = vi.mocked(
        action === 'rebase' ? window.api.rebaseOnTargetBranch : window.api.mergeFrom
      );
      operation.mockResolvedValueOnce({ success: true, message: 'Synced' });
      renderIndicator(localWorkspace);
      fireEvent.click(screen.getByRole('button', { name: '↓2' }));

      await waitFor(() => expect(screen.getByRole('button', { name: '↑3' })).toBeEnabled());
      expect(screen.queryByText('↓2')).not.toBeInTheDocument();
      expect(window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();

      act(() => {
        useGitStatusStore.getState().applyPushedStatus(workspace.id, branchStatus);
      });
      expect(screen.getByRole('button', { name: '↓2' })).toBeEnabled();

      operation.mockResolvedValueOnce({ success: false, message: 'Conflicts' });
      fireEvent.click(screen.getByRole('button', { name: '↓2' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '↓2' })).toBeEnabled());
      expect(window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['rebase', 'merge'] as const)(
    'clears the behind count after successful %s without waiting for a watcher update',
    async (action) => {
      useProjectsStore.setState({ projects: [{ ...project, behindTargetAction: action }] });
      renderIndicator();
      fireEvent.click(screen.getByRole('button', { name: '↓2' }));

      await waitFor(() => {
        expect(useGitStatusStore.getState().getStatus(workspace.id)?.status).toEqual({
          ...branchStatus,
          behindTargetBranch: 0,
        });
      });
      expect(screen.queryByText('↓2')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '↑3' })).toBeEnabled();

      act(() => {
        useGitStatusStore.getState().applyPushedStatus(workspace.id, branchStatus);
      });
      expect(screen.getByRole('button', { name: '↓2' })).toBeEnabled();
    }
  );

  it.each(['rebase', 'merge'] as const)(
    'preserves the behind count when %s fails or throws',
    async (action) => {
      useProjectsStore.setState({ projects: [{ ...project, behindTargetAction: action }] });
      const operation = vi.mocked(
        action === 'rebase' ? window.api.rebaseWorkspaceOnBranch : window.api.mergeWorkspaceFrom
      );
      operation.mockResolvedValueOnce({ success: false, message: 'Conflicts' });
      renderIndicator();
      fireEvent.click(screen.getByRole('button', { name: '↓2' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '↓2' })).toBeEnabled());
      expect(useGitStatusStore.getState().getStatus(workspace.id)?.status).toEqual(branchStatus);

      operation.mockRejectedValueOnce(new Error('Connection lost'));
      fireEvent.click(screen.getByRole('button', { name: '↓2' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '↓2' })).toBeEnabled());
      expect(useGitStatusStore.getState().getStatus(workspace.id)?.status).toEqual(branchStatus);
    }
  );

  it('routes merge-to-target by workspace id', async () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, behindTargetBranch: 0 },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));
    await waitFor(() =>
      expect(window.api.mergeWorkspaceToTargetBranch).toHaveBeenCalledWith(workspace.id)
    );
    expect(window.api.mergeToTargetBranch).not.toHaveBeenCalled();
  });

  it('leaves muting a stopped workspace to its card instead of fading the pills again', () => {
    const stoppedWorkspace = createWorkspace({
      id: 'stopped-workspace',
      projectId: 'project-1',
      workingDirectory: '/repos/komla/.worktrees/stopped',
      branchName: 'feature/stopped',
    });
    useWorkspacesStore.setState({ workspaces: [stoppedWorkspace], selectedWorkspaceId: null });
    useGitStatusStore.setState({
      statusMap: new Map([
        [stoppedWorkspace.id, { status: branchStatus, lastFetched: Date.now(), isLoading: false }],
      ]),
    });
    vi.mocked(window.api.getChangedFilesWithSummary).mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    });

    render(
      <TooltipProvider>
        <GitStatusIndicator
          workspaceId={stoppedWorkspace.id}
          workingDirectory={stoppedWorkspace.workingDirectory}
          projectId={stoppedWorkspace.projectId}
          inactive
        />
      </TooltipProvider>
    );

    expect(screen.getByText('↑3').closest('.font-mono')).not.toHaveClass('opacity-50');
  });

  it('shows diff stats as plain colored text, not pills that look like status badges', async () => {
    const localWorkspace = createWorkspace({
      id: 'local-workspace',
      projectId: 'project-1',
      workingDirectory: '/repos/komla/.worktrees/local',
      branchName: 'feature/local',
    });
    useWorkspacesStore.setState({ workspaces: [localWorkspace], selectedWorkspaceId: null });
    useGitStatusStore.setState({
      statusMap: new Map([
        [localWorkspace.id, { status: branchStatus, lastFetched: Date.now(), isLoading: false }],
      ]),
    });
    vi.mocked(window.api.getChangedFilesWithSummary).mockResolvedValue({
      files: [],
      summary: { additions: 12, deletions: 3, filesChanged: 2 },
    });

    renderIndicator(localWorkspace);

    const additions = await screen.findByText('+12');
    const deletions = screen.getByText('-3');
    expect(additions).toHaveClass('text-success');
    expect(deletions).toHaveClass('text-error');
    for (const stat of [additions, deletions]) {
      expect(stat.className).not.toMatch(/\b(bg-|ring-|rounded)/);
    }
  });

  it('greys the diff stats when asked to mute them, keeping the ahead count colored', async () => {
    const stoppedWorkspace = createWorkspace({
      id: 'muted-workspace',
      projectId: 'project-1',
      workingDirectory: '/repos/komla/.worktrees/muted',
      branchName: 'feature/muted',
    });
    useWorkspacesStore.setState({ workspaces: [stoppedWorkspace], selectedWorkspaceId: null });
    useGitStatusStore.setState({
      statusMap: new Map([
        [stoppedWorkspace.id, { status: branchStatus, lastFetched: Date.now(), isLoading: false }],
      ]),
    });
    vi.mocked(window.api.getChangedFilesWithSummary).mockResolvedValue({
      files: [],
      summary: { additions: 12, deletions: 3, filesChanged: 2 },
    });

    render(
      <TooltipProvider>
        <GitStatusIndicator
          workspaceId={stoppedWorkspace.id}
          workingDirectory={stoppedWorkspace.workingDirectory}
          projectId={stoppedWorkspace.projectId}
          inactive
          muteDiffStats
        />
      </TooltipProvider>
    );

    for (const stat of [await screen.findByText('+12'), screen.getByText('-3')]) {
      expect(stat).toHaveClass('text-muted-foreground');
      expect(stat).not.toHaveClass('text-success', 'text-error');
    }
    expect(screen.getByText('↑3')).not.toHaveClass('text-muted-foreground');
  });

  it('keeps the merge shortcut unavailable while behind the target', () => {
    renderIndicator();

    expect(screen.queryByRole('button', { name: '↑3' })).not.toBeInTheDocument();
    expect(screen.getByText('↑3')).toBeInTheDocument();
  });

  it('says why the merge shortcut is unavailable while behind the target', async () => {
    renderIndicator();

    fireEvent.focus(screen.getByText('↑3'));

    expect(
      (await screen.findAllByText(/Update from main first \(↓2\)/)).length
    ).toBeGreaterThan(0);
  });

  it('says the merge shortcut fast-forwards the target', async () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, behindTargetBranch: 0 },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });

    renderIndicator();
    fireEvent.focus(screen.getByRole('button', { name: '↑3' }));

    expect((await screen.findAllByText(/Click to fast-forward main/)).length).toBeGreaterThan(0);
  });

  it('names the target branch when the fast-forward throws', async () => {
    const developWorkspace = { ...workspace, baseBranch: 'develop' };
    useWorkspacesStore.setState({ workspaces: [developWorkspace] });
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, behindTargetBranch: 0, mainBranch: 'develop' },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });
    useToastStore.setState({ toasts: [] });
    vi.mocked(window.api.mergeWorkspaceToTargetBranch).mockRejectedValueOnce(
      new Error('Connection lost')
    );

    renderIndicator(developWorkspace);
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
        'Fast-forward of develop failed'
      )
    );
  });

  it('keeps an Action shortcut available while behind the target', () => {
    useProjectsStore.setState({
      projects: [
        { ...project, aheadTargetAction: 'agent-prompt', aheadTargetActionId: 'action-1' },
      ],
    });

    renderIndicator();

    expect(screen.getByRole('button', { name: '↑3' })).toBeEnabled();
  });

  it('asks what ↑N does on the first click, then does it once saved', async () => {
    useProjectsStore.setState({ projects: [{ ...project, aheadTargetAction: undefined }] });
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, behindTargetBranch: 0 },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });
    Object.assign(window.api, { updateProject: vi.fn().mockResolvedValue(undefined) });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save & open PR' }));

    await waitFor(() => expect(window.api.openExternal).toHaveBeenCalled());
    expect(window.api.updateProject).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ aheadTargetAction: 'auto-default' })
    );
  });

  it('picks its starting choice when it opens, after quick commands have loaded', async () => {
    useProjectsStore.setState({ projects: [{ ...project, aheadTargetAction: undefined }] });
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, behindTargetBranch: 0 },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });

    renderIndicator();
    act(() => {
      useActionsStore.setState({
        actions: [
          { id: 'pr-draft', title: 'Create PR draft with gh', type: 'prompt', content: 'Draft' },
        ],
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    expect(await screen.findByRole('button', { name: 'Save & run' })).toBeInTheDocument();
  });

  it('fast-forwards a repo without origin that inherits a quick command for the default branch', async () => {
    useProjectsStore.setState({ projects: [{ ...project, aheadTargetAction: undefined }] });
    const config = useConfigStore.getState().config;
    useConfigStore.setState({
      config: {
        ...config,
        gitDefaults: {
          aheadMainAction: 'agent-prompt',
          aheadMainActionId: 'pr-draft',
          aheadOtherAction: 'merge',
        },
      } as typeof config,
    });
    onTestFinished(() => useConfigStore.setState({ config }));
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, behindTargetBranch: 0, hasOriginRemote: false },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    await waitFor(() => expect(window.api.mergeWorkspaceToTargetBranch).toHaveBeenCalled());
  });

  it('says where to pick the quick command a ↑N choice is missing', async () => {
    useProjectsStore.setState({
      projects: [{ ...project, aheadTargetAction: 'auto', autoMainBranchAction: 'agent-prompt' }],
    });
    useToastStore.setState({ toasts: [] });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(
        "Pick the quick command ↑N runs in Settings → Git or the project's settings"
      )
    );
  });

  it('runs an Action shortcut where the Action chooses in SSH workspaces', async () => {
    useProjectsStore.setState({
      projects: [
        { ...project, aheadTargetAction: 'agent-prompt', aheadTargetActionId: 'action-1' },
      ],
    });
    useActionsStore.setState({
      actions: [
        {
          id: 'action-1',
          title: 'Desktop app',
          type: 'command',
          content: 'komla desktop run -- npm start',
          sshExecutionLocation: 'remote',
        },
      ],
    });
    const addTerminalCommand = vi.fn().mockResolvedValue(null);
    useWorkspacesStore.setState({ addTerminalCommand });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    await waitFor(() =>
      expect(addTerminalCommand).toHaveBeenCalledWith(
        workspace.id,
        'Desktop app',
        'komla desktop run -- npm start',
        undefined,
        'remote'
      )
    );
  });

  it("brings a Terminal Command shortcut's tab to the front", async () => {
    useProjectsStore.setState({
      projects: [
        { ...project, aheadTargetAction: 'agent-prompt', aheadTargetActionId: 'action-1' },
      ],
    });
    useActionsStore.setState({
      actions: [{ id: 'action-1', title: 'Push', type: 'command', content: 'git push' }],
    });
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    useWorkspacesStore.setState({
      addTerminalCommand: vi.fn().mockResolvedValue(createTerminal({ id: 'push-1' })),
    });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    await waitFor(() =>
      expect(useLayoutStore.getState().activeTabByWorkspace[workspace.id]).toBe('push-1')
    );
  });

  it('asks for the input an Action shortcut takes before running it', async () => {
    useProjectsStore.setState({
      projects: [
        { ...project, aheadTargetAction: 'agent-prompt', aheadTargetActionId: 'action-1' },
      ],
    });
    useActionsStore.setState({
      actions: [
        { id: 'action-1', title: 'Open PR', type: 'prompt', content: 'Open a PR {{user_input}}' },
      ],
    });
    const addAgentTab = vi.fn();
    useWorkspacesStore.setState({ addAgentTab });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    expect(await screen.findByRole('dialog', { name: 'Open PR' })).toBeInTheDocument();
    expect(addAgentTab).not.toHaveBeenCalled();
  });

  it('refreshes all workspaces sharing the SSH repository after auto-push completes', async () => {
    const sibling = createWorkspace({
      ...workspace,
      id: 'ssh-sibling',
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/komla/sibling',
      branchName: 'feature/sibling',
      backend: {
        ...workspace.backend,
        remoteDirectory: '/home/dev/.komla/worktrees/komla/sibling',
        branchName: 'feature/sibling',
      },
    });
    useWorkspacesStore.setState({ workspaces: [workspace, sibling] });
    useProjectsStore.setState({ projects: [{ ...project, autoPushAfterMerge: true }] });
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, behindTargetBranch: 0 },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    await waitFor(() => expect(window.api.pushWorkspaceTargetBranch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledWith(
        sibling.id,
        sibling.projectId
      )
    );

    const pushOrder = vi.mocked(window.api.pushWorkspaceTargetBranch).mock.invocationCallOrder[0];
    const statusMock = vi.mocked(window.api.getWorkspaceGitBranchStatus);
    const siblingRefreshIndex = statusMock.mock.calls.findIndex(([id]) => id === sibling.id);
    expect(statusMock.mock.invocationCallOrder[siblingRefreshIndex]).toBeGreaterThan(pushOrder);
  });

  it('uses the live project target when refreshing SSH repository siblings', async () => {
    const sibling = createWorkspace({
      ...workspace,
      id: 'ssh-sibling',
      baseBranch: 'develop',
      workingDirectory: 'ssh://ssh-dev/home/dev/.komla/worktrees/komla/sibling',
      branchName: 'feature/sibling',
      backend: {
        ...workspace.backend,
        remoteDirectory: '/home/dev/.komla/worktrees/komla/sibling',
        branchName: 'feature/sibling',
      },
    });
    const developStatus = { ...branchStatus, mainBranch: 'develop', behindTargetBranch: 0 };
    useWorkspacesStore.setState({ workspaces: [workspace, sibling] });
    useProjectsStore.setState({
      projects: [{ ...project, baseBranch: 'develop', autoPushAfterMerge: true }],
    });
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: developStatus,
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });
    vi.mocked(window.api.getWorkspaceGitBranchStatus).mockResolvedValue(developStatus);

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));

    await waitFor(() =>
      expect(window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledWith(
        sibling.id,
        sibling.projectId
      )
    );
  });

  it('routes merge-from-target by workspace id', async () => {
    useProjectsStore.setState({ projects: [{ ...project, behindTargetAction: 'merge' }] });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↓2' }));

    await waitFor(() =>
      expect(window.api.mergeWorkspaceFrom).toHaveBeenCalledWith(workspace.id, 'main', {
        stash: true,
      })
    );
    expect(window.api.mergeFrom).not.toHaveBeenCalled();
  });

  it('publishes an SSH branch and opens its remote PR URL while behind the target', async () => {
    useProjectsStore.setState({ projects: [{ ...project, aheadTargetAction: 'pr' }] });
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          workspace.id,
          {
            status: { ...branchStatus, hasRemote: false },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });

    renderIndicator();
    fireEvent.click(screen.getByRole('button', { name: '↑3' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish & create PR' }));

    await waitFor(() => expect(window.api.pushWorkspace).toHaveBeenCalledWith(workspace.id));
    expect(window.api.push).not.toHaveBeenCalled();
    expect(window.api.getCreatePrUrl).not.toHaveBeenCalled();
    expect(window.api.openExternal).toHaveBeenCalledWith(
      'https://github.com/example/komla/compare/main...feature%2Fcard-actions?expand=1'
    );
  });
});

describe('GitStatusIndicator paused rebase', () => {
  const localWorkspace = createWorkspace({
    id: 'local-workspace',
    projectId: 'project-1',
    workingDirectory: '/repo/feature',
    branchName: 'feature/local',
  });

  function setStatus(rebaseInProgress: boolean) {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          localWorkspace.id,
          {
            status: { ...branchStatus, rebaseInProgress },
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });
  }

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getChangedFilesWithSummary: vi.fn().mockResolvedValue({
          files: [],
          summary: { additions: 0, deletions: 0, filesChanged: 0 },
        }),
        getWorkspaceGitBranchStatus: vi
          .fn()
          .mockResolvedValue({ ...branchStatus, rebaseInProgress: true }),
        rebaseOnTargetBranch: vi.fn().mockResolvedValue({
          success: false,
          message: 'Rebase onto main paused because conflict.txt has conflicts.',
        }),
        abortRebase: vi.fn().mockResolvedValue({ success: true, message: 'Rebase aborted.' }),
      },
    });
    useWorkspacesStore.setState({
      workspaces: [localWorkspace],
      selectedWorkspaceId: localWorkspace.id,
    });
    useProjectsStore.setState({ projects: [project] });
    useFileListStore.setState({
      statusCache: new Map(),
      diffCache: new Map(),
      fileDiffCache: new Map(),
    });
    useToastStore.setState({ toasts: [] });
  });

  it('shows the paused rebase in place of the target-branch shortcuts', () => {
    setStatus(true);

    renderIndicator(localWorkspace);

    expect(screen.getByText('rebasing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '↑3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '↓2' })).not.toBeInTheDocument();
  });

  it('lets the keyboard reach the paused rebase explanation', () => {
    setStatus(true);
    renderIndicator(localWorkspace);

    const pill = screen.getByText('rebasing');
    act(() => pill.focus());

    expect(pill).toHaveFocus();
  });

  it('offers to abort a rebase that stops on conflicts', async () => {
    setStatus(false);

    renderIndicator(localWorkspace);
    fireEvent.click(screen.getByRole('button', { name: '↓2' }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.action?.label).toBe('Abort rebase')
    );
    expect(window.api.rebaseOnTargetBranch).toHaveBeenCalledWith('/repo/feature', {
      stash: true,
    });
    expect(await screen.findByText('rebasing')).toBeInTheDocument();

    act(() => useToastStore.getState().toasts[0].action?.onClick());

    expect(useRebaseAbortStore.getState().pending).toMatchObject({
      id: localWorkspace.id,
      workingDirectory: '/repo/feature',
    });
    expect(window.api.abortRebase).not.toHaveBeenCalled();
  });
});
