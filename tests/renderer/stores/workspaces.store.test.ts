import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushMicrotasks, flushTimersAndMicrotasks } from '../../setup';
import { createSshWorkspace, createTerminal, createWorkspace } from '../../factories';

const { disposeTerminalRenderersMock, nudgeAgentSetupMock } = vi.hoisted(() => ({
  disposeTerminalRenderersMock: vi.fn(),
  nudgeAgentSetupMock: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/agent-setup-nudge.store', () => ({
  nudgeAgentSetup: nudgeAgentSetupMock,
}));

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderers: disposeTerminalRenderersMock,
  getTerminalRendererDimensions: vi.fn(() => undefined),
}));

vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));

import {
  registerPaneCloseConfirm,
  setFilePaneDraft,
} from '../../../src/renderer/lib/pane-surfaces';
import { useFileListStore } from '../../../src/renderer/stores/file-list.store';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';
import { useDevServerPreviewStore } from '../../../src/renderer/stores/dev-server-preview.store';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { useGitStatusStore } from '../../../src/renderer/stores/git-status.store';
import { useLicenseStore } from '../../../src/renderer/stores/license.store';
import { useProjectsStore } from '../../../src/renderer/stores/projects.store';
import { useSshHostsStore } from '../../../src/renderer/stores/ssh-hosts.store';
import { useSshCommandExecutionLocationStore } from '../../../src/renderer/stores/ssh-command-execution-location.store';
import { claimTerminal, releaseTerminal } from '../../../src/renderer/stores/terminal-busy.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorktreeEventsStore } from '../../../src/renderer/stores/worktree-events.store';
import { getAllLeaves } from '../../../src/renderer/lib/layout-utils';
import {
  useWorkspacesStore,
  _resetPendingDeletions,
} from '../../../src/renderer/stores/workspaces.store';

interface ApiMock {
  removeMissingSshWorkspace?: ReturnType<typeof vi.fn>;
  getWorkspaceDiffAgainstBranch?: ReturnType<typeof vi.fn>;
  listSshHosts: ReturnType<typeof vi.fn>;
  getWorkspaces: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
  createWorkspaces: ReturnType<typeof vi.fn>;
  addTerminal: ReturnType<typeof vi.fn>;
  removeTerminal: ReturnType<typeof vi.fn>;
  stopWorkspace: ReturnType<typeof vi.fn>;
  stopTerminal: ReturnType<typeof vi.fn>;
  restartTerminal: ReturnType<typeof vi.fn>;
  reconnectSshTerminal: ReturnType<typeof vi.fn>;
  recoverSshSessions: ReturnType<typeof vi.fn>;
  deleteWorkspace: ReturnType<typeof vi.fn>;
  restartWorkspace: ReturnType<typeof vi.fn>;
  reorderWorkspace: ReturnType<typeof vi.fn>;
  clearWorkspaceAttention: ReturnType<typeof vi.fn>;
  updateWorkspace: ReturnType<typeof vi.fn>;
  moveWorkspaceToWindow: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  updateTerminal: ReturnType<typeof vi.fn>;
  getWorkspaceQuota: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
  listWorkspaceFiles: ReturnType<typeof vi.fn>;
  getDiff: ReturnType<typeof vi.fn>;
  getChangedFilesWithSummary: ReturnType<typeof vi.fn>;
  linkWorkspaces: ReturnType<typeof vi.fn>;
  unlinkWorkspace: ReturnType<typeof vi.fn>;
  notifyWorkspacesChanged: ReturnType<typeof vi.fn>;
}

function createApiMock(overrides: Partial<ApiMock> = {}): ApiMock {
  return {
    listSshHosts: vi.fn().mockResolvedValue([]),
    getWorkspaces: vi.fn().mockResolvedValue([]),
    createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
    createWorkspaces: vi.fn().mockResolvedValue([]),
    addTerminal: vi.fn(),
    removeTerminal: vi.fn(),
    stopWorkspace: vi.fn(),
    stopTerminal: vi.fn(),
    restartTerminal: vi.fn().mockResolvedValue({ id: 'term-1' }),
    reconnectSshTerminal: vi.fn().mockResolvedValue({ id: 'term-1' }),
    recoverSshSessions: vi.fn().mockResolvedValue(undefined),
    deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    restartWorkspace: vi.fn(),
    reorderWorkspace: vi.fn().mockResolvedValue(undefined),
    clearWorkspaceAttention: vi.fn(),
    updateWorkspace: vi.fn().mockResolvedValue(undefined),
    notifyWorkspacesChanged: vi.fn().mockResolvedValue(undefined),
    moveWorkspaceToWindow: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    updateTerminal: vi.fn().mockResolvedValue(undefined),
    getWorkspaceQuota: vi
      .fn()
      .mockResolvedValue({ allowed: true, count: 0, limit: 4, isLicensed: false }),
    listFiles: vi.fn().mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] }),
    listWorkspaceFiles: vi
      .fn()
      .mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] }),
    getDiff: vi.fn().mockResolvedValue({ files: [] }),
    getChangedFilesWithSummary: vi.fn().mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    }),
    linkWorkspaces: vi.fn().mockResolvedValue(undefined),
    unlinkWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function resetAllStores(): void {
  useWorkspacesStore.setState(useWorkspacesStore.getInitialState(), true);
  useDevServerPreviewStore.setState(useDevServerPreviewStore.getInitialState(), true);
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  useGitStatusStore.setState(useGitStatusStore.getInitialState(), true);
  useLicenseStore.setState(useLicenseStore.getInitialState(), true);
  useFileListStore.setState(useFileListStore.getInitialState(), true);
  useWorktreeEventsStore.setState(useWorktreeEventsStore.getInitialState(), true);
  useProjectsStore.setState(useProjectsStore.getInitialState(), true);
  useSshHostsStore.setState(useSshHostsStore.getInitialState(), true);
  useSshCommandExecutionLocationStore.setState(
    useSshCommandExecutionLocationStore.getInitialState(),
    true
  );
  useToastStore.setState(useToastStore.getInitialState(), true);
}

describe('workspaces.store', () => {
  beforeEach(() => {
    resetAllStores();
    _resetPendingDeletions();
    disposeTerminalRenderersMock.mockReset();
    (globalThis as { window: { api: ApiMock } }).window = {
      api: createApiMock(),
    };
  });

  it('checks whether a new workspace’s agent needs setup, unless a command replaces the agent', async () => {
    const workspace = createWorkspace({ id: 'ws-new', presetId: 'claude' });
    const api = createApiMock({
      createWorkspace: vi.fn().mockResolvedValue(workspace),
      getWorkspaces: vi.fn().mockResolvedValue([workspace]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    nudgeAgentSetupMock.mockClear();

    await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', projectId: 'p-1' });
    expect(nudgeAgentSetupMock).toHaveBeenCalledWith([workspace]);

    nudgeAgentSetupMock.mockClear();
    await useWorkspacesStore
      .getState()
      .createWorkspace({ mode: 'directory', projectId: 'p-1', initialCommand: 'npm test' });
    expect(nudgeAgentSetupMock).not.toHaveBeenCalled();
  });

  it('checks the agent workspaces of a parallel launch', async () => {
    const ws1 = createWorkspace({ id: 'ws-1', presetId: 'claude' });
    const ws2 = createWorkspace({ id: 'ws-2', presetId: 'amp' });
    const api = createApiMock({
      createWorkspaces: vi.fn().mockResolvedValue([ws1, ws2]),
      getWorkspaces: vi.fn().mockResolvedValue([ws1, ws2]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    nudgeAgentSetupMock.mockClear();

    await useWorkspacesStore.getState().createWorkspaces([
      { mode: 'directory', projectId: 'p-1', initialCommand: 'npm test' },
      { mode: 'directory', projectId: 'p-1' },
    ]);

    expect(nudgeAgentSetupMock).toHaveBeenCalledWith([ws2]);
  });

  describe('moving a project whose group a launch brings into sight to the top', () => {
    const shown = createWorkspace({ id: 'ws-shown', windowId: 'window-1', projectId: 'p-1' });

    function launchInto(projectId: string, before: ReturnType<typeof createWorkspace>[]) {
      const created = createWorkspace({ id: 'ws-new', windowId: 'window-1', projectId });
      const api = createApiMock({
        createWorkspace: vi.fn().mockResolvedValue(created),
        createWorkspaces: vi.fn().mockResolvedValue([created]),
        getWorkspaces: vi.fn().mockResolvedValue([...before, created]),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: before, hasLoaded: true });
      const reorderProject = vi.fn().mockResolvedValue(undefined);
      useProjectsStore.setState({ reorderProject });
      return reorderProject;
    }

    it('moves a hidden project to the top', async () => {
      const hidden = createWorkspace({ id: 'ws-hidden', windowId: 'window-1', projectId: 'p-2' });
      const reorderProject = launchInto('p-2', [shown, hidden]);
      useWorkspacesStore.setState({ hiddenProjectIds: new Set(['p-2']) });

      await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', projectId: 'p-2' });

      expect(reorderProject).toHaveBeenCalledWith('p-2', 0);
    });

    it('moves a project with no workspaces in this window to the top', async () => {
      const reorderProject = launchInto('p-2', [shown]);

      await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', projectId: 'p-2' });

      expect(reorderProject).toHaveBeenCalledWith('p-2', 0);
    });

    it('moves it from a parallel launch too', async () => {
      const reorderProject = launchInto('p-2', [shown]);

      await useWorkspacesStore
        .getState()
        .createWorkspaces([{ mode: 'directory', projectId: 'p-2' }]);

      expect(reorderProject).toHaveBeenCalledTimes(1);
      expect(reorderProject).toHaveBeenCalledWith('p-2', 0);
    });

    it('moves several one at a time, the first launched ending on top', async () => {
      const reorderProject = launchInto('p-2', [shown]);
      const created = [
        createWorkspace({ id: 'ws-new-2', windowId: 'window-1', projectId: 'p-2' }),
        createWorkspace({ id: 'ws-new-3', windowId: 'window-1', projectId: 'p-3' }),
      ];
      window.api.createWorkspaces.mockResolvedValue(created);
      window.api.getWorkspaces.mockResolvedValue([shown, ...created]);
      const firstMove = createDeferred<void>();
      reorderProject.mockReturnValueOnce(firstMove.promise);

      await useWorkspacesStore.getState().createWorkspaces([
        { mode: 'directory', projectId: 'p-2' },
        { mode: 'directory', projectId: 'p-3' },
      ]);

      expect(reorderProject.mock.calls).toEqual([['p-3', 0]]);
      firstMove.resolve();
      await flushMicrotasks();
      expect(reorderProject.mock.calls).toEqual([
        ['p-3', 0],
        ['p-2', 0],
      ]);
    });

    it('leaves the order alone when the launch beat the first workspace load', async () => {
      const reorderProject = launchInto('p-1', []);
      useWorkspacesStore.setState({ hasLoaded: false });
      window.api.getWorkspaces.mockResolvedValue([
        shown,
        createWorkspace({ id: 'ws-new', windowId: 'window-1', projectId: 'p-1' }),
      ]);

      await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', projectId: 'p-1' });

      expect(reorderProject).not.toHaveBeenCalled();
    });

    it('leaves a group that was already in sight where it is', async () => {
      const reorderProject = launchInto('p-1', [shown]);

      await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', projectId: 'p-1' });

      expect(reorderProject).not.toHaveBeenCalled();
    });

    it('leaves alone a project that came into sight for another reason', async () => {
      const reorderProject = launchInto('p-1', [shown]);
      const arrived = createWorkspace({ id: 'ws-arrived', windowId: 'window-1', projectId: 'p-3' });
      window.api.getWorkspaces.mockResolvedValue([
        shown,
        arrived,
        createWorkspace({ id: 'ws-new', windowId: 'window-1', projectId: 'p-1' }),
      ]);

      await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', projectId: 'p-1' });

      expect(reorderProject).not.toHaveBeenCalled();
    });

    it('leaves the order alone without project groups', async () => {
      const reorderProject = launchInto('p-2', [shown]);
      useWorkspacesStore.setState({ grouping: 'none' });

      await useWorkspacesStore.getState().createWorkspace({ mode: 'directory', projectId: 'p-2' });

      expect(reorderProject).not.toHaveBeenCalled();
    });
  });

  it('launches Terminal Commands through execution-location resolution', async () => {
    const terminal = createTerminal({ id: 'command-terminal' });
    const api = createApiMock({ addTerminal: vi.fn().mockResolvedValue(terminal) });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const workspace = createWorkspace({ id: 'ws-1' });
    useWorkspacesStore.setState({ workspaces: [workspace] });

    const result = await useWorkspacesStore
      .getState()
      .addTerminalCommand('ws-1', 'Dev Server', 'npm run dev', 'tab');

    expect(result).toEqual(terminal);
    expect(api.addTerminal).toHaveBeenCalledWith(
      'ws-1',
      'Dev Server',
      'npm run dev',
      'tab',
      'host',
      'workspace'
    );
  });

  it('handles async loadWorkspaces transitions and resets loading/error flags', async () => {
    const deferred = createDeferred<ReturnType<typeof createWorkspace>[]>();
    const api = createApiMock({ getWorkspaces: vi.fn().mockReturnValue(deferred.promise) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ error: 'stale-error' });

    const loadingPromise = useWorkspacesStore.getState().loadWorkspaces();
    expect(useWorkspacesStore.getState().isLoading).toBe(true);
    expect(useWorkspacesStore.getState().error).toBeNull();

    const ws = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 'term-1' })] });
    deferred.resolve([ws]);
    await loadingPromise;

    expect(useWorkspacesStore.getState().isLoading).toBe(false);
    expect(useWorkspacesStore.getState().error).toBeNull();
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-1']);
  });

  it('forwards explicit command options when restarting a terminal', async () => {
    const options = {
      command: 'npm run dev',
      commandKind: 'host' as const,
    };
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    const restarted = await useWorkspacesStore
      .getState()
      .restartTerminal('term-1', undefined, undefined, 120, 30, options);

    expect(restarted).toBe(true);
    expect(api.restartTerminal).toHaveBeenCalledWith(
      'term-1',
      undefined,
      undefined,
      120,
      30,
      options
    );
  });

  it('hydrates split-only setup-step layouts from a provisioning placeholder', async () => {
    const ws = createWorkspace({
      id: 'ws-1',
      terminals: [
        createTerminal({ id: 'agent' }),
        createTerminal({ id: 'server', layoutHint: 'split-right' }),
        createTerminal({ id: 'logs', layoutHint: 'split-bottom' }),
      ],
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([ws]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useLayoutStore.getState().setCurrentWorkspace('ws-1');

    await useWorkspacesStore.getState().loadWorkspaces();

    expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toEqual(['agent']);
    const layout = useLayoutStore.getState().layoutsByTab['ws-1']?.agent;
    expect(layout).toBeDefined();
    expect(getAllLeaves(layout!).map((leaf) => leaf.terminalId)).toEqual([
      'agent',
      'server',
      'logs',
    ]);
  });

  it('restores the saved SSH tab before workspace subscribers initialize a default layout', async () => {
    const terminal = createTerminal({ id: 'term-remote', status: 'stopped' });
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [terminal, createTerminal({ id: 'term-shell', status: 'stopped' })],
      terminalLayout: {
        tabs: ['term-remote', 'term-shell'],
        activeTab: 'term-shell',
        layouts: {
          'term-shell': { type: 'leaf', id: 'pane-shell', terminalId: 'term-shell' },
          'term-remote': { type: 'leaf', id: 'pane-remote', terminalId: 'term-remote' },
        },
      },
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([workspace]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    // TerminalTabs initializes missing layouts when newly loaded workspaces become visible.
    const unsubscribe = useWorkspacesStore.subscribe((state) => {
      for (const ws of state.workspaces) {
        if (!useLayoutStore.getState().tabsByWorkspace[ws.id]?.length) {
          useLayoutStore.getState().initializeWorkspaceLayout(ws.id, ws.terminals[0]?.id);
        }
      }
    });
    try {
      await useWorkspacesStore.getState().loadWorkspaces();
    } finally {
      unsubscribe();
    }

    expect(useLayoutStore.getState().tabsByWorkspace['ssh-ws']).toEqual([
      'term-remote',
      'term-shell',
    ]);
    expect(useLayoutStore.getState().layoutsByTab['ssh-ws']?.['term-remote']).toMatchObject({
      id: 'pane-remote',
      terminalId: 'term-remote',
    });
    expect(useLayoutStore.getState().activeTabByWorkspace['ssh-ws']).toBe('term-shell');
    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().focusedPaneByTab['ssh-ws']).toEqual({
      'term-remote': 'pane-remote',
      'term-shell': 'pane-shell',
    });
    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
  });

  it('leaves persisted SSH git status for the Workspace observation projection', async () => {
    const branch = {
      behindTargetBranch: 1,
      aheadTargetBranch: 2,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 2,
      behindRemote: 0,
      currentBranch: 'agent/remote',
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };
    const diff = {
      files: [
        {
          path: 'src/app.ts',
          status: 'modified' as const,
          staged: false,
          additions: 3,
          deletions: 1,
        },
      ],
      summary: { additions: 3, deletions: 1, filesChanged: 1 },
    };
    const workspace = createWorkspace({
      id: 'ssh-ws',
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
      },
      lastKnownGitStatus: { branch, diff, updatedAt: 1234 },
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([workspace]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await useWorkspacesStore.getState().loadWorkspaces();

    expect(useGitStatusStore.getState().getStatus('ssh-ws')).toBeUndefined();
    expect(
      useFileListStore
        .getState()
        .getDiff(workspace.workingDirectory, undefined, false, workspace.id)
    ).toBeUndefined();
    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
  });

  it('clears selected workspace and current layout when a reload no longer includes it', async () => {
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
    const ws2 = createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 't-2' })] });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([ws2]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({
      workspaces: [ws1, ws2],
      selectedWorkspaceId: 'ws-1',
    });
    useLayoutStore.getState().setCurrentWorkspace('ws-1', 't-1');

    await useWorkspacesStore.getState().loadWorkspaces();

    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-2']);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().tabsByWorkspace['ws-1']).toBeUndefined();
  });

  it('preserves a newer selected workspace when a stale reload resolves', async () => {
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
    const ws2 = createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 't-2' })] });
    const deferred = createDeferred<ReturnType<typeof createWorkspace>[]>();
    const api = createApiMock({ getWorkspaces: vi.fn().mockReturnValue(deferred.promise) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({
      workspaces: [ws1, ws2],
      selectedWorkspaceId: 'ws-1',
    });
    useLayoutStore.getState().setCurrentWorkspace('ws-2', 't-2');

    const loadingPromise = useWorkspacesStore.getState().loadWorkspaces();
    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-2' });

    deferred.resolve([ws2]);
    await loadingPromise;

    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-2']);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-2');
    expect(useLayoutStore.getState().currentWorkspaceId).toBe('ws-2');
  });

  it('clears selected workspace and layout optimistically when deleting a workspace', () => {
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
    const ws2 = createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 't-2' })] });

    useWorkspacesStore.setState({
      workspaces: [ws1, ws2],
      selectedWorkspaceId: 'ws-1',
    });
    useLayoutStore.getState().setCurrentWorkspace('ws-1', 't-1');

    useWorkspacesStore.getState().deleteWorkspace('ws-1');

    expect(disposeTerminalRenderersMock).toHaveBeenCalledWith(['t-1']);
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-2']);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
  });

  it('clears worktree event state when deleting a workspace', () => {
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
    useWorkspacesStore.setState({ workspaces: [ws1], selectedWorkspaceId: 'ws-1' });

    // Simulate a recorded worktree event for the workspace
    useWorktreeEventsStore.getState().recordEvent('ws-1', 12345);
    expect(useWorktreeEventsStore.getState().lastEventByWorkspace['ws-1']).toBe(12345);

    useWorkspacesStore.getState().deleteWorkspace('ws-1');

    expect(useWorktreeEventsStore.getState().lastEventByWorkspace['ws-1']).toBeUndefined();
  });

  it('refreshes workspace quota after a workspace is deleted', async () => {
    vi.useFakeTimers();
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    const loadQuotaSpy = vi.fn().mockResolvedValue(undefined);
    useLicenseStore.setState({ loadQuota: loadQuotaSpy });
    useWorkspacesStore.setState({ workspaces: [ws1], selectedWorkspaceId: 'ws-1' });

    useWorkspacesStore.getState().deleteWorkspace('ws-1');
    await flushTimersAndMicrotasks();

    expect(api.deleteWorkspace).toHaveBeenCalledWith('ws-1', false, false);
    expect(loadQuotaSpy).toHaveBeenCalledTimes(1);
  });

  it('reports when main has finished deleting, or failed to', async () => {
    vi.useFakeTimers();
    const deletes = [createDeferred<void>(), createDeferred<void>()];
    const api = createApiMock({
      deleteWorkspace: vi
        .fn()
        .mockReturnValueOnce(deletes[0].promise)
        .mockReturnValueOnce(deletes[1].promise),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1' }), createWorkspace({ id: 'ws-2' })],
    });
    const settled = vi.fn();

    await useWorkspacesStore.getState().deleteWorkspace('ws-1', true, false, () => settled('ws-1'));
    await useWorkspacesStore.getState().deleteWorkspace('ws-2', true, false, () => settled('ws-2'));
    expect(settled).not.toHaveBeenCalled();

    deletes[0].resolve();
    deletes[1].reject(new Error('worktree busy'));
    // A finished delete first reloads the workspace list.
    await flushTimersAndMicrotasks();
    await flushTimersAndMicrotasks();

    expect(settled.mock.calls).toEqual(expect.arrayContaining([['ws-1'], ['ws-2']]));
  });

  it('refreshes linked peer state after deleting a linked workspace', async () => {
    vi.useFakeTimers();
    const ws1 = createWorkspace({
      id: 'ws-1',
      workingDirectory: '/tmp/ws-1',
      linkedWorkspaceIds: ['ws-2'],
    });
    const ws2 = createWorkspace({
      id: 'ws-2',
      workingDirectory: '/tmp/ws-2',
      linkedWorkspaceIds: ['ws-1'],
    });
    const unlinkedWs2 = { ...ws2, linkedWorkspaceIds: [] };
    const api = createApiMock({
      getWorkspaces: vi.fn().mockResolvedValue([unlinkedWs2]),
      listFiles: vi
        .fn()
        .mockResolvedValue({ files: ['src/index.ts'], gitIgnoredFiles: [], emptyDirs: [] }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

    useWorkspacesStore.getState().deleteWorkspace('ws-1');
    await flushTimersAndMicrotasks();

    expect(useWorkspacesStore.getState().workspaces).toEqual([unlinkedWs2]);
    expect(api.getWorkspaces).toHaveBeenCalled();
    expect(api.listFiles).toHaveBeenCalledWith('/tmp/ws-2', false);
    expect(api.notifyWorkspacesChanged).toHaveBeenCalled();
  });

  it('loadWorkspaces does not resurrect workspaces with in-flight deletions', async () => {
    vi.useFakeTimers();
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
    const ws2 = createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 't-2' })] });

    // Backend delete hangs (never resolves) to simulate in-flight deletion
    const deleteDeferred = createDeferred<void>();
    const api = createApiMock({
      deleteWorkspace: vi.fn().mockReturnValue(deleteDeferred.promise),
      // Backend still returns both workspaces (delete hasn't completed)
      getWorkspaces: vi.fn().mockResolvedValue([ws1, ws2]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

    // Start deletion of ws-1 (optimistic removal + fire-and-forget backend call)
    useWorkspacesStore.getState().deleteWorkspace('ws-1');
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-2']);
    // The row leaving the sidebar is the feedback, so a successful delete shows no toast.
    expect(useToastStore.getState().toasts).toEqual([]);

    // Simulate a concurrent loadWorkspaces triggered by an unrelated WORKSPACE_UPDATED event
    await useWorkspacesStore.getState().loadWorkspaces();

    // ws-1 must stay hidden even though the backend still returns it
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-2']);

    // Complete the deletion so pending state is cleaned up
    deleteDeferred.resolve();
    await deleteDeferred.promise;
    await flushTimersAndMicrotasks();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('deleteSelectedWorkspaces hides all selected workspaces even when loadWorkspaces races', async () => {
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
    const ws2 = createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 't-2' })] });
    const ws3 = createWorkspace({ id: 'ws-3', terminals: [createTerminal({ id: 't-3' })] });

    // Backend deletes never resolve to keep them in-flight
    const deferred1 = createDeferred<void>();
    const deferred2 = createDeferred<void>();
    const deleteCall = vi
      .fn()
      .mockReturnValueOnce(deferred1.promise)
      .mockReturnValueOnce(deferred2.promise);

    const api = createApiMock({
      deleteWorkspace: deleteCall,
      // Backend still returns all three (deletions haven't completed)
      getWorkspaces: vi.fn().mockResolvedValue([ws1, ws2, ws3]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({
      workspaces: [ws1, ws2, ws3],
      selectionMode: true,
      selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
    });

    // Bulk delete ws-1 and ws-2
    await useWorkspacesStore.getState().deleteSelectedWorkspaces();

    // Only ws-3 should remain after optimistic removal
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-3']);

    // Simulate a concurrent loadWorkspaces from an unrelated event
    await useWorkspacesStore.getState().loadWorkspaces();

    // ws-1 and ws-2 must stay hidden
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-3']);
    expect(useWorkspacesStore.getState().selectionMode).toBe(false);

    // Clean up
    deferred1.resolve();
    deferred2.resolve();
    await Promise.all([deferred1.promise, deferred2.promise]);
  });

  it('clears pending deletion guard when backend delete fails so workspace can reappear', async () => {
    vi.useFakeTimers();
    const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });

    const deleteDeferred = createDeferred<void>();
    const api = createApiMock({
      deleteWorkspace: vi.fn().mockReturnValue(deleteDeferred.promise),
      getWorkspaces: vi.fn().mockResolvedValue([ws1]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ workspaces: [ws1] });

    // Start deletion
    useWorkspacesStore.getState().deleteWorkspace('ws-1');
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(0);

    // Backend rejects the deletion
    deleteDeferred.reject(new Error('worktree busy'));
    await flushTimersAndMicrotasks();

    // After failure, loadWorkspaces is called (by the catch handler) and the
    // pending guard should be cleared, so the workspace reappears
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-1']);
  });

  it('offers to retry, without stopping opencode, when its service holds the worktree', async () => {
    vi.useFakeTimers();
    const ws1 = createWorkspace({ id: 'ws-1' });
    const api = createApiMock({
      deleteWorkspace: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            `Error invoking remote method 'workspace:delete': Error: OPENCODE_HOLDS_WORKTREE: opencode's background service may still be using D:/wt. opencode sessions open in other workspaces can load it again; close them, then retry.`
          )
        )
        .mockResolvedValueOnce(undefined),
      getWorkspaces: vi.fn().mockResolvedValue([ws1]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [ws1] });

    useWorkspacesStore.getState().deleteWorkspace('ws-1', true, true);
    await flushTimersAndMicrotasks();

    const toast = useToastStore.getState().toasts.find((t) => t.type === 'error');
    expect(toast?.message).toBe(`Failed to delete workspace "Test Workspace": opencode's background service may still be using D:/wt. opencode sessions open in other workspaces can load it again; close them, then retry.`);
    expect(toast?.action?.label).toBe('Retry');
    expect(toast?.dismissOnTimeout).toBe(false);

    toast?.action?.onClick();
    await flushTimersAndMicrotasks();

    expect(api.deleteWorkspace).toHaveBeenCalledTimes(2);
    expect(api.deleteWorkspace).toHaveBeenLastCalledWith('ws-1', true, true);
  });

  it('removes a workspace missing from its host here only, and restores it if that fails', async () => {
    vi.useFakeTimers();
    const ws1 = createWorkspace({ id: 'ws-1' });
    const api = createApiMock({
      removeMissingSshWorkspace: vi.fn().mockRejectedValue(new Error('not found')),
      getWorkspaces: vi.fn().mockResolvedValue([ws1]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [ws1] });

    const removing = useWorkspacesStore.getState().removeMissingSshWorkspace('ws-1');
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(0);
    await removing;
    await flushTimersAndMicrotasks();

    expect(api.removeMissingSshWorkspace).toHaveBeenCalledWith('ws-1');
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['ws-1']);
  });

  it('reorders workspace orders optimistically and ignores missing workspace IDs', async () => {
    const ws1 = createWorkspace({ id: 'ws-1', order: 0 });
    const ws2 = createWorkspace({ id: 'ws-2', order: 1 });
    const ws3 = createWorkspace({ id: 'ws-3', order: 2 });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ workspaces: [ws1, ws2, ws3] });

    await useWorkspacesStore.getState().reorderWorkspace('ws-1', 2);

    const reordered = useWorkspacesStore.getState().workspaces;
    expect(reordered.find((w) => w.id === 'ws-1')?.order).toBe(2);
    expect(reordered.find((w) => w.id === 'ws-2')?.order).toBe(0);
    expect(reordered.find((w) => w.id === 'ws-3')?.order).toBe(1);
    expect(api.reorderWorkspace).toHaveBeenCalledWith('ws-1', 2);

    api.reorderWorkspace.mockClear();
    const before = useWorkspacesStore.getState().workspaces;
    await useWorkspacesStore.getState().reorderWorkspace('missing-id', 1);
    expect(api.reorderWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().workspaces).toEqual(before);
  });

  it('handles stale selected IDs by allowing selection even when workspace list is empty', async () => {
    await useWorkspacesStore.getState().selectWorkspace('stale-id');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('stale-id');
    // No attention to clear on a stale/missing workspace, so IPC call fires immediately
    expect(globalThis.window.api.clearWorkspaceAttention).toHaveBeenCalledWith('stale-id');
  });

  it('auto-assigns current window when creating a workspace without explicit windowId', async () => {
    const ws = createWorkspace({
      id: 'ws-new',
      windowId: 'window-1',
      workingDirectory: '/tmp/ws-new',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
    });
    const api = createApiMock({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
      getWorkspaces: vi.fn().mockResolvedValue([ws]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await useWorkspacesStore.getState().createWorkspace({
      mode: 'directory',
      directoryPath: '/tmp/ws-new',
    });

    expect(api.createWorkspace).toHaveBeenCalledWith({
      mode: 'directory',
      directoryPath: '/tmp/ws-new',
      windowId: 'window-1',
    });
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-new');
    expect(useWorkspacesStore.getState().workspaces[0]?.id).toBe('ws-new');
  });

  it('creates a batch through one IPC call and refreshes the workspace list once', async () => {
    const created = [
      createWorkspace({ id: 'ws-new-1', workingDirectory: '/tmp/one' }),
      createWorkspace({ id: 'ws-new-2', workingDirectory: '/tmp/two' }),
    ];
    const api = createApiMock({
      createWorkspaces: vi.fn().mockResolvedValue(created),
      getWorkspaces: vi.fn().mockResolvedValue(created),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await useWorkspacesStore.getState().createWorkspaces([
      { mode: 'directory', directoryPath: '/tmp/one', initialPrompt: 'task' },
      { mode: 'directory', directoryPath: '/tmp/two', initialPrompt: 'task' },
    ]);

    expect(api.createWorkspaces).toHaveBeenCalledWith([
      {
        mode: 'directory',
        directoryPath: '/tmp/one',
        initialPrompt: 'task',
        windowId: 'window-1',
      },
      {
        mode: 'directory',
        directoryPath: '/tmp/two',
        initialPrompt: 'task',
        windowId: 'window-1',
      },
    ]);
    expect(api.getWorkspaces).toHaveBeenCalledTimes(1);
    expect(useWorkspacesStore.getState().workspaces).toEqual(created);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-new-1');
  });

  it('preserves the selected workspace after creating a batch', async () => {
    const existing = createWorkspace({ id: 'ws-existing', workingDirectory: '/tmp/existing' });
    const created = [
      createWorkspace({ id: 'ws-new-1', workingDirectory: '/tmp/one' }),
      createWorkspace({ id: 'ws-new-2', workingDirectory: '/tmp/two' }),
    ];
    const api = createApiMock({
      createWorkspaces: vi.fn().mockResolvedValue(created),
      getWorkspaces: vi.fn().mockResolvedValue([existing, ...created]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({
      workspaces: [existing],
      selectedWorkspaceId: existing.id,
    });

    await useWorkspacesStore.getState().createWorkspaces([
      { mode: 'directory', directoryPath: '/tmp/one', initialPrompt: 'task' },
      { mode: 'directory', directoryPath: '/tmp/two', initialPrompt: 'task' },
    ]);

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(existing.id);
  });

  it('reconciles partial batch successes while preserving the creation error', async () => {
    const existing = createWorkspace({ id: 'ws-existing', workingDirectory: '/tmp/existing' });
    const partialSuccess = createWorkspace({
      id: 'ws-new-1',
      workingDirectory: '/tmp/one',
    });
    const error = new Error('Failed to create the second workspace');
    const api = createApiMock({
      createWorkspaces: vi.fn().mockRejectedValue(error),
      getWorkspaces: vi.fn().mockResolvedValue([existing, partialSuccess]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [existing] });

    await expect(
      useWorkspacesStore.getState().createWorkspaces([
        { mode: 'directory', directoryPath: '/tmp/one', initialPrompt: 'task' },
        { mode: 'directory', directoryPath: '/tmp/two', initialPrompt: 'task' },
      ])
    ).rejects.toBe(error);

    expect(api.getWorkspaces).toHaveBeenCalledTimes(1);
    expect(useWorkspacesStore.getState().workspaces).toEqual([existing, partialSuccess]);
    expect(useWorkspacesStore.getState().error).toBe(error.message);
    expect(useWorkspacesStore.getState().isLoading).toBe(false);
  });

  it('auto-unhides the project when creating a workspace in a hidden project group', async () => {
    const newWs = createWorkspace({
      id: 'ws-new',
      projectId: 'proj-1',
      workingDirectory: '/tmp/ws-new',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
    });
    const api = createApiMock({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new', projectId: 'proj-1' }),
      getWorkspaces: vi.fn().mockResolvedValue([newWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ hiddenProjectIds: new Set(['proj-1']) });

    await useWorkspacesStore.getState().createWorkspace({
      mode: 'directory',
      directoryPath: '/tmp/ws-new',
    });

    expect(useWorkspacesStore.getState().hiddenProjectIds.has('proj-1')).toBe(false);
    expect(api.updateConfig).toHaveBeenCalledWith({ hiddenProjectIds: [] });
  });

  it('auto-expands the project group when creating a workspace in a collapsed project', async () => {
    const newWs = createWorkspace({
      id: 'ws-new',
      projectId: 'proj-1',
      workingDirectory: '/tmp/ws-new',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
    });
    const api = createApiMock({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new', projectId: 'proj-1' }),
      getWorkspaces: vi.fn().mockResolvedValue([newWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    // Project exists but is collapsed (not in expandedProjectIds)
    useProjectsStore.setState({
      projects: [{ id: 'proj-1', name: 'Proj 1', order: 0 }] as any,
      expandedProjectIds: new Set(),
    });

    await useWorkspacesStore.getState().createWorkspace({
      mode: 'directory',
      directoryPath: '/tmp/ws-new',
    });

    expect(useProjectsStore.getState().expandedProjectIds.has('proj-1')).toBe(true);
  });

  it('does not touch hiddenProjectIds when the new workspace has no projectId', async () => {
    const newWs = createWorkspace({
      id: 'ws-new',
      workingDirectory: '/tmp/ws-new',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
    });
    const api = createApiMock({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
      getWorkspaces: vi.fn().mockResolvedValue([newWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ hiddenProjectIds: new Set(['proj-1']) });

    await useWorkspacesStore.getState().createWorkspace({
      mode: 'directory',
      directoryPath: '/tmp/ws-new',
    });

    expect(useWorkspacesStore.getState().hiddenProjectIds.has('proj-1')).toBe(true);
    expect(api.updateConfig).not.toHaveBeenCalled();
  });

  it('does not auto-focus new workspace when initialPrompt is provided and another workspace is selected', async () => {
    const existingWs = createWorkspace({
      id: 'ws-existing',
      terminals: [createTerminal({ id: 'term-existing' })],
    });
    const newWs = createWorkspace({
      id: 'ws-new',
      workingDirectory: '/tmp/ws-new',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
    });
    const api = createApiMock({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
      getWorkspaces: vi.fn().mockResolvedValue([existingWs, newWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [existingWs], selectedWorkspaceId: 'ws-existing' });

    await useWorkspacesStore.getState().createWorkspace({
      mode: 'directory',
      directoryPath: '/tmp/ws-new',
      initialPrompt: 'do something',
    });

    // Should stay on the existing workspace
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-existing');
  });

  it('auto-focuses new workspace with initialPrompt when no workspace is selected', async () => {
    const newWs = createWorkspace({
      id: 'ws-new',
      workingDirectory: '/tmp/ws-new',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
    });
    const api = createApiMock({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
      getWorkspaces: vi.fn().mockResolvedValue([newWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [], selectedWorkspaceId: null });

    await useWorkspacesStore.getState().createWorkspace({
      mode: 'directory',
      directoryPath: '/tmp/ws-new',
      initialPrompt: 'do something',
    });

    // Should auto-focus since nothing was selected
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-new');
  });

  it('strips attention but keeps an unread mark on the selected workspace on loadWorkspaces', async () => {
    const ws1 = createWorkspace({
      id: 'ws-1',
      needsAttention: true,
      attention: { kind: 'input-required', source: 'claude-code', updatedAt: 1000 },
      unread: { reason: 'marked', at: 500 },
    });
    const ws2 = createWorkspace({
      id: 'ws-2',
      needsAttention: true,
      attention: { kind: 'input-required', source: 'claude-code', updatedAt: 2000 },
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([ws1, ws2]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-1' });
    await useWorkspacesStore.getState().loadWorkspaces();

    const workspaces = useWorkspacesStore.getState().workspaces;
    // Selected workspace should have attention cleared; marked unread here, it shows once left
    expect(workspaces[0]?.needsAttention).toBe(false);
    expect(workspaces[0]?.attention).toBeUndefined();
    expect(workspaces[0]?.unread).toEqual({ reason: 'marked', at: 500 });
    // Non-selected workspace should retain attention
    expect(workspaces[1]?.needsAttention).toBe(true);
    expect(workspaces[1]?.attention?.kind).toBe('input-required');
  });

  it('preserves terminal-scoped attention on the selected workspace until its tab is opened', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const attention = {
      kind: 'input-required' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: terminal.id,
    };
    const ws = createWorkspace({
      id: 'ws-1',
      needsAttention: true,
      attention,
      terminals: [{ ...terminal, attention }],
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([ws]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-1' });
    await useWorkspacesStore.getState().loadWorkspaces();

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.needsAttention).toBe(true);
    expect(workspace?.attention).toEqual(attention);
    expect(workspace?.terminals[0]?.attention).toEqual(attention);
  });

  it('clears informational terminal-scoped attention from the selected workspace card', async () => {
    const terminal = createTerminal({ id: 'term-1' });
    const attention = {
      kind: 'turn-complete' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: terminal.id,
    };
    const ws = createWorkspace({
      id: 'ws-1',
      needsAttention: true,
      attention,
      terminals: [{ ...terminal, attention }],
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([ws]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ selectedWorkspaceId: 'ws-1' });
    await useWorkspacesStore.getState().loadWorkspaces();

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.needsAttention).toBe(false);
    expect(workspace?.attention).toBeUndefined();
    expect(workspace?.terminals[0]?.attention).toEqual(attention);
  });

  it('stores informational terminal attention without selected workspace card attention', () => {
    const terminal = createTerminal({ id: 'term-1' });
    const ws = createWorkspace({
      id: 'ws-1',
      terminals: [terminal],
    });
    const attention = {
      kind: 'generic' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: terminal.id,
    };

    useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-1' });
    useWorkspacesStore.getState().setAttention('ws-1', attention, attention);

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.needsAttention).toBe(false);
    expect(workspace?.attention).toBeUndefined();
    expect(workspace?.terminals[0]?.attention).toEqual(attention);
  });

  it('keeps informational terminal attention on the selected workspace card while unfocused', () => {
    const terminal = createTerminal({ id: 'term-1' });
    const ws = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const attention = {
      kind: 'turn-complete' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: terminal.id,
    };

    useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-1' });
    useWorkspacesStore.getState().setAttention('ws-1', attention, attention, {
      windowFocused: false,
    });

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.needsAttention).toBe(true);
    expect(workspace?.attention).toEqual(attention);
    expect(workspace?.terminals[0]?.attention).toEqual(attention);
  });

  it('keeps actionable terminal attention on the selected workspace card', () => {
    const terminal = createTerminal({ id: 'term-1' });
    const ws = createWorkspace({
      id: 'ws-1',
      terminals: [terminal],
    });
    const attention = {
      kind: 'input-required' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: terminal.id,
    };

    useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-1' });
    useWorkspacesStore.getState().setAttention('ws-1', attention, attention);

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.needsAttention).toBe(true);
    expect(workspace?.attention).toEqual(attention);
    expect(workspace?.terminals[0]?.attention).toEqual(attention);
  });

  it("shows another terminal's prompt that Komla keeps on the card", () => {
    const terminal1 = createTerminal({ id: 'term-1' });
    const terminal2 = createTerminal({ id: 'term-2' });
    const existingAttention = {
      kind: 'input-required' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: terminal1.id,
    };
    const incomingAttention = {
      kind: 'turn-complete' as const,
      source: 'codex' as const,
      updatedAt: 2000,
      terminalId: terminal2.id,
    };
    const ws = createWorkspace({
      id: 'ws-1',
      attention: existingAttention,
      needsAttention: true,
      terminals: [{ ...terminal1, attention: existingAttention }, terminal2],
    });

    useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-1' });
    useWorkspacesStore.getState().setAttention('ws-1', incomingAttention, existingAttention);

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.needsAttention).toBe(true);
    expect(workspace?.attention).toEqual(existingAttention);
    expect(workspace?.terminals.find((t) => t.id === terminal1.id)?.attention).toEqual(
      existingAttention
    );
    expect(workspace?.terminals.find((t) => t.id === terminal2.id)?.attention).toEqual(
      incomingAttention
    );
  });

  it("shows another terminal's done that Komla keeps over an idle reminder", () => {
    const terminal1 = createTerminal({ id: 'term-1' });
    const terminal2 = createTerminal({ id: 'term-2' });
    const existingAttention = {
      kind: 'turn-complete' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: terminal1.id,
    };
    const incomingAttention = {
      kind: 'idle' as const,
      source: 'codex' as const,
      updatedAt: 2000,
      terminalId: terminal2.id,
    };
    const ws = createWorkspace({
      id: 'ws-1',
      attention: existingAttention,
      needsAttention: true,
      terminals: [{ ...terminal1, attention: existingAttention }, terminal2],
    });

    useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-2' });
    useWorkspacesStore.getState().setAttention('ws-1', incomingAttention, existingAttention);

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.needsAttention).toBe(true);
    expect(workspace?.attention).toEqual(existingAttention);
    expect(workspace?.terminals.find((t) => t.id === terminal2.id)?.attention).toEqual(
      incomingAttention
    );
  });

  it('keeps the selected card quiet when idle follows another terminal done', () => {
    const doneAttention = {
      kind: 'turn-complete' as const,
      source: 'claude-code' as const,
      updatedAt: 1000,
      terminalId: 'term-1',
    };
    const ws = createWorkspace({
      id: 'ws-1',
      attention: doneAttention,
      needsAttention: true,
      terminals: [
        createTerminal({ id: 'term-1', attention: doneAttention }),
        createTerminal({ id: 'term-2' }),
      ],
    });

    useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-1' });
    const idleAttention = {
      kind: 'idle' as const,
      source: 'codex' as const,
      updatedAt: 2000,
      terminalId: 'term-2',
    };
    useWorkspacesStore.getState().setAttention('ws-1', idleAttention, doneAttention);

    const workspace = useWorkspacesStore.getState().workspaces[0];
    expect(workspace?.attention).toBeUndefined();
    expect(workspace?.needsAttention).toBe(false);
  });

  it('markUnread marks a workspace until it is next opened', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1' }), createWorkspace({ id: 'ws-2' })],
      selectedWorkspaceId: 'ws-2',
    });

    useWorkspacesStore.getState().markUnread('ws-1');
    expect(useWorkspacesStore.getState().workspaces[0]?.unread).toEqual({
      reason: 'marked',
      at: 5_000,
    });
    expect(api.updateWorkspace).toHaveBeenCalledWith('ws-1', {
      unread: { reason: 'marked', at: 5_000 },
    });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');
    vi.advanceTimersByTime(500);
    expect(useWorkspacesStore.getState().workspaces[0]?.unread).toBeUndefined();
    expect(api.updateWorkspace).toHaveBeenLastCalledWith('ws-1', { unread: undefined });
  });

  it('keeps an unread mark when its workspace is only passed through', async () => {
    vi.useFakeTimers();
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const unread = { reason: 'marked', at: 1_000 } as const;
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1', unread }), createWorkspace({ id: 'ws-2' })],
      selectedWorkspaceId: 'ws-2',
    });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');
    await useWorkspacesStore.getState().selectWorkspace('ws-2');
    vi.advanceTimersByTime(500);

    expect(useWorkspacesStore.getState().workspaces[0]?.unread).toEqual(unread);
    expect(api.updateWorkspace).not.toHaveBeenCalledWith('ws-1', { unread: undefined });
  });

  it('dismissWokeIfOpen clears a snooze ending on the open workspace only', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const woke = { reason: 'snooze-ended', at: 1_000 } as const;
    const marked = { reason: 'marked', at: 1_000 } as const;
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({ id: 'ws-1', unread: woke }),
        createWorkspace({ id: 'ws-2', unread: woke }),
      ],
      selectedWorkspaceId: 'ws-1',
    });
    const { dismissWokeIfOpen } = useWorkspacesStore.getState();

    dismissWokeIfOpen('ws-2');
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    useWorkspacesStore.getState().updateWorkspace('ws-1', { unread: marked });
    dismissWokeIfOpen('ws-1');
    expect(api.updateWorkspace).not.toHaveBeenCalled();

    useWorkspacesStore.getState().updateWorkspace('ws-1', { unread: woke });
    dismissWokeIfOpen('ws-1');
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.unread)).toEqual([
      undefined,
      woke,
    ]);
    expect(api.updateWorkspace).toHaveBeenCalledWith('ws-1', { unread: undefined });
  });

  it('receiveWorkspaceMarks applies marks at once and tells when the open workspace just woke', () => {
    const woke = { reason: 'snooze-ended', at: 1_000 } as const;
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({ id: 'ws-1', snoozedUntil: 1_000 }),
        createWorkspace({ id: 'ws-2', snoozedUntil: 1_000 }),
      ],
      selectedWorkspaceId: 'ws-1',
    });
    const { receiveWorkspaceMarks } = useWorkspacesStore.getState();

    expect(receiveWorkspaceMarks(createWorkspace({ id: 'ws-2', unread: woke }))).toBe(false);
    expect(receiveWorkspaceMarks(createWorkspace({ id: 'ws-1', unread: woke }))).toBe(true);
    // Later updates of the same workspace don't wake it again.
    expect(receiveWorkspaceMarks(createWorkspace({ id: 'ws-1', unread: woke }))).toBe(false);
    const marks = useWorkspacesStore.getState().workspaces.map((w) => [w.unread, w.snoozedUntil]);
    expect(marks).toEqual([
      [woke, undefined],
      [woke, undefined],
    ]);
  });

  it('setPinned pins and unpins', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: 'ws-1' })] });

    useWorkspacesStore.getState().setPinned('ws-1', true);
    expect(useWorkspacesStore.getState().workspaces[0]?.pinned).toBe(true);
    expect(api.updateWorkspace).toHaveBeenLastCalledWith('ws-1', { pinned: true });

    useWorkspacesStore.getState().setPinned('ws-1', false);
    expect(useWorkspacesStore.getState().workspaces[0]?.pinned).toBeUndefined();
    expect(api.updateWorkspace).toHaveBeenLastCalledWith('ws-1', { pinned: undefined });
  });

  it('snoozeWorkspace snoozes until a time, dropping an unread mark, and wakes when cleared', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1', unread: { reason: 'marked', at: 1_000 } })],
    });

    useWorkspacesStore.getState().snoozeWorkspace('ws-1', 60_000);
    expect(useWorkspacesStore.getState().workspaces[0]?.snoozedUntil).toBe(60_000);
    expect(useWorkspacesStore.getState().workspaces[0]?.unread).toBeUndefined();
    expect(api.updateWorkspace).toHaveBeenLastCalledWith('ws-1', {
      snoozedUntil: 60_000,
      unread: undefined,
    });

    useWorkspacesStore.getState().snoozeWorkspace('ws-1', undefined);
    expect(useWorkspacesStore.getState().workspaces[0]?.snoozedUntil).toBeUndefined();
    expect(api.updateWorkspace).toHaveBeenLastCalledWith('ws-1', { snoozedUntil: undefined });
  });

  it('setDefaultAction saves a changed default and skips an unchanged one', () => {
    const ws = createWorkspace({ id: 'ws-1', defaultActionId: 'action-1' });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ workspaces: [ws] });

    useWorkspacesStore.getState().setDefaultAction('ws-1', 'action-1');
    expect(api.updateWorkspace).not.toHaveBeenCalled();

    useWorkspacesStore.getState().setDefaultAction('ws-1', 'action-2');
    expect(useWorkspacesStore.getState().workspaces[0]?.defaultActionId).toBe('action-2');
    expect(api.updateWorkspace).toHaveBeenCalledWith('ws-1', { defaultActionId: 'action-2' });
  });

  it('setPaneDefaultAction saves the right-click default apart from the run button one', () => {
    const ws = createWorkspace({ id: 'ws-1', defaultActionId: 'action-1' });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({ workspaces: [ws] });

    useWorkspacesStore.getState().setPaneDefaultAction('ws-1', 'action-2');
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      defaultActionId: 'action-1',
      paneDefaultActionId: 'action-2',
    });
    expect(api.updateWorkspace).toHaveBeenCalledWith('ws-1', { paneDefaultActionId: 'action-2' });

    useWorkspacesStore.getState().setPaneDefaultAction('ws-1', 'action-2');
    expect(api.updateWorkspace).toHaveBeenCalledTimes(1);
  });

  it('persists stopped workspace visibility for new windows', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.getState().setHideStopped(true);

    expect(useWorkspacesStore.getState().hideStopped).toBe(true);
    expect(api.updateConfig).toHaveBeenCalledWith({ hideStoppedWorkspaces: true });
  });

  it('persists the sidebar grouping', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.getState().setGrouping('none');

    expect(useWorkspacesStore.getState().grouping).toBe('none');
    expect(api.updateConfig).toHaveBeenCalledWith({ workspaceGrouping: 'none' });
  });

  it('drops stopped workspaces from the multi-selection when hiding them', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({ id: 'stopped' }),
        createWorkspace({
          id: 'running',
          terminals: [createTerminal({ id: 'term-1', status: 'running' })],
        }),
      ],
      selectionMode: true,
      selectedWorkspaceIds: new Set(['stopped', 'running']),
    });

    useWorkspacesStore.getState().setHideStopped(true);

    expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['running']));
    expect(useWorkspacesStore.getState().selectionMode).toBe(true);
  });

  it('persists hiding working workspaces', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.getState().setHideWorking(true);

    expect(useWorkspacesStore.getState().hideWorking).toBe(true);
    expect(api.updateConfig).toHaveBeenCalledWith({ hideWorkingWorkspaces: true });
  });

  it('drops workspaces from the multi-selection, leaving it once none are left', () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'a' }), createWorkspace({ id: 'b' })],
      selectionMode: true,
      selectedWorkspaceIds: new Set(['a', 'b']),
    });

    useWorkspacesStore.getState().deselectWorkspaces(['a']);
    expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['b']));
    expect(useWorkspacesStore.getState().selectionMode).toBe(true);

    useWorkspacesStore.getState().deselectWorkspaces(['b']);
    expect(useWorkspacesStore.getState().selectionMode).toBe(false);
  });

  it('persists independent sidebar and dashboard host visibility', () => {
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.getState().toggleWorkspaceHostVisibility('ssh-devbox');
    useWorkspacesStore.getState().toggleDashboardWorkspaceHostVisibility('local');

    expect(useWorkspacesStore.getState().hiddenWorkspaceHostIds).toEqual(new Set(['ssh-devbox']));
    expect(useWorkspacesStore.getState().dashboardHiddenWorkspaceHostIds).toEqual(
      new Set(['local'])
    );
    expect(api.updateConfig).toHaveBeenCalledWith({ hiddenWorkspaceHostIds: ['ssh-devbox'] });
    expect(api.updateConfig).toHaveBeenCalledWith({ dashboardHiddenWorkspaceHostIds: ['local'] });

    useWorkspacesStore.getState().showAllWorkspaceHosts();
    useWorkspacesStore.getState().showAllDashboardWorkspaceHosts();
    expect(useWorkspacesStore.getState().hiddenWorkspaceHostIds.size).toBe(0);
    expect(useWorkspacesStore.getState().dashboardHiddenWorkspaceHostIds.size).toBe(0);
    expect(api.updateConfig).toHaveBeenCalledWith({ hiddenWorkspaceHostIds: [] });
    expect(api.updateConfig).toHaveBeenCalledWith({ dashboardHiddenWorkspaceHostIds: [] });
  });

  it('auto-unhides the sidebar host when selecting one of its workspaces', async () => {
    const ws = createWorkspace({
      id: 'ws-1',
      provisioning: true,
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
    });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useWorkspacesStore.setState({
      workspaces: [ws],
      hiddenWorkspaceHostIds: new Set(['ssh-devbox', 'ssh-other']),
    });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');

    expect(useWorkspacesStore.getState().hiddenWorkspaceHostIds).toEqual(new Set(['ssh-other']));
    expect(api.updateConfig).toHaveBeenCalledWith({
      hiddenWorkspaceHostIds: ['ssh-other'],
    });
  });

  it('keeps the active workspace but reconciles bulk selection for dashboard hosts', () => {
    const remoteWorkspace = createWorkspace({
      id: 'remote',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
    });
    useWorkspacesStore.setState({
      workspaces: [remoteWorkspace],
      selectedWorkspaceId: 'remote',
      selectionMode: true,
      selectedWorkspaceIds: new Set(['remote']),
      lastSelectedWorkspaceId: 'remote',
    });

    useWorkspacesStore.getState().toggleDashboardWorkspaceHostVisibility('ssh-devbox');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('remote');
    expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    expect(useWorkspacesStore.getState().selectedWorkspaceIds.size).toBe(0);
    expect(useWorkspacesStore.getState().lastSelectedWorkspaceId).toBeNull();
    expect(useWorkspacesStore.getState().hiddenWorkspaceHostIds.size).toBe(0);
  });

  it('removes workspaces on a newly hidden host from bulk selection', () => {
    const localWorkspace = createWorkspace({ id: 'local' });
    const remoteWorkspace = createWorkspace({
      id: 'remote',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
    });
    useWorkspacesStore.setState({
      workspaces: [localWorkspace, remoteWorkspace],
      selectionMode: true,
      selectedWorkspaceIds: new Set(['local', 'remote']),
      lastSelectedWorkspaceId: 'remote',
    });

    useWorkspacesStore.getState().toggleWorkspaceHostVisibility('ssh-devbox');

    expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['local']));
    expect(useWorkspacesStore.getState().selectionMode).toBe(true);
    expect(useWorkspacesStore.getState().lastSelectedWorkspaceId).toBeNull();

    useWorkspacesStore.getState().toggleWorkspaceHostVisibility('local');

    expect(useWorkspacesStore.getState().selectedWorkspaceIds.size).toBe(0);
    expect(useWorkspacesStore.getState().selectionMode).toBe(false);
  });

  it('keeps a hidden tag hidden under its new name, and forgets ones no longer around', () => {
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1', tag: 'Waiting for QA' })],
      hiddenWorkspaceTags: new Set(['gone']),
    });

    useWorkspacesStore.getState().toggleWorkspaceTagShown('Waiting for QA');
    expect(useWorkspacesStore.getState().hiddenWorkspaceTags).toEqual(new Set(['waiting for qa']));

    // Renamed: the workspace already has the new name.
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1', tag: 'QA' })],
    });
    useWorkspacesStore.getState().moveHiddenWorkspaceTag('Waiting for QA', 'QA');
    expect(useWorkspacesStore.getState().hiddenWorkspaceTags).toEqual(new Set(['qa']));
    expect(window.api.updateConfig).toHaveBeenLastCalledWith({ hiddenWorkspaceTags: ['qa'] });

    useWorkspacesStore.getState().moveHiddenWorkspaceTag('QA', undefined);
    expect(useWorkspacesStore.getState().hiddenWorkspaceTags.size).toBe(0);
  });

  it('sets every hidden tag at once, by key', () => {
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({ id: 'ws-1', tag: 'Blocked' }),
        createWorkspace({ id: 'ws-2', tag: 'In review' }),
      ],
      hiddenWorkspaceTags: new Set(['in review']),
    });

    useWorkspacesStore.getState().setHiddenWorkspaceTags(['Blocked', '']);
    expect(useWorkspacesStore.getState().hiddenWorkspaceTags).toEqual(new Set(['blocked', '']));

    useWorkspacesStore.getState().setHiddenWorkspaceTags([]);
    expect(useWorkspacesStore.getState().hiddenWorkspaceTags.size).toBe(0);
  });

  it('keeps Untagged hidden whatever tags are around', () => {
    useWorkspacesStore.setState({ workspaces: [], hiddenWorkspaceTags: new Set() });

    useWorkspacesStore.getState().toggleWorkspaceTagShown('');
    expect(useWorkspacesStore.getState().hiddenWorkspaceTags).toEqual(new Set(['']));
    expect(window.api.updateConfig).toHaveBeenLastCalledWith({ hiddenWorkspaceTags: [''] });

    useWorkspacesStore.getState().toggleWorkspaceTagShown('');
    expect(useWorkspacesStore.getState().hiddenWorkspaceTags.size).toBe(0);
  });

  it('clears the active workspace when its host is hidden', () => {
    const remoteWorkspace = createWorkspace({
      id: 'remote',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-devbox',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
    });
    useWorkspacesStore.setState({
      workspaces: [remoteWorkspace],
      selectedWorkspaceId: remoteWorkspace.id,
    });

    useWorkspacesStore.getState().toggleWorkspaceHostVisibility('ssh-devbox');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
  });

  describe('failures of actions the user started', () => {
    const toastMessages = () =>
      useToastStore
        .getState()
        .toasts.filter((toast) => toast.type === 'error')
        .map((toast) => toast.message);
    const ipcError = (channel: string, message: string) =>
      new Error(`Error invoking remote method '${channel}': Error: ${message}`);

    it('says why a stopped workspace could not start', async () => {
      const stopped = createWorkspace({
        id: 'ws-1',
        name: 'api',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const api = createApiMock({
        restartWorkspace: vi
          .fn()
          .mockRejectedValue(ipcError('workspace:restart', 'spawn claude ENOENT')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [stopped] });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await useWorkspacesStore.getState().selectWorkspace('ws-1');

      expect(toastMessages()).toEqual(['Failed to start workspace "api": spawn claude ENOENT']);
    });

    it('says why a workspace could not restart', async () => {
      const api = createApiMock({
        restartWorkspace: vi.fn().mockRejectedValue(ipcError('workspace:restart', 'host down')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: 'ws-1', name: 'api' })] });

      await expect(useWorkspacesStore.getState().restartWorkspace('ws-1')).rejects.toThrow();

      expect(toastMessages()).toEqual(['Failed to restart workspace "api": host down']);
    });

    it('says why a workspace could not stop', async () => {
      const running = createWorkspace({ id: 'ws-1', name: 'api' });
      const api = createApiMock({
        stopWorkspace: vi.fn().mockRejectedValue(ipcError('workspace:stop', 'busy')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [running] });

      await useWorkspacesStore.getState().stopWorkspace('ws-1');

      expect(toastMessages()).toEqual(['Failed to stop workspace "api": busy']);
    });

    it('sums up the workspaces a bulk stop could not stop in one toast', async () => {
      const api = createApiMock({
        stopWorkspace: vi.fn().mockRejectedValue(ipcError('workspace:stop', 'busy')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws-1', name: 'api', terminalCount: 1 }),
          createWorkspace({ id: 'ws-2', name: 'web', terminalCount: 1 }),
        ],
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      await useWorkspacesStore.getState().stopSelectedWorkspaces();

      expect(api.stopWorkspace).toHaveBeenCalledTimes(2);
      expect(toastMessages()).toEqual(['Failed to stop 2 workspaces. First error: busy']);
    });

    it('sums up the workspaces a bulk move could not move in one toast', async () => {
      const api = createApiMock({
        moveWorkspaceToWindow: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValue(ipcError('workspace:move-to-window', 'window closed')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws-1', name: 'api' }),
          createWorkspace({ id: 'ws-2', name: 'web' }),
          createWorkspace({ id: 'ws-3', name: 'docs' }),
        ],
      });

      await useWorkspacesStore
        .getState()
        .moveWorkspacesToWindow(['ws-1', 'ws-2', 'ws-3'], 'window-2');

      expect(api.moveWorkspaceToWindow).toHaveBeenCalledTimes(3);
      expect(toastMessages()).toEqual([
        'Failed to move 2 workspaces to another window. First error: window closed',
      ]);
    });

    it('says which workspace a bulk move could not move when only one failed', async () => {
      const api = createApiMock({
        moveWorkspaceToWindow: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValue(ipcError('workspace:move-to-window', 'window closed')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws-1', name: 'api' }),
          createWorkspace({ id: 'ws-2', name: 'web' }),
        ],
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      await useWorkspacesStore.getState().moveSelectedToWindow('window-2');

      expect(toastMessages()).toEqual([
        'Failed to move workspace "web" to another window: window closed',
      ]);
    });

    it('says why a dragged workspace went back', async () => {
      const api = createApiMock({
        reorderWorkspace: vi.fn().mockRejectedValue(ipcError('workspace:reorder', 'disk full')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [createWorkspace({ id: 'ws-1' }), createWorkspace({ id: 'ws-2' })],
      });

      await useWorkspacesStore.getState().reorderWorkspace('ws-1', 1);

      expect(toastMessages()).toEqual(['Failed to move workspace: disk full']);
    });

    it('says why a terminal could not become primary', async () => {
      const api = createApiMock({
        updateWorkspace: vi.fn().mockRejectedValue(ipcError('workspace:update', 'disk full')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: 'ws-1' })] });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await useWorkspacesStore.getState().setPrimaryTerminal('ws-1', 'term-1');

      expect(toastMessages()).toEqual(['Failed to set the primary terminal: disk full']);
    });

    it('says why a workspace could not move to another window', async () => {
      const api = createApiMock({
        moveWorkspaceToWindow: vi
          .fn()
          .mockRejectedValue(ipcError('workspace:move-to-window', 'window closed')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [createWorkspace({ id: 'ws-1', name: 'api' })] });

      await useWorkspacesStore.getState().moveWorkspaceToWindow('ws-1', 'window-2');

      expect(toastMessages()).toEqual([
        'Failed to move workspace "api" to another window: window closed',
      ]);
    });

    it('says why an SSH workspace could not open when its hosts fail to load', async () => {
      const workspace = createSshWorkspace({
        id: 'ssh-ws',
        name: 'remote',
        terminals: [createTerminal({ status: 'stopped', remoteSessionResumable: true })],
      });
      const api = createApiMock({
        listSshHosts: vi.fn().mockRejectedValue(ipcError('ssh-hosts:list', 'database locked')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [workspace] });

      await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

      expect(toastMessages()).toHaveLength(1);
      expect(toastMessages()[0]).toContain('database locked');
    });

    it('says why an SSH workspace whose host is gone could not open', async () => {
      const workspace = createSshWorkspace({
        id: 'ssh-ws',
        name: 'remote',
        terminals: [createTerminal({ status: 'stopped', remoteSessionResumable: true })],
      });
      const api = createApiMock({
        recoverSshSessions: vi
          .fn()
          .mockRejectedValue(ipcError('workspace:recover-ssh-sessions', 'manifest unreadable')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useSshHostsStore.setState({ hosts: [], hasLoaded: true });
      useWorkspacesStore.setState({ workspaces: [workspace] });

      await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

      expect(toastMessages()).toEqual(['Failed to open workspace "remote": manifest unreadable']);
    });
  });

  describe('hideProjectGroup / unhideProjectGroup', () => {
    it('adds project ID to hiddenProjectIds and persists via updateConfig', () => {
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.getState().hideProjectGroup('proj-1');

      expect(useWorkspacesStore.getState().hiddenProjectIds.has('proj-1')).toBe(true);
      expect(api.updateConfig).toHaveBeenCalledWith({ hiddenProjectIds: ['proj-1'] });
    });

    it('deselects the active workspace when its project is hidden', () => {
      const ws = createWorkspace({ id: 'ws-1', projectId: 'proj-1' });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-1' });
      useWorkspacesStore.getState().hideProjectGroup('proj-1');

      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    });

    it('does not deselect when a different project is hidden', () => {
      const ws = createWorkspace({ id: 'ws-1', projectId: 'proj-1' });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ workspaces: [ws], selectedWorkspaceId: 'ws-1' });
      useWorkspacesStore.getState().hideProjectGroup('proj-2');

      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
    });

    it('drops workspaces of a hidden project from the multi-selection', () => {
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws-1', projectId: 'proj-1' }),
          createWorkspace({ id: 'ws-2', projectId: 'proj-2' }),
        ],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
        lastSelectedWorkspaceId: 'ws-1',
      });
      useWorkspacesStore.getState().hideProjectGroup('proj-1');

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-2']));
      expect(useWorkspacesStore.getState().selectionMode).toBe(true);
      expect(useWorkspacesStore.getState().lastSelectedWorkspaceId).toBeNull();

      useWorkspacesStore.getState().hideProjectGroup('proj-2');

      expect(useWorkspacesStore.getState().selectedWorkspaceIds.size).toBe(0);
      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    });

    it('hides several projects with one config write, deselecting their workspaces', () => {
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [
          createWorkspace({ id: 'ws-1', projectId: 'proj-1' }),
          createWorkspace({ id: 'ws-2', projectId: 'proj-2' }),
        ],
        selectedWorkspaceId: 'ws-2',
        hiddenProjectIds: new Set(['proj-3']),
      });
      useWorkspacesStore.getState().hideProjectGroups(['proj-1', 'proj-2']);

      expect(useWorkspacesStore.getState().hiddenProjectIds).toEqual(
        new Set(['proj-3', 'proj-1', 'proj-2'])
      );
      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
      expect(api.updateConfig).toHaveBeenCalledTimes(1);
    });

    it('unhides several projects with one config write', () => {
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ hiddenProjectIds: new Set(['proj-1', 'proj-2', 'proj-3']) });
      useWorkspacesStore.getState().unhideProjectGroups(['proj-1', 'proj-3']);

      expect(useWorkspacesStore.getState().hiddenProjectIds).toEqual(new Set(['proj-2']));
      expect(api.updateConfig).toHaveBeenCalledTimes(1);
      expect(api.updateConfig).toHaveBeenCalledWith({ hiddenProjectIds: ['proj-2'] });
    });

    it('removes project ID from hiddenProjectIds and persists via updateConfig', () => {
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ hiddenProjectIds: new Set(['proj-1', 'proj-2']) });
      useWorkspacesStore.getState().unhideProjectGroup('proj-1');

      expect(useWorkspacesStore.getState().hiddenProjectIds.has('proj-1')).toBe(false);
      expect(useWorkspacesStore.getState().hiddenProjectIds.has('proj-2')).toBe(true);
      expect(api.updateConfig).toHaveBeenCalledWith({ hiddenProjectIds: ['proj-2'] });
    });

    it('auto-unhides the project when selecting a workspace in a hidden project', async () => {
      const ws = createWorkspace({
        id: 'ws-1',
        projectId: 'proj-1',
        terminals: [createTerminal({ id: 'term-1', status: 'running' })],
      });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws],
        hiddenProjectIds: new Set(['proj-1']),
      });

      await useWorkspacesStore.getState().selectWorkspace('ws-1');

      expect(useWorkspacesStore.getState().hiddenProjectIds.has('proj-1')).toBe(false);
      expect(api.updateConfig).toHaveBeenCalledWith({ hiddenProjectIds: [] });
    });

    it('does not expand a collapsed project when selecting an existing workspace in it', async () => {
      const ws = createWorkspace({
        id: 'ws-1',
        projectId: 'proj-1',
        terminals: [createTerminal({ id: 'term-1', status: 'running' })],
      });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ workspaces: [ws] });
      // Project collapsed: not in expandedProjectIds
      useProjectsStore.setState({
        projects: [{ id: 'proj-1', name: 'Proj 1', order: 0 }] as any,
        expandedProjectIds: new Set(),
      });

      await useWorkspacesStore.getState().selectWorkspace('ws-1');

      expect(useProjectsStore.getState().expandedProjectIds.has('proj-1')).toBe(false);
    });
  });

  it('routes SSH reconnection through the dedicated preload API', async () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-1', status: 'stopped' })],
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([workspace]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    await useWorkspacesStore.getState().reconnectSshTerminal('term-1', 120, 30);

    expect(api.reconnectSshTerminal).toHaveBeenCalledWith('term-1', 120, 30);
    expect(api.restartTerminal).not.toHaveBeenCalled();
  });

  it('tells the user when reconnecting one SSH pane fails', async () => {
    const api = createApiMock({
      reconnectSshTerminal: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'workspace:reconnect-ssh-terminal': Error: ssh: connect to host devbox port 22: Network is unreachable"
          )
        ),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await useWorkspacesStore.getState().reconnectSshTerminal('term-1', 120, 30);

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'Could not reconnect: ssh: connect to host devbox port 22: Network is unreachable',
      }),
    ]);
  });

  it('offers the upgrade dialog when the free limit stops reconnecting one SSH pane', async () => {
    const api = createApiMock({
      reconnectSshTerminal: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'workspace:reconnect-ssh-terminal': Error: WORKSPACE_LIMIT:Free plan is limited to 4 running SSH workspaces."
          )
        ),
    });
    const dispatchEvent = vi.fn();
    (globalThis as { window: { api: ApiMock; dispatchEvent: typeof dispatchEvent } }).window = {
      api,
      dispatchEvent,
    };
    useWorkspacesStore.setState({ error: null });

    await useWorkspacesStore.getState().reconnectSshTerminal('term-1', 120, 30);

    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useWorkspacesStore.getState().error).toBeNull();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<{ retry?: () => void }>;
    expect(event.type).toBe('show-upgrade-dialog');

    api.reconnectSshTerminal.mockResolvedValue({ id: 'term-1' });
    event.detail.retry?.();
    expect(api.reconnectSshTerminal).toHaveBeenLastCalledWith('term-1', 120, 30);
  });

  it('forwards explicit pane replacement and surfaces restart failures', async () => {
    const failure = new Error('remote session could not be stopped');
    const api = createApiMock({ restartTerminal: vi.fn().mockRejectedValue(failure) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await expect(
      useWorkspacesStore.getState().restartTerminal('term-1', 'preset-1', 'plan', 120, 30, {
        replaceSession: true,
      })
    ).rejects.toBe(failure);

    expect(api.restartTerminal).toHaveBeenCalledWith('term-1', 'preset-1', 'plan', 120, 30, {
      replaceSession: true,
    });
    expect(useWorkspacesStore.getState().error).toBe(failure.message);
  });

  it('reconnects every resumable SSH pane unless its tmux session is confirmed ended', async () => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'https://github.com/example/repo.git',
        projectName: 'repo',
      },
      terminals: [
        createTerminal({
          id: 'term-1',
          status: 'stopped',
          remoteSessionActive: true,
          remoteSessionResumable: true,
        }),
        createTerminal({
          id: 'term-2',
          status: 'stopped',
          remoteSessionResumable: true,
        }),
        createTerminal({
          id: 'term-ended',
          status: 'stopped',
          remoteSessionActive: false,
          remoteSessionResumable: true,
        }),
      ],
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([workspace]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    await useWorkspacesStore.getState().reconnectAllSshTerminals(workspace.id);

    expect(api.reconnectSshTerminal).toHaveBeenCalledTimes(2);
    expect(api.reconnectSshTerminal).toHaveBeenCalledWith('term-1', undefined, undefined);
    expect(api.reconnectSshTerminal).toHaveBeenCalledWith('term-2', undefined, undefined);
    expect(api.reconnectSshTerminal).not.toHaveBeenCalledWith('term-ended', undefined, undefined);
  });

  it('offers the upgrade dialog when the free limit stops a reconnect to a session on the host', async () => {
    const workspace = createSshWorkspace({
      id: 'ssh-ws',
      terminals: [
        createTerminal({
          id: 'term-elsewhere',
          status: 'stopped',
          remoteSessionOnHost: true,
          remoteSessionResumable: true,
        }),
      ],
    });
    const api = createApiMock({
      getWorkspaces: vi.fn().mockResolvedValue([workspace]),
      reconnectSshTerminal: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'workspace:reconnect-ssh-terminal': Error: WORKSPACE_LIMIT:Free plan is limited to 4 running SSH workspaces."
          )
        ),
    });
    const dispatchEvent = vi.fn();
    (globalThis as { window: { api: ApiMock; dispatchEvent: typeof dispatchEvent } }).window = {
      api,
      dispatchEvent,
    };
    useWorkspacesStore.setState({ workspaces: [workspace], error: null });
    const addToast = vi.spyOn(useToastStore.getState(), 'addToast');

    await useWorkspacesStore.getState().reconnectAllSshTerminals(workspace.id);

    expect(addToast).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().error).toBeNull();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<{ retry?: () => void }>;
    expect(event.type).toBe('show-upgrade-dialog');

    const selectWorkspace = vi.fn();
    useWorkspacesStore.setState({ selectWorkspace });
    event.detail.retry?.();
    expect(selectWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  describe('reconnectAfterNetworkReturns', () => {
    const sshWorkspace = (id: string) =>
      createWorkspace({
        id,
        workingDirectory: `ssh://ssh-dev/home/dev/${id}`,
        backend: {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: `/home/dev/${id}`,
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'https://github.com/example/repo.git',
          projectName: 'repo',
        },
        terminals: [
          createTerminal({
            id: `${id}-term`,
            status: 'stopped',
            remoteSessionActive: true,
            remoteSessionResumable: true,
          }),
        ],
      });

    it('reconnects the detached sessions of the workspace on screen, once', async () => {
      const shown = sshWorkspace('ssh-shown');
      const hidden = sshWorkspace('ssh-hidden');
      const reconnect = createDeferred<{ id: string }>();
      const api = createApiMock({
        reconnectSshTerminal: vi.fn().mockReturnValue(reconnect.promise),
        getWorkspaces: vi.fn().mockResolvedValue([shown, hidden]),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [shown, hidden],
        selectedWorkspaceId: shown.id,
        showDashboard: false,
      });

      const first = useWorkspacesStore.getState().reconnectAfterNetworkReturns();
      expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has(shown.id)).toBe(true);
      // A second "online" while the first attempt runs starts nothing.
      await useWorkspacesStore.getState().reconnectAfterNetworkReturns();
      reconnect.resolve({ id: `${shown.id}-term` });
      await first;

      expect(api.reconnectSshTerminal).toHaveBeenCalledOnce();
      expect(api.reconnectSshTerminal).toHaveBeenCalledWith('ssh-shown-term', undefined, undefined);
      expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has(shown.id)).toBe(false);
    });

    it('leaves a workspace alone while one of its panes is already reconnecting', async () => {
      const shown = sshWorkspace('ssh-busy');
      const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([shown]) });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [shown],
        selectedWorkspaceId: shown.id,
        showDashboard: false,
      });
      claimTerminal('ssh-busy-term', 'reconnect');

      try {
        await useWorkspacesStore.getState().reconnectAfterNetworkReturns();
      } finally {
        releaseTerminal('ssh-busy-term');
      }

      expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    });

    it('leaves workspaces alone while the overview is open', async () => {
      const shown = sshWorkspace('ssh-overview');
      const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([shown]) });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [shown],
        selectedWorkspaceId: shown.id,
        showDashboard: true,
      });

      await useWorkspacesStore.getState().reconnectAfterNetworkReturns();

      expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    });
  });

  it('keeps the workspaces array when selecting a running workspace changes none of them', async () => {
    const workspaces = [
      createWorkspace({ id: 'ws-1', terminals: [createTerminal({ status: 'running' })] }),
      createWorkspace({ id: 'ws-2', terminals: [createTerminal({ status: 'running' })] }),
    ];
    (globalThis as { window: { api: ApiMock } }).window = { api: createApiMock() };
    useWorkspacesStore.setState({ workspaces, selectedWorkspaceId: 'ws-1' });

    await useWorkspacesStore.getState().selectWorkspace('ws-2');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-2');
    expect(useWorkspacesStore.getState().workspaces).toBe(workspaces);
  });

  it('restarts stopped workspace during selection and refreshes selected terminal state', async () => {
    vi.useFakeTimers();
    const stoppedWs = createWorkspace({
      id: 'ws-1',
      needsAttention: true,
      attention: {
        kind: 'input-required',
        source: 'claude-code',
        updatedAt: 1000,
      },
      terminals: [createTerminal({ id: 'term-old', status: 'stopped' })],
      workingDirectory: '/tmp/ws-1',
    });
    const restartedWs = createWorkspace({
      id: 'ws-1',
      needsAttention: true,
      attention: {
        kind: 'input-required',
        source: 'claude-code',
        updatedAt: 1000,
      },
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
      workingDirectory: '/tmp/ws-1',
    });
    const api = createApiMock({
      restartWorkspace: vi
        .fn()
        .mockResolvedValue(createTerminal({ id: 'term-new', status: 'running' })),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [stoppedWs] });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');

    // Attention clearing is deferred — not called yet
    expect(api.clearWorkspaceAttention).not.toHaveBeenCalled();
    expect(api.restartWorkspace).toHaveBeenCalledWith('ws-1');
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
    expect(useWorkspacesStore.getState().workspaces[0]?.terminals[0]?.id).toBe('term-new');
    // Local attention is cleared immediately by clearAttentionForSelected
    expect(useWorkspacesStore.getState().workspaces[0]?.needsAttention).toBe(false);
    expect(useWorkspacesStore.getState().workspaces[0]?.attention).toBeUndefined();

    // After the debounce delay, the IPC call fires
    await flushTimersAndMicrotasks(500);
    expect(api.clearWorkspaceAttention).toHaveBeenCalledWith('ws-1');
  });

  it('optimistically reconnects a restored SSH workspace without probing it first', async () => {
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
      projectName: 'Repo',
    };
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend,
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'stopped',
          remoteSessionResumable: true,
        }),
      ],
    });
    const reconnectedWorkspace = createWorkspace({
      ...workspace,
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'running',
          remoteSessionResumable: true,
        }),
      ],
    });
    const reconnect = createDeferred<void>();
    const api = createApiMock({
      reconnectSshTerminal: vi.fn().mockReturnValue(reconnect.promise),
      getWorkspaces: vi.fn().mockResolvedValue([reconnectedWorkspace]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'ssh-dev',
          name: 'Devbox',
          hostname: 'dev.example.com',
          basePath: '~/.komla',
        },
      ],
      hasLoaded: true,
    });
    useWorkspacesStore.setState({ workspaces: [workspace], showDashboard: true });

    const selection = useWorkspacesStore.getState().selectWorkspace('ssh-ws');
    await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ssh-ws');
    expect(useWorkspacesStore.getState().showDashboard).toBe(false);
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(true);
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).toHaveBeenCalledOnce();
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(true);
    reconnect.resolve();
    await selection;

    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).toHaveBeenCalledWith('term-remote', undefined, undefined);
    expect(useWorkspacesStore.getState().workspaces[0]?.terminals[0]?.status).toBe('running');
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(false);
  });

  it('reconnects rather than restarts a tab that ended here once a sync finds it running on its host', async () => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'stopped',
          remoteSessionActive: false,
          remoteSessionResumable: true,
          // E.g. another device restarted it.
          remoteSessionOnHost: true,
        }),
      ],
    });
    const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([workspace]) });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useSshHostsStore.setState({
      hosts: [{ id: 'ssh-dev', name: 'Devbox', hostname: 'dev.example.com', basePath: '~/.komla' }],
      hasLoaded: true,
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });

    await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).toHaveBeenCalledWith('term-remote', undefined, undefined);
  });

  it('waits for SSH host discovery before marking an inactive workspace unavailable', async () => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      status: 'trashed',
      backend: {
        kind: 'ssh',
        hostId: 'missing-host',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'stopped',
          remoteSessionResumable: true,
        }),
      ],
    });
    const unavailableWorkspace = createWorkspace({
      ...workspace,
      provisionError: 'This workspace’s SSH host is no longer configured.',
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'stopped',
          remoteSessionActive: false,
          remoteSessionResumable: true,
        }),
      ],
    });
    const hosts = createDeferred<[]>();
    const api = createApiMock({
      listSshHosts: vi.fn().mockReturnValue(hosts.promise),
      recoverSshSessions: vi.fn().mockResolvedValue(unavailableWorkspace),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    const selection = useWorkspacesStore.getState().selectWorkspace('ssh-ws');

    await Promise.resolve();
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();

    hosts.resolve([]);
    await selection;

    expect(api.listSshHosts).toHaveBeenCalledOnce();
    expect(api.recoverSshSessions).toHaveBeenCalledWith('ssh-ws');
    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      status: 'trashed',
      provisionError: 'This workspace’s SSH host is no longer configured.',
      terminals: [expect.objectContaining({ remoteSessionActive: false })],
    });
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(false);
  });

  it.each([
    {
      destination: 'another workspace',
      navigate: () => useWorkspacesStore.getState().selectWorkspace('local-ws'),
      selectedWorkspaceId: 'local-ws',
    },
    {
      destination: 'the dashboard',
      navigate: () => useWorkspacesStore.setState({ showDashboard: true }),
      selectedWorkspaceId: 'ssh-ws',
    },
  ])('does not reconnect an SSH workspace after navigating to $destination', async (scenario) => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'stopped',
          remoteSessionResumable: true,
        }),
      ],
    });
    const configuredHost = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: 'dev.example.com',
      basePath: '~/.komla',
    };
    const hosts = createDeferred<(typeof configuredHost)[]>();
    const api = createApiMock({
      listSshHosts: vi.fn().mockReturnValue(hosts.promise),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({
      workspaces: [
        workspace,
        createWorkspace({
          id: 'local-ws',
          terminals: [createTerminal({ status: 'running' })],
        }),
      ],
    });

    const selection = useWorkspacesStore.getState().selectWorkspace('ssh-ws');
    await Promise.resolve();
    await scenario.navigate();
    hosts.resolve([configuredHost]);
    await selection;

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(scenario.selectedWorkspaceId);
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(false);
  });

  it('selects an attached SSH workspace without probing or reconnecting it', async () => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'running',
          remoteSessionResumable: true,
        }),
      ],
    });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'ssh-dev',
          name: 'Devbox',
          hostname: 'dev.example.com',
          basePath: '~/.komla',
        },
      ],
      hasLoaded: true,
    });
    useWorkspacesStore.setState({ workspaces: [workspace], showDashboard: true });

    await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ssh-ws');
    expect(useWorkspacesStore.getState().showDashboard).toBe(false);
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(false);
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
  });

  it('does not restart an SSH workspace that starts while host discovery is pending', async () => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [createTerminal({ id: 'term-remote', status: 'stopped' })],
    });
    const runningTerminal = createTerminal({ id: 'term-remote', status: 'running' });
    const configuredHost = {
      id: 'ssh-dev',
      name: 'Devbox',
      hostname: 'dev.example.com',
      basePath: '~/.komla',
    };
    const hosts = createDeferred<(typeof configuredHost)[]>();
    const api = createApiMock({
      listSshHosts: vi.fn().mockReturnValue(hosts.promise),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    const selection = useWorkspacesStore.getState().selectWorkspace('ssh-ws');
    await Promise.resolve();
    useWorkspacesStore.getState().updateWorkspace('ssh-ws', { terminals: [runningTerminal] });
    hosts.resolve([configuredHost]);
    await selection;

    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().workspaces[0]?.terminals).toEqual([runningTerminal]);
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(false);
  });

  it('does not reconnect when SSH host discovery fails', async () => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'stopped',
          remoteSessionResumable: true,
        }),
      ],
    });
    const api = createApiMock({
      listSshHosts: vi.fn().mockRejectedValue(new Error('Could not read SSH hosts')),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });

    await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

    expect(useWorkspacesStore.getState().error).toBe(
      'Failed to open workspace "Test Workspace": Could not read SSH hosts'
    );
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Failed to open workspace "Test Workspace": Could not read SSH hosts',
    ]);
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).not.toHaveBeenCalled();
    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(false);
  });

  it('surfaces an optimistic SSH reconnect failure without restarting the workspace', async () => {
    const workspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [
        createTerminal({
          id: 'term-remote',
          status: 'stopped',
          remoteSessionResumable: true,
        }),
      ],
    });
    const api = createApiMock({
      reconnectSshTerminal: vi.fn().mockRejectedValue(new Error('SSH host is offline')),
      getWorkspaces: vi.fn().mockResolvedValue([workspace]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useSshHostsStore.setState({
      hosts: [
        {
          id: 'ssh-dev',
          name: 'Devbox',
          hostname: 'dev.example.com',
          basePath: '~/.komla',
        },
      ],
      hasLoaded: true,
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });

    await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ssh-ws');
    expect(useWorkspacesStore.getState().error).toBe(
      'Could not reconnect 1 of 1 remote panes: SSH host is offline'
    );
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'Could not reconnect 1 of 1 remote panes: SSH host is offline',
      }),
    ]);
    expect(useWorkspacesStore.getState().reconnectingSshWorkspaceIds.has('ssh-ws')).toBe(false);
    expect(api.recoverSshSessions).not.toHaveBeenCalled();
    expect(api.reconnectSshTerminal).toHaveBeenCalledWith('term-remote', undefined, undefined);
    expect(api.restartWorkspace).not.toHaveBeenCalled();
  });

  it('does not restart a provisioning workspace when selected', async () => {
    const provisioningWs = createWorkspace({
      id: 'ws-1',
      terminals: [],
      workingDirectory: '',
      provisioning: true,
    });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [provisioningWs] });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');

    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
    expect(useWorkspacesStore.getState().showDashboard).toBe(false);
  });

  it('selects a workspace that shows only a browser pane without restarting it', async () => {
    const workspace = createWorkspace({ id: 'ws-1', terminals: [], showsPaneSurfaces: true });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');

    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
  });

  it('selects an SSH workspace that shows only a note pane without restarting it', async () => {
    const workspace = createSshWorkspace({
      id: 'ssh-ws',
      terminals: [],
      showsPaneSurfaces: true,
    });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useSshHostsStore.setState({
      hosts: [
        { id: 'ssh-host-1', name: 'Devbox', hostname: 'dev.example.com', basePath: '~/.komla' },
      ],
      hasLoaded: true,
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });

    await useWorkspacesStore.getState().selectWorkspace('ssh-ws');

    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ssh-ws');
  });

  it('does not restart an SSH workspace whose host configuration is missing', async () => {
    const unavailableWorkspace = createWorkspace({
      id: 'ws-1',
      terminals: [],
      provisionError: 'This workspace’s SSH host is no longer configured.',
    });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [unavailableWorkspace] });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');

    expect(api.restartWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
  });

  it('disposes existing terminal instances after restarting a running workspace', async () => {
    const runningWs = createWorkspace({
      id: 'ws-1',
      terminals: [
        createTerminal({ id: 'term-old-1', status: 'running' }),
        createTerminal({ id: 'term-old-2', status: 'starting' }),
      ],
      workingDirectory: '/tmp/ws-1',
    });
    const restartedWs = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
      workingDirectory: '/tmp/ws-1',
    });
    const api = createApiMock({
      restartWorkspace: vi
        .fn()
        .mockResolvedValue(createTerminal({ id: 'term-new', status: 'running' })),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [runningWs] });

    await useWorkspacesStore.getState().restartWorkspace('ws-1');

    expect(disposeTerminalRenderersMock).toHaveBeenCalledWith(['term-old-1', 'term-old-2']);
    expect(useWorkspacesStore.getState().workspaces[0]?.terminals[0]?.id).toBe('term-new');
  });

  it('surfaces restart progress until a remote workspace restart finishes', async () => {
    const restartDeferred = createDeferred<ReturnType<typeof createTerminal>>();
    const remoteWorkspace = createWorkspace({
      id: 'ssh-ws',
      backend: {
        kind: 'ssh',
        hostId: 'ssh-dev',
        remoteDirectory: '/home/dev/worktree',
        remoteRepoPath: '/home/dev/repo.git',
        remoteProjectRoot: '/home/dev',
        gitUrl: 'git@example.com:repo.git',
        projectName: 'Repo',
      },
      terminals: [createTerminal({ id: 'term-old', status: 'running' })],
    });
    const restartedWorkspace = createWorkspace({
      ...remoteWorkspace,
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
    });
    const api = createApiMock({
      restartWorkspace: vi.fn().mockReturnValue(restartDeferred.promise),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWorkspace]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [remoteWorkspace] });

    const restart = useWorkspacesStore.getState().restartWorkspace('ssh-ws');
    expect(useWorkspacesStore.getState().restartingWorkspaceIds.has('ssh-ws')).toBe(true);

    restartDeferred.resolve(createTerminal({ id: 'term-new', status: 'running' }));
    await restart;

    expect(useWorkspacesStore.getState().restartingWorkspaceIds.has('ssh-ws')).toBe(false);
  });

  it('does not reselect a restarted workspace after the user selects another workspace', async () => {
    const restartDeferred = createDeferred<ReturnType<typeof createTerminal>>();
    const stoppedWs = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-old', status: 'stopped' })],
      workingDirectory: '/tmp/ws-1',
    });
    const runningWs = createWorkspace({
      id: 'ws-2',
      terminals: [createTerminal({ id: 'term-2', status: 'running' })],
      workingDirectory: '/tmp/ws-2',
    });
    const restartedWs = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
      workingDirectory: '/tmp/ws-1',
    });
    const api = createApiMock({
      restartWorkspace: vi.fn().mockReturnValue(restartDeferred.promise),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWs, runningWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [stoppedWs, runningWs] });

    const selectStopped = useWorkspacesStore.getState().selectWorkspace('ws-1');
    await Promise.resolve();

    await useWorkspacesStore.getState().selectWorkspace('ws-2');
    restartDeferred.resolve(createTerminal({ id: 'term-new', status: 'running' }));
    await selectStopped;

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-2');
    expect(useLayoutStore.getState().currentWorkspaceId).not.toBe('ws-1');
  });

  it('does not restore a deleted workspace after an in-flight restart finishes', async () => {
    const restartDeferred = createDeferred<ReturnType<typeof createTerminal>>();
    const deleteDeferred = createDeferred<void>();
    const stoppedWs = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-old', status: 'stopped' })],
      workingDirectory: '/tmp/ws-1',
    });
    const restartedWs = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
      workingDirectory: '/tmp/ws-1',
    });
    const api = createApiMock({
      restartWorkspace: vi.fn().mockReturnValue(restartDeferred.promise),
      deleteWorkspace: vi.fn().mockReturnValue(deleteDeferred.promise),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [stoppedWs] });

    const selectStopped = useWorkspacesStore.getState().selectWorkspace('ws-1');
    await Promise.resolve();

    useWorkspacesStore.getState().deleteWorkspace('ws-1');
    restartDeferred.resolve(createTerminal({ id: 'term-new', status: 'running' }));
    await selectStopped;

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useWorkspacesStore.getState().workspaces).toEqual([]);
    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
  });

  it('assigns restarted workspace to current window when windowId is null', async () => {
    vi.useFakeTimers();
    const stoppedWs = createWorkspace({
      id: 'ws-1',
      windowId: null,
      terminals: [createTerminal({ id: 'term-old', status: 'stopped' })],
      workingDirectory: '/tmp/ws-1',
    });
    const restartedWs = createWorkspace({
      id: 'ws-1',
      windowId: null,
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
      workingDirectory: '/tmp/ws-1',
    });
    const api = createApiMock({
      restartWorkspace: vi
        .fn()
        .mockResolvedValue(createTerminal({ id: 'term-new', status: 'running' })),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [stoppedWs] });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');
    await flushTimersAndMicrotasks(500);

    // Workspace should be assigned to current window ('window-1' from mock)
    expect(useWorkspacesStore.getState().workspaces[0]?.windowId).toBe('window-1');
    expect(api.updateWorkspace).toHaveBeenCalledWith('ws-1', { windowId: 'window-1' });
    // Should remain selected
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
    // Other windows should be notified
    expect(api.notifyWorkspacesChanged).toHaveBeenCalled();
  });

  it('refreshes and notifies when linking workspaces fails after partial persistence', async () => {
    const initialWorkspace = createWorkspace({ id: 'ws-1', linkedWorkspaceIds: [] });
    const linkedWorkspace = createWorkspace({ id: 'ws-1', linkedWorkspaceIds: ['ws-2'] });
    const api = createApiMock({
      linkWorkspaces: vi.fn().mockRejectedValue(new Error('link failed')),
      getWorkspaces: vi.fn().mockResolvedValue([linkedWorkspace]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [initialWorkspace], selectedWorkspaceId: 'ws-1' });

    await expect(
      useWorkspacesStore.getState().linkWorkspaces('ws-1', ['ws-2', 'ws-3'])
    ).rejects.toThrow('link failed');

    expect(api.getWorkspaces).toHaveBeenCalled();
    expect(api.notifyWorkspacesChanged).toHaveBeenCalled();
    expect(useWorkspacesStore.getState().workspaces).toEqual([linkedWorkspace]);
    expect(useWorkspacesStore.getState().error).toBe('link failed');
  });

  it('refreshes linked workspace file lists after linking succeeds', async () => {
    const origin = createWorkspace({ id: 'ws-1', workingDirectory: '/tmp/ws-1' });
    const target = createWorkspace({ id: 'ws-2', workingDirectory: '/tmp/ws-2' });
    const linkedOrigin = { ...origin, linkedWorkspaceIds: ['ws-2'] };
    const linkedTarget = { ...target, linkedWorkspaceIds: ['ws-1'] };
    const api = createApiMock({
      getWorkspaces: vi.fn().mockResolvedValue([linkedOrigin, linkedTarget]),
      listFiles: vi.fn().mockResolvedValue({
        files: ['linked-workspaces/ws-2/src/index.ts'],
        gitIgnoredFiles: [],
        emptyDirs: [],
      }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [origin, target] });
    useFileListStore.setState((state) => {
      const cache = new Map(state.cache);
      cache.set('/tmp/ws-1', {
        files: ['src/old.ts'],
        gitIgnoredFiles: [],
        emptyDirs: [],
        isLoading: false,
      });
      cache.set('/tmp/ws-2', {
        files: ['src/target-old.ts'],
        gitIgnoredFiles: [],
        emptyDirs: [],
        isLoading: false,
      });
      const diffCache = new Map(state.diffCache);
      diffCache.set('/tmp/ws-1:main', {
        data: {
          files: [{ path: 'src/compared.ts', status: 'modified' }],
          summary: { additions: 1, deletions: 0, filesChanged: 1 },
        },
        isLoading: false,
        hasFullDiff: true,
      });
      return { cache, diffCache };
    });

    await useWorkspacesStore.getState().linkWorkspaces('ws-1', ['ws-2']);

    expect(api.listFiles).toHaveBeenCalledWith('/tmp/ws-1', false);
    expect(api.listFiles).toHaveBeenCalledWith('/tmp/ws-2', false);
    expect(api.getChangedFilesWithSummary).toHaveBeenCalledWith('/tmp/ws-1');
    expect(api.getChangedFilesWithSummary).toHaveBeenCalledWith('/tmp/ws-2');
    expect(useFileListStore.getState().diffCache.get('/tmp/ws-1:main')).toMatchObject({
      hasFullDiff: true,
      data: { files: [{ path: 'src/compared.ts', status: 'modified' }] },
    });
  });

  it('refreshes SSH workspace file lists through workspace-aware IPC after linking', async () => {
    const backend = {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/worktree',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example.com:repo.git',
      projectName: 'Repo',
    };
    const origin = createWorkspace({
      id: 'ws-1',
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree-one',
      backend: { ...backend, remoteDirectory: '/home/dev/worktree-one' },
    });
    const target = createWorkspace({
      id: 'ws-2',
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree-two',
      backend: { ...backend, remoteDirectory: '/home/dev/worktree-two' },
    });
    const linkedOrigin = { ...origin, linkedWorkspaceIds: ['ws-2'] };
    const linkedTarget = { ...target, linkedWorkspaceIds: ['ws-1'] };
    const api = createApiMock({
      getWorkspaces: vi.fn().mockResolvedValue([linkedOrigin, linkedTarget]),
      listWorkspaceFiles: vi.fn().mockResolvedValue({
        files: ['linked-workspaces/worktree-two/src/index.ts'],
        gitIgnoredFiles: [],
        emptyDirs: [],
      }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [origin, target] });

    await useWorkspacesStore.getState().linkWorkspaces('ws-1', ['ws-2']);

    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('ws-1', false);
    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('ws-2', false);
    expect(api.listFiles).not.toHaveBeenCalled();
    expect(api.getChangedFilesWithSummary).not.toHaveBeenCalled();
  });

  it('refreshes linked workspace file lists after unlinking succeeds', async () => {
    const origin = createWorkspace({
      id: 'ws-1',
      workingDirectory: '/tmp/ws-1',
      linkedWorkspaceIds: ['ws-2'],
    });
    const target = createWorkspace({
      id: 'ws-2',
      workingDirectory: '/tmp/ws-2',
      linkedWorkspaceIds: ['ws-1'],
    });
    const unlinkedOrigin = { ...origin, linkedWorkspaceIds: [] };
    const unlinkedTarget = { ...target, linkedWorkspaceIds: [] };
    const api = createApiMock({
      getWorkspaces: vi.fn().mockResolvedValue([unlinkedOrigin, unlinkedTarget]),
      listFiles: vi
        .fn()
        .mockResolvedValue({ files: ['src/index.ts'], gitIgnoredFiles: [], emptyDirs: [] }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [origin, target] });

    await useWorkspacesStore.getState().unlinkWorkspace('ws-1', 'ws-2');

    expect(api.unlinkWorkspace).toHaveBeenCalledWith('ws-1', 'ws-2');
    expect(api.listFiles).toHaveBeenCalledWith('/tmp/ws-1', false);
    expect(api.listFiles).toHaveBeenCalledWith('/tmp/ws-2', false);
  });

  it('assigns restarted workspace to current window when assigned to a different window', async () => {
    vi.useFakeTimers();
    const stoppedWs = createWorkspace({
      id: 'ws-1',
      windowId: 'other-window',
      terminals: [createTerminal({ id: 'term-old', status: 'stopped' })],
      workingDirectory: '/tmp/ws-1',
    });
    const restartedWs = createWorkspace({
      id: 'ws-1',
      windowId: 'other-window',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
      workingDirectory: '/tmp/ws-1',
    });
    const api = createApiMock({
      restartWorkspace: vi
        .fn()
        .mockResolvedValue(createTerminal({ id: 'term-new', status: 'running' })),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [stoppedWs] });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');
    await flushTimersAndMicrotasks(500);

    // Workspace should be reassigned to current window
    expect(useWorkspacesStore.getState().workspaces[0]?.windowId).toBe('window-1');
    expect(api.updateWorkspace).toHaveBeenCalledWith('ws-1', { windowId: 'window-1' });
    // Should remain selected
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe('ws-1');
  });

  it('does not update windowId when restarted workspace already belongs to current window', async () => {
    vi.useFakeTimers();
    const stoppedWs = createWorkspace({
      id: 'ws-1',
      windowId: 'window-1',
      terminals: [createTerminal({ id: 'term-old', status: 'stopped' })],
      workingDirectory: '/tmp/ws-1',
    });
    const restartedWs = createWorkspace({
      id: 'ws-1',
      windowId: 'window-1',
      terminals: [createTerminal({ id: 'term-new', status: 'running' })],
      workingDirectory: '/tmp/ws-1',
    });
    const api = createApiMock({
      restartWorkspace: vi
        .fn()
        .mockResolvedValue(createTerminal({ id: 'term-new', status: 'running' })),
      getWorkspaces: vi.fn().mockResolvedValue([restartedWs]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [stoppedWs] });

    await useWorkspacesStore.getState().selectWorkspace('ws-1');
    await flushTimersAndMicrotasks(500);

    // Should not call updateWorkspace for windowId
    expect(api.updateWorkspace).not.toHaveBeenCalledWith('ws-1', { windowId: 'window-1' });
  });

  it('ignores a dynamic title that has not changed', async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ id: 'term-1', dynamicTitle: 'build running' });
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [terminal],
      lastDynamicTitle: 'build running',
    });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });
    const workspacesBefore = useWorkspacesStore.getState().workspaces;

    useWorkspacesStore.getState().setTerminalDynamicTitle('term-1', 'build running');
    await flushTimersAndMicrotasks(1000);

    expect(useWorkspacesStore.getState().workspaces).toBe(workspacesBefore);
    expect(api.updateTerminal).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
  });

  it('changes only the workspace whose terminal status changed', () => {
    const changed = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-1', status: 'running' })],
    });
    const other = createWorkspace({
      id: 'ws-2',
      terminals: [createTerminal({ id: 'term-2', status: 'running' })],
    });
    useWorkspacesStore.setState({ workspaces: [changed, other] });

    useWorkspacesStore.getState().updateTerminalStatus('term-1', 'stopped');

    const [first, second] = useWorkspacesStore.getState().workspaces;
    expect(first.terminals[0].status).toBe('stopped');
    expect(second).toBe(other);
  });

  it('ignores a terminal status that has not changed', () => {
    const workspace = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 'term-1', status: 'running' })],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    const workspacesBefore = useWorkspacesStore.getState().workspaces;

    useWorkspacesStore.getState().updateTerminalStatus('term-1', 'running');

    expect(useWorkspacesStore.getState().workspaces).toBe(workspacesBefore);
  });

  it('cancels pending dynamic title persistence when removing a terminal', async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const api = createApiMock({
      removeTerminal: vi.fn().mockResolvedValue(undefined),
      getWorkspaces: vi.fn().mockResolvedValue([createWorkspace({ id: 'ws-1', terminals: [] })]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    useWorkspacesStore.getState().setTerminalDynamicTitle('term-1', 'build running');
    await useWorkspacesStore.getState().removeTerminal('ws-1', 'term-1');
    await flushTimersAndMicrotasks(1000);

    expect(api.updateTerminal).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
  });

  it('cancels pending dynamic title persistence even when terminal removal fails', async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const api = createApiMock({
      removeTerminal: vi.fn().mockRejectedValue(new Error('remove failed')),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    useWorkspacesStore.getState().setTerminalDynamicTitle('term-1', 'build running');
    await expect(useWorkspacesStore.getState().removeTerminal('ws-1', 'term-1')).rejects.toThrow(
      'remove failed'
    );
    await flushTimersAndMicrotasks(1000);

    expect(api.updateTerminal).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
  });

  it('cancels pending dynamic title persistence when stopping a workspace', async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const api = createApiMock({
      stopWorkspace: vi.fn().mockResolvedValue(undefined),
      getWorkspaces: vi.fn().mockResolvedValue([createWorkspace({ id: 'ws-1', terminals: [] })]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: 'ws-1' });
    useDevServerPreviewStore.setState({
      remoteForwardByWorkspace: {
        'ws-1': {
          status: 'active',
          requestId: 1,
          remotePort: 3000,
          forward: {
            id: 'forward-1',
            workspaceId: 'ws-1',
            localUrl: 'http://127.0.0.1:53001',
            localPort: 53001,
            remotePort: 3000,
          },
        },
      },
    });

    useWorkspacesStore.getState().setTerminalDynamicTitle('term-1', 'build running');
    await useWorkspacesStore.getState().stopWorkspace('ws-1');
    await flushTimersAndMicrotasks(1000);

    expect(api.updateTerminal).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toMatchObject({
      status: 'stopped',
    });
  });

  it('leaves a selected workspace immediately while remote stop is pending', async () => {
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const stop = createDeferred<void>();
    const api = createApiMock({
      stopWorkspace: vi.fn(() => stop.promise),
      getWorkspaces: vi.fn().mockResolvedValue([{ ...workspace, terminals: [] }]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    const stopping = useWorkspacesStore.getState().stopWorkspace(workspace.id);

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
    expect(disposeTerminalRenderersMock).not.toHaveBeenCalled();

    stop.resolve();
    await stopping;
    expect(disposeTerminalRenderersMock).toHaveBeenCalledWith([terminal.id]);
  });

  it('deselects a workspace reselected while its stop is pending', async () => {
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const stop = createDeferred<void>();
    const api = createApiMock({
      stopWorkspace: vi.fn(() => stop.promise),
      getWorkspaces: vi.fn().mockResolvedValue([{ ...workspace, terminals: [] }]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    const stopping = useWorkspacesStore.getState().stopWorkspace(workspace.id);
    await useWorkspacesStore.getState().selectWorkspace(workspace.id);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(workspace.id);

    stop.resolve();
    await stopping;

    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
  });

  it('does not restore stopped terminals when refreshing workspaces fails', async () => {
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const api = createApiMock({
      stopWorkspace: vi.fn().mockResolvedValue(undefined),
      getWorkspaces: vi.fn().mockRejectedValue(new Error('refresh failed')),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);

    await useWorkspacesStore.getState().stopWorkspace(workspace.id);

    expect(disposeTerminalRenderersMock).toHaveBeenCalledWith([terminal.id]);
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().currentWorkspaceId).toBeNull();
    expect(useLayoutStore.getState().tabsByWorkspace[workspace.id]).toBeUndefined();
  });

  it('preserves the file-list diff summary cache when stopping a workspace', async () => {
    const workingDirectory = '/mock/workspace';
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({
      id: 'ws-1',
      workingDirectory,
      terminals: [terminal],
    });
    const api = createApiMock({
      stopWorkspace: vi.fn().mockResolvedValue(undefined),
      getWorkspaces: vi
        .fn()
        .mockResolvedValue([createWorkspace({ id: 'ws-1', workingDirectory, terminals: [] })]),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace] });

    const summary = { additions: 7, deletions: 3, filesChanged: 1 };
    useFileListStore.getState().applyPushedFileStatus(workingDirectory, { files: [], summary });
    expect(useFileListStore.getState().diffCache.get(workingDirectory)?.data.summary).toEqual(
      summary
    );

    await useWorkspacesStore.getState().stopWorkspace('ws-1');

    expect(useFileListStore.getState().diffCache.get(workingDirectory)?.data.summary).toEqual(
      summary
    );
  });

  it('cancels pending dynamic title persistence even when workspace stop fails', async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const api = createApiMock({
      stopWorkspace: vi.fn().mockRejectedValue(new Error('stop failed')),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });
    useLayoutStore.getState().setCurrentWorkspace(workspace.id, terminal.id);
    useDevServerPreviewStore.setState({
      remoteForwardByWorkspace: {
        'ws-1': { status: 'pending', requestId: 1, remotePort: 3000 },
      },
    });

    useWorkspacesStore.getState().setTerminalDynamicTitle('term-1', 'build running');
    await useWorkspacesStore.getState().stopWorkspace('ws-1');
    await flushTimersAndMicrotasks(1000);

    expect(api.updateTerminal).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-1']).toBeDefined();
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(workspace.id);
    expect(useLayoutStore.getState().currentWorkspaceId).toBe(workspace.id);
  });

  it('restores selection without replacing the layout when workspace stop fails', async () => {
    const first = createTerminal({ id: 'term-1', status: 'running' });
    const second = createTerminal({ id: 'term-2', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [first, second] });
    const api = createApiMock({
      stopWorkspace: vi.fn().mockRejectedValue(new Error('stop failed')),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id });

    const layout = useLayoutStore.getState();
    layout.setCurrentWorkspace(workspace.id, first.id);
    layout.addTab(workspace.id, second.id);
    const initializedLayout = useLayoutStore.getState();
    const firstPane = getAllLeaves(initializedLayout.layoutsByTab[workspace.id][first.id])[0];
    initializedLayout.movePaneToTab(firstPane.id, second.id);
    const arrangedLayout = useLayoutStore.getState();
    const expectedTabs = arrangedLayout.tabsByWorkspace[workspace.id];
    const expectedLayouts = arrangedLayout.layoutsByTab[workspace.id];

    await useWorkspacesStore.getState().stopWorkspace(workspace.id);

    const restoredLayout = useLayoutStore.getState();
    expect(useWorkspacesStore.getState().selectedWorkspaceId).toBe(workspace.id);
    expect(restoredLayout.currentWorkspaceId).toBe(workspace.id);
    expect(restoredLayout.tabsByWorkspace[workspace.id]).toBe(expectedTabs);
    expect(restoredLayout.layoutsByTab[workspace.id]).toBe(expectedLayouts);
  });

  it('cancels pending dynamic title persistence when deleting a workspace', async () => {
    vi.useFakeTimers();
    const terminal = createTerminal({ id: 'term-1', status: 'running' });
    const workspace = createWorkspace({ id: 'ws-1', terminals: [terminal] });
    const api = createApiMock();
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [workspace], selectedWorkspaceId: 'ws-1' });

    useWorkspacesStore.getState().setTerminalDynamicTitle('term-1', 'build running');
    useWorkspacesStore.getState().deleteWorkspace('ws-1');
    await flushTimersAndMicrotasks(1000);

    expect(api.updateTerminal).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
  });

  describe('attention clearing debounce', () => {
    it('defers clearWorkspaceAttention IPC call when workspace has attention', async () => {
      vi.useFakeTimers();
      const ws = createWorkspace({
        id: 'ws-1',
        needsAttention: true,
        attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1000 },
        terminals: [createTerminal({ id: 'term-1', status: 'running' })],
      });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws] });

      await useWorkspacesStore.getState().selectWorkspace('ws-1');

      // IPC call should not fire immediately
      expect(api.clearWorkspaceAttention).not.toHaveBeenCalled();
      // But local attention is cleared for the active workspace
      expect(useWorkspacesStore.getState().workspaces[0]?.needsAttention).toBe(false);

      // After the delay, IPC call fires
      await flushTimersAndMicrotasks(500);
      expect(api.clearWorkspaceAttention).toHaveBeenCalledWith('ws-1');
    });

    it('restores notification when quickly switching away before debounce fires', async () => {
      vi.useFakeTimers();
      const ws1 = createWorkspace({
        id: 'ws-1',
        needsAttention: true,
        attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1000 },
        terminals: [createTerminal({ id: 'term-1', status: 'running' })],
      });
      const ws2 = createWorkspace({
        id: 'ws-2',
        terminals: [createTerminal({ id: 'term-2', status: 'running' })],
      });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

      // Select ws-1 (has notification)
      await useWorkspacesStore.getState().selectWorkspace('ws-1');
      expect(api.clearWorkspaceAttention).not.toHaveBeenCalled();

      // Quickly switch to ws-2 before debounce fires
      await useWorkspacesStore.getState().selectWorkspace('ws-2');

      // ws-1's notification should be restored
      const restored = useWorkspacesStore.getState().workspaces.find((w) => w.id === 'ws-1');
      expect(restored?.needsAttention).toBe(true);
      expect(restored?.attention?.kind).toBe('turn-complete');

      // IPC clear should never have been called for ws-1
      await flushTimersAndMicrotasks(500);
      expect(api.clearWorkspaceAttention).not.toHaveBeenCalledWith('ws-1');
      // ws-2 has no attention, so its clear fires immediately
      expect(api.clearWorkspaceAttention).toHaveBeenCalledWith('ws-2');
    });

    it('does not clear terminal-scoped attention when selecting the workspace', async () => {
      vi.useFakeTimers();
      const attention = {
        kind: 'input-required' as const,
        source: 'claude-code' as const,
        updatedAt: 1000,
        terminalId: 'term-2',
      };
      const ws = createWorkspace({
        id: 'ws-1',
        needsAttention: true,
        attention,
        terminals: [
          createTerminal({ id: 'term-1', status: 'running' }),
          createTerminal({ id: 'term-2', status: 'running', attention }),
        ],
      });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws] });

      await useWorkspacesStore.getState().selectWorkspace('ws-1');
      await flushTimersAndMicrotasks(500);

      const selected = useWorkspacesStore.getState().workspaces[0];
      expect(selected?.needsAttention).toBe(true);
      expect(selected?.attention).toEqual(attention);
      expect(selected?.terminals.find((t) => t.id === 'term-2')?.attention).toEqual(attention);
      expect(api.clearWorkspaceAttention).not.toHaveBeenCalled();
    });

    it('preserves notifications when rapidly cycling through multiple workspaces', async () => {
      vi.useFakeTimers();
      const ws1 = createWorkspace({
        id: 'ws-1',
        needsAttention: true,
        attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1000 },
        terminals: [createTerminal({ id: 'term-1', status: 'running' })],
      });
      const ws2 = createWorkspace({
        id: 'ws-2',
        needsAttention: true,
        attention: { kind: 'input-required', source: 'claude-code', updatedAt: 2000 },
        terminals: [createTerminal({ id: 'term-2', status: 'running' })],
      });
      const ws3 = createWorkspace({
        id: 'ws-3',
        terminals: [createTerminal({ id: 'term-3', status: 'running' })],
      });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws1, ws2, ws3] });

      // Rapidly cycle: ws-1 → ws-2 → ws-3
      await useWorkspacesStore.getState().selectWorkspace('ws-1');
      await useWorkspacesStore.getState().selectWorkspace('ws-2');
      await useWorkspacesStore.getState().selectWorkspace('ws-3');

      // Both ws-1 and ws-2 should have their notifications restored
      const workspaces = useWorkspacesStore.getState().workspaces;
      expect(workspaces.find((w) => w.id === 'ws-1')?.needsAttention).toBe(true);
      expect(workspaces.find((w) => w.id === 'ws-2')?.needsAttention).toBe(true);

      // Only ws-3 (no attention) should have had clearWorkspaceAttention called
      await flushTimersAndMicrotasks(500);
      expect(api.clearWorkspaceAttention).not.toHaveBeenCalledWith('ws-1');
      expect(api.clearWorkspaceAttention).not.toHaveBeenCalledWith('ws-2');
      expect(api.clearWorkspaceAttention).toHaveBeenCalledWith('ws-3');
    });

    it('cancels pending attention clear when navigating to dashboard', async () => {
      vi.useFakeTimers();
      const ws = createWorkspace({
        id: 'ws-1',
        needsAttention: true,
        attention: { kind: 'turn-complete', source: 'claude-code', updatedAt: 1000 },
        terminals: [createTerminal({ id: 'term-1', status: 'running' })],
      });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws] });

      await useWorkspacesStore.getState().selectWorkspace('ws-1');
      // Navigate to dashboard (null workspace)
      await useWorkspacesStore.getState().selectWorkspace(null);

      // ws-1's notification should be restored
      const restored = useWorkspacesStore.getState().workspaces.find((w) => w.id === 'ws-1');
      expect(restored?.needsAttention).toBe(true);
      expect(restored?.attention?.kind).toBe('turn-complete');

      await flushTimersAndMicrotasks(500);
      expect(api.clearWorkspaceAttention).not.toHaveBeenCalledWith('ws-1');
    });

    it('cancels keyboard navigation preview when reselecting the active workspace', async () => {
      const ws = createWorkspace({ id: 'ws-1' });
      useWorkspacesStore.setState({
        workspaces: [ws],
        selectedWorkspaceId: 'ws-1',
        keyboardNavigationWorkspaceId: 'ws-2',
      });

      await useWorkspacesStore.getState().selectWorkspace('ws-1');

      expect(useWorkspacesStore.getState().keyboardNavigationWorkspaceId).toBeNull();
    });
  });

  describe('multi-select', () => {
    it('enters selection mode and selects the given workspace', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      useWorkspacesStore.setState({ workspaces: [ws1] });

      useWorkspacesStore.getState().enterSelectionMode('ws-1');

      expect(useWorkspacesStore.getState().selectionMode).toBe(true);
      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-1']));
    });

    it('toggles workspace selection on and off', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

      useWorkspacesStore.getState().enterSelectionMode('ws-1');
      useWorkspacesStore.getState().toggleWorkspaceSelection('ws-2');
      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-1', 'ws-2']));

      useWorkspacesStore.getState().toggleWorkspaceSelection('ws-1');
      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-2']));
    });

    it('auto-exits selection mode when last workspace is deselected', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      useWorkspacesStore.setState({ workspaces: [ws1] });

      useWorkspacesStore.getState().enterSelectionMode('ws-1');
      useWorkspacesStore.getState().toggleWorkspaceSelection('ws-1');

      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
      expect(useWorkspacesStore.getState().selectedWorkspaceIds.size).toBe(0);
    });

    it('exits selection mode and clears all selections', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

      useWorkspacesStore.getState().enterSelectionMode('ws-1');
      useWorkspacesStore.getState().toggleWorkspaceSelection('ws-2');
      useWorkspacesStore.getState().exitSelectionMode();

      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
      expect(useWorkspacesStore.getState().selectedWorkspaceIds.size).toBe(0);
      expect(useWorkspacesStore.getState().lastSelectedWorkspaceId).toBeNull();
    });

    it('tracks lastSelectedWorkspaceId on enter and toggle', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2] });

      useWorkspacesStore.getState().enterSelectionMode('ws-1');
      expect(useWorkspacesStore.getState().lastSelectedWorkspaceId).toBe('ws-1');

      useWorkspacesStore.getState().toggleWorkspaceSelection('ws-2');
      expect(useWorkspacesStore.getState().lastSelectedWorkspaceId).toBe('ws-2');
    });

    it('shift-selects a range from anchor to target', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      const ws3 = createWorkspace({ id: 'ws-3' });
      const ws4 = createWorkspace({ id: 'ws-4' });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2, ws3, ws4] });

      useWorkspacesStore.getState().enterSelectionMode('ws-1');
      const orderedIds = ['ws-1', 'ws-2', 'ws-3', 'ws-4'];
      useWorkspacesStore.getState().shiftSelectWorkspaces('ws-3', orderedIds);

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(
        new Set(['ws-1', 'ws-2', 'ws-3'])
      );
    });

    it('shift-selects backwards from anchor to target', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      const ws3 = createWorkspace({ id: 'ws-3' });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2, ws3] });

      // Anchor at ws-3, shift-select ws-1
      useWorkspacesStore.getState().enterSelectionMode('ws-3');
      useWorkspacesStore.getState().shiftSelectWorkspaces('ws-1', ['ws-1', 'ws-2', 'ws-3']);

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(
        new Set(['ws-1', 'ws-2', 'ws-3'])
      );
    });

    it('shift-select adds to existing selection without removing', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      const ws3 = createWorkspace({ id: 'ws-3' });
      const ws4 = createWorkspace({ id: 'ws-4' });
      useWorkspacesStore.setState({ workspaces: [ws1, ws2, ws3, ws4] });

      // Select ws-1, toggle ws-4 on, then shift-select ws-2→ws-3
      useWorkspacesStore.getState().enterSelectionMode('ws-1');
      useWorkspacesStore.getState().toggleWorkspaceSelection('ws-4');
      // Anchor is now ws-4
      useWorkspacesStore.getState().shiftSelectWorkspaces('ws-2', ['ws-1', 'ws-2', 'ws-3', 'ws-4']);

      // Should have ws-1 (original), ws-2, ws-3, ws-4 (anchor + range)
      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(
        new Set(['ws-1', 'ws-2', 'ws-3', 'ws-4'])
      );
    });

    it('shift-select falls back to toggle when no anchor', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      useWorkspacesStore.setState({
        workspaces: [ws1],
        selectionMode: true,
        selectedWorkspaceIds: new Set<string>(),
        lastSelectedWorkspaceId: null,
      });

      useWorkspacesStore.getState().shiftSelectWorkspaces('ws-1', ['ws-1']);

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-1']));
    });

    it('shift-select falls back to toggle when anchor not in ordered list', () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1']),
        lastSelectedWorkspaceId: 'ws-1',
      });

      // Ordered list doesn't include ws-1 (e.g., it's in a collapsed group)
      useWorkspacesStore.getState().shiftSelectWorkspaces('ws-2', ['ws-2']);

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-1', 'ws-2']));
    });

    it('selects only active workspaces (excludes trashed)', () => {
      const ws1 = createWorkspace({ id: 'ws-1', windowId: 'window-1' });
      const ws2 = createWorkspace({
        id: 'ws-2',
        status: 'trashed' as const,
        windowId: 'window-1',
      });
      const ws3 = createWorkspace({ id: 'ws-3', windowId: 'window-1' });
      useWorkspacesStore.setState({
        workspaces: [ws1, ws2, ws3],
        selectionMode: true,
      });

      useWorkspacesStore.getState().selectAllWorkspaces();

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-1', 'ws-3']));
    });

    it('selectAll includes provisioning workspaces even when hideStopped is enabled', () => {
      const ws1 = createWorkspace({
        id: 'ws-1',
        windowId: 'window-1',
        terminals: [createTerminal({ id: 't-1', status: 'running' })],
      });
      const wsProvisioning = createWorkspace({
        id: 'ws-prov',
        windowId: 'window-1',
        terminals: [],
        provisioning: true,
      });
      const wsStopped = createWorkspace({
        id: 'ws-stopped',
        windowId: 'window-1',
        terminals: [createTerminal({ id: 't-stopped', status: 'stopped' })],
      });
      useWorkspacesStore.setState({
        workspaces: [ws1, wsProvisioning, wsStopped],
        selectionMode: true,
        hideStopped: true,
      });

      useWorkspacesStore.getState().selectAllWorkspaces();

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(
        new Set(['ws-1', 'ws-prov'])
      );
    });

    it('selectAll only selects workspaces in the current window', () => {
      const ws1 = createWorkspace({ id: 'ws-1', windowId: 'window-1' });
      const ws2 = createWorkspace({ id: 'ws-2', windowId: 'window-2' });
      const ws3 = createWorkspace({ id: 'ws-3', windowId: 'window-1' });
      useWorkspacesStore.setState({
        workspaces: [ws1, ws2, ws3],
        selectionMode: true,
      });

      useWorkspacesStore.getState().selectAllWorkspaces();

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-1', 'ws-3']));
    });

    it('selectAll excludes workspaces on hidden hosts', () => {
      const localWorkspace = createWorkspace({ id: 'local', windowId: 'window-1' });
      const remoteWorkspace = createWorkspace({
        id: 'remote',
        windowId: 'window-1',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/worktree',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example.com:repo.git',
          projectName: 'Repo',
        },
      });
      useWorkspacesStore.setState({
        workspaces: [localWorkspace, remoteWorkspace],
        selectionMode: true,
        hiddenWorkspaceHostIds: new Set(['ssh-dev']),
      });

      useWorkspacesStore.getState().selectAllWorkspaces();

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['local']));
    });

    it('removes deleted workspace from selectedWorkspaceIds', () => {
      const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
      const ws2 = createWorkspace({ id: 'ws-2', terminals: [createTerminal({ id: 't-2' })] });
      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      useWorkspacesStore.getState().deleteWorkspace('ws-1');

      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-2']));
      expect(useWorkspacesStore.getState().selectionMode).toBe(true);
    });

    it('auto-exits selection mode when last selected workspace is deleted', () => {
      const ws1 = createWorkspace({ id: 'ws-1', terminals: [createTerminal({ id: 't-1' })] });
      useWorkspacesStore.setState({
        workspaces: [ws1],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1']),
      });

      useWorkspacesStore.getState().deleteWorkspace('ws-1');

      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
      expect(useWorkspacesStore.getState().selectedWorkspaceIds.size).toBe(0);
    });

    it('stops all running selected workspaces', async () => {
      const ws1 = createWorkspace({
        id: 'ws-1',
        terminals: [createTerminal({ id: 't-1', status: 'running' })],
      });
      const ws2 = createWorkspace({
        id: 'ws-2',
        terminals: [createTerminal({ id: 't-2', status: 'stopped' })],
      });
      const ws3 = createWorkspace({
        id: 'ws-3',
        terminals: [createTerminal({ id: 't-3', status: 'running' })],
      });
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([ws1, ws2, ws3]),
        stopWorkspace: vi.fn().mockResolvedValue(undefined),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2, ws3],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2', 'ws-3']),
      });

      await useWorkspacesStore.getState().stopSelectedWorkspaces();

      expect(api.stopWorkspace).toHaveBeenCalledWith('ws-1');
      expect(api.stopWorkspace).not.toHaveBeenCalledWith('ws-2');
      expect(api.stopWorkspace).toHaveBeenCalledWith('ws-3');
      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    });

    it('stops a selected workspace whose tmux session runs on its host', async () => {
      const ws = createSshWorkspace({
        id: 'ws-elsewhere',
        terminals: [createTerminal({ id: 't-1', status: 'stopped', remoteSessionOnHost: true })],
      });
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([ws]),
        stopWorkspace: vi.fn().mockResolvedValue(undefined),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-elsewhere']),
      });

      await useWorkspacesStore.getState().stopSelectedWorkspaces();

      expect(api.stopWorkspace).toHaveBeenCalledWith('ws-elsewhere');
    });

    it('pins all selected when any are not pinned', () => {
      const ws1 = createWorkspace({ id: 'ws-1', pinned: true });
      const ws2 = createWorkspace({ id: 'ws-2' });
      const ws3 = createWorkspace({ id: 'ws-3' });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2, ws3],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2', 'ws-3']),
      });

      useWorkspacesStore.getState().togglePinSelected();

      const updated = useWorkspacesStore.getState().workspaces;
      expect(updated.map((w) => w.pinned)).toEqual([true, true, true]);
      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    });

    it('unpins all selected when all are already pinned', () => {
      const ws1 = createWorkspace({ id: 'ws-1', pinned: true });
      const ws2 = createWorkspace({ id: 'ws-2', pinned: true });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      useWorkspacesStore.getState().togglePinSelected();

      const updated = useWorkspacesStore.getState().workspaces;
      expect(updated.map((w) => w.pinned)).toEqual([undefined, undefined]);
    });

    it('links each selected pair that is not yet linked, then refreshes once', async () => {
      const a = createWorkspace({ id: 'ws-a', linkedWorkspaceIds: ['ws-b'] });
      const b = createWorkspace({ id: 'ws-b', linkedWorkspaceIds: ['ws-a'] });
      const c = createWorkspace({ id: 'ws-c' });
      const api = createApiMock({ getWorkspaces: vi.fn().mockResolvedValue([a, b, c]) });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [a, b, c],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-a', 'ws-b', 'ws-c']),
      });

      await useWorkspacesStore.getState().toggleLinkSelected();

      expect(api.linkWorkspaces.mock.calls).toEqual([
        ['ws-a', ['ws-c']],
        ['ws-b', ['ws-c']],
      ]);
      expect(api.unlinkWorkspace).not.toHaveBeenCalled();
      expect(api.getWorkspaces).toHaveBeenCalledTimes(1);
      expect(api.notifyWorkspacesChanged).toHaveBeenCalledTimes(1);
      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    });

    it('unlinks every selected pair once all of them are linked', async () => {
      const a = createWorkspace({ id: 'ws-a', linkedWorkspaceIds: ['ws-b'] });
      const b = createWorkspace({ id: 'ws-b', linkedWorkspaceIds: ['ws-a'] });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [a, b],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-a', 'ws-b']),
      });

      await useWorkspacesStore.getState().toggleLinkSelected();

      expect(api.unlinkWorkspace.mock.calls).toEqual([['ws-a', 'ws-b']]);
      expect(api.linkWorkspaces).not.toHaveBeenCalled();
    });

    it('keeps linking the other pairs when one fails, and reports how many went through', async () => {
      const a = createWorkspace({ id: 'ws-a' });
      const b = createWorkspace({ id: 'ws-b' });
      const c = createWorkspace({ id: 'ws-c' });
      const api = createApiMock({
        linkWorkspaces: vi
          .fn()
          .mockRejectedValueOnce(new Error('symlink failed'))
          .mockResolvedValue(undefined),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({
        workspaces: [a, b, c],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-a', 'ws-b', 'ws-c']),
      });

      await useWorkspacesStore.getState().toggleLinkSelected();

      expect(api.linkWorkspaces).toHaveBeenCalledTimes(3);
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: 'Linked 2 of 3 pairs: symlink failed',
          type: 'error',
        }),
      ]);
      expect(api.getWorkspaces).toHaveBeenCalledTimes(1);
    });

    it('marks all selected unread and snoozes them', () => {
      vi.setSystemTime(5_000);
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };
      const select = () =>
        useWorkspacesStore.setState({
          selectionMode: true,
          selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
        });
      useWorkspacesStore.setState({
        workspaces: [createWorkspace({ id: 'ws-1' }), createWorkspace({ id: 'ws-2' })],
      });

      select();
      useWorkspacesStore.getState().markSelectedUnread();
      select();
      useWorkspacesStore.getState().snoozeSelected(60_000);

      for (const workspace of useWorkspacesStore.getState().workspaces) {
        // A snooze starts the workspace afresh: it comes back marked Woke.
        expect(workspace.unread).toBeUndefined();
        expect(workspace.snoozedUntil).toBe(60_000);
      }
      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    });

    it('trashes all active selected workspaces', async () => {
      const ws1 = createWorkspace({ id: 'ws-1', terminals: [] });
      const ws2 = createWorkspace({ id: 'ws-2', terminals: [], status: 'trashed' as const });
      const trashedWs1 = { ...ws1, status: 'trashed' as const };
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([trashedWs1, ws2]),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      await useWorkspacesStore.getState().trashSelectedWorkspaces();

      const updated = useWorkspacesStore.getState().workspaces;
      expect(updated.find((w) => w.id === 'ws-1')?.status).toBe('trashed');
      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    });

    it('invalidates file-list cache after trashing a workspace', async () => {
      const workingDirectory = '/mock/workspace';
      const ws = createWorkspace({ id: 'ws-1', workingDirectory, terminals: [] });
      const trashedWs = { ...ws, status: 'trashed' as const };
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([trashedWs]),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ workspaces: [ws] });
      useFileListStore.setState((state) => {
        const cache = new Map(state.cache);
        cache.set(workingDirectory, {
          files: ['node_modules/pkg/index.js'],
          gitIgnoredFiles: [],
          emptyDirs: [],
          isLoading: false,
        });
        return { cache };
      });

      await useWorkspacesStore.getState().setWorkspaceTrashed('ws-1', true);

      expect(useFileListStore.getState().cache.has(workingDirectory)).toBe(false);
    });

    it('drops the workspace’s branch comparison diffs after trashing so a restore refetches them', async () => {
      const workingDirectory = '/mock/workspace';
      const ws = createWorkspace({ id: 'ws-1', workingDirectory, terminals: [] });
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([{ ...ws, status: 'trashed' as const }]),
        getWorkspaceDiffAgainstBranch: vi.fn().mockResolvedValue({
          files: [],
          summary: { additions: 0, deletions: 0, filesChanged: 0 },
        }),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ workspaces: [ws] });
      await useFileListStore.getState().fetchDiff(workingDirectory, 'main', false, 'ws-1');

      await useWorkspacesStore.getState().setWorkspaceTrashed('ws-1', true);

      expect(
        useFileListStore.getState().getDiff(workingDirectory, 'main', false, 'ws-1')
      ).toBeUndefined();
    });

    it('trashes a workspace its agent asked to and offers to undo it', async () => {
      const ws = createWorkspace({
        id: 'ws-1',
        name: 'fix-login',
        customName: 'Fix login',
        terminals: [],
      });
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([{ ...ws, status: 'trashed' as const }]),
        updateWorkspace: vi.fn().mockResolvedValue(undefined),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws] });

      await useWorkspacesStore.getState().trashWorkspaceForAgent({ workspaceId: 'ws-1' });

      expect(useWorkspacesStore.getState().workspaces[0].status).toBe('trashed');
      const toast = useToastStore.getState().toasts.at(-1);
      expect(toast?.message).toBe('Moved "Fix login" to the Trash, as its agent asked');
      toast?.action?.onClick();
      await vi.waitFor(() =>
        expect(api.updateWorkspace).toHaveBeenLastCalledWith(
          'ws-1',
          expect.objectContaining({ status: 'active' })
        )
      );
    });

    it('offers to undo a move to the Trash, putting the workspace back where it was and reopening it', async () => {
      const ws = createWorkspace({ id: 'ws-1', customName: 'Fix login', order: 0, terminals: [] });
      const other = createWorkspace({ id: 'ws-2', order: 1, terminals: [] });
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([{ ...ws, status: 'trashed' as const }, other]),
        updateWorkspace: vi.fn().mockResolvedValue(undefined),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      // Opening it restarts its terminals, which other tests cover.
      const selectWorkspace = vi.fn().mockResolvedValue(undefined);
      useWorkspacesStore.setState({
        workspaces: [ws, other],
        selectedWorkspaceId: 'ws-1',
        selectWorkspace,
      });

      await useWorkspacesStore.getState().trashWorkspaceWithUndo('ws-1');

      expect(useWorkspacesStore.getState().workspaces[0].status).toBe('trashed');
      expect(useWorkspacesStore.getState().selectedWorkspaceId).toBeNull();
      const toast = useToastStore.getState().toasts.at(-1);
      expect(toast?.message).toBe('Moved "Fix login" to the Trash');
      toast?.action?.onClick();
      await vi.waitFor(() => expect(selectWorkspace).toHaveBeenCalledWith('ws-1'));
      expect(api.updateWorkspace).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ status: 'active', order: 0 })
      );
    });

    it('shows no undo when the move to the Trash failed', async () => {
      const ws = createWorkspace({ id: 'ws-1', customName: 'Fix login', terminals: [] });
      const api = createApiMock({
        updateWorkspace: vi.fn().mockRejectedValue(new Error('Trash cleanup script failed')),
        getWorkspaces: vi.fn().mockResolvedValue([ws]),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws] });

      await useWorkspacesStore.getState().trashWorkspaceWithUndo('ws-1');

      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
        'Trash cleanup script failed',
      ]);
    });

    it('keeps a workspace its agent asked to trash when Komla says why not', async () => {
      const ws = createWorkspace({ id: 'ws-1', name: 'Fix login', terminals: [] });
      const api = createApiMock({ updateWorkspace: vi.fn().mockResolvedValue(undefined) });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      useWorkspacesStore.setState({ workspaces: [ws] });

      await useWorkspacesStore.getState().trashWorkspaceForAgent({
        workspaceId: 'ws-1',
        refusal: 'Another tab in this workspace is still working, and the Trash would stop it.',
      });

      expect(api.updateWorkspace).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'An agent asked to move "Fix login" to the Trash, but it stays. Another tab in this workspace is still working, and the Trash would stop it.'
      );
    });

    it('leaves a workspace active when trash cleanup fails', async () => {
      const ws = createWorkspace({ id: 'ws-1', name: 'Cleanup Test', terminals: [] });
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([ws]),
        updateWorkspace: vi.fn().mockRejectedValue(new Error('Trash cleanup script failed')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ workspaces: [ws] });

      await useWorkspacesStore.getState().setWorkspaceTrashed('ws-1', true);

      expect(useWorkspacesStore.getState().workspaces[0].status).toBe('active');
      expect(useWorkspacesStore.getState().error).toBe('Trash cleanup script failed');
      expect(useToastStore.getState().toasts[0]?.message).toBe('Trash cleanup script failed');
    });

    it('keeps file-list cache when trash cleanup fails', async () => {
      const workingDirectory = '/mock/workspace';
      const ws = createWorkspace({ id: 'ws-1', workingDirectory, terminals: [] });
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([ws]),
        updateWorkspace: vi.fn().mockRejectedValue(new Error('Trash cleanup script failed')),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({ workspaces: [ws] });
      useFileListStore.setState((state) => {
        const cache = new Map(state.cache);
        cache.set(workingDirectory, {
          files: ['node_modules/pkg/index.js'],
          gitIgnoredFiles: [],
          emptyDirs: [],
          isLoading: false,
        });
        return { cache };
      });

      await useWorkspacesStore.getState().setWorkspaceTrashed('ws-1', true);

      expect(useFileListStore.getState().cache.has(workingDirectory)).toBe(true);
    });

    it('runs bulk trash cleanup sequentially, not in parallel', async () => {
      const ws1 = createWorkspace({ id: 'ws-1', name: 'A', terminals: [] });
      const ws2 = createWorkspace({ id: 'ws-2', name: 'B', terminals: [] });
      const trashed1 = { ...ws1, status: 'trashed' as const };
      const trashed2 = { ...ws2, status: 'trashed' as const };

      // Track concurrency: each update is async, but only one should be in
      // flight at a time. Spike inFlight on entry and assert it never exceeds 1.
      let inFlight = 0;
      let maxInFlight = 0;
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([trashed1, trashed2]),
        updateWorkspace: vi.fn(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
        }),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      await useWorkspacesStore.getState().trashSelectedWorkspaces();

      expect(maxInFlight).toBe(1);
      expect(api.updateWorkspace).toHaveBeenCalledTimes(2);
    });

    it('trashes the given workspaces without touching the selection', async () => {
      const ws1 = createWorkspace({ id: 'ws-1', terminals: [] });
      const ws2 = createWorkspace({ id: 'ws-2', terminals: [] });
      const ws3 = createWorkspace({ id: 'ws-3', terminals: [] });
      const api = createApiMock({
        getWorkspaces: vi
          .fn()
          .mockResolvedValue([
            { ...ws1, status: 'trashed' as const },
            { ...ws2, status: 'trashed' as const },
            ws3,
          ]),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2, ws3],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-3']),
      });

      await useWorkspacesStore.getState().trashWorkspaces(['ws-1', 'ws-2']);

      expect(api.updateWorkspace).toHaveBeenCalledTimes(2);
      expect(api.updateWorkspace).toHaveBeenCalledWith('ws-1', { status: 'trashed' });
      expect(api.updateWorkspace).toHaveBeenCalledWith('ws-2', { status: 'trashed' });
      expect(useWorkspacesStore.getState().selectedWorkspaceIds).toEqual(new Set(['ws-3']));
      expect(useWorkspacesStore.getState().selectionMode).toBe(true);
    });

    it('trashes only successful workspaces in a bulk trash when cleanup fails for one', async () => {
      const ws1 = createWorkspace({ id: 'ws-1', name: 'Works', terminals: [] });
      const ws2 = createWorkspace({ id: 'ws-2', name: 'Fails', terminals: [] });
      const trashedWs1 = { ...ws1, status: 'trashed' as const };
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([trashedWs1, ws2]),
        updateWorkspace: vi.fn((id: string) =>
          id === 'ws-2'
            ? Promise.reject(new Error('Trash cleanup script failed'))
            : Promise.resolve(undefined)
        ),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      await useWorkspacesStore.getState().trashSelectedWorkspaces();

      const updated = useWorkspacesStore.getState().workspaces;
      expect(updated.find((w) => w.id === 'ws-1')?.status).toBe('trashed');
      expect(updated.find((w) => w.id === 'ws-2')?.status).toBe('active');
      expect(useWorkspacesStore.getState().error).toBe(
        'Failed to move Fails to the Trash: Trash cleanup script failed'
      );
      expect(useToastStore.getState().toasts[0]?.message).toBe(
        'Failed to move Fails to the Trash: Trash cleanup script failed'
      );
    });

    it('invalidates file-list cache only for successful workspaces in a bulk trash', async () => {
      const ws1 = createWorkspace({
        id: 'ws-1',
        name: 'Works',
        workingDirectory: '/mock/works',
        terminals: [],
      });
      const ws2 = createWorkspace({
        id: 'ws-2',
        name: 'Fails',
        workingDirectory: '/mock/fails',
        terminals: [],
      });
      const trashedWs1 = { ...ws1, status: 'trashed' as const };
      const api = createApiMock({
        getWorkspaces: vi.fn().mockResolvedValue([trashedWs1, ws2]),
        updateWorkspace: vi.fn((id: string) =>
          id === 'ws-2'
            ? Promise.reject(new Error('Trash cleanup script failed'))
            : Promise.resolve(undefined)
        ),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });
      useFileListStore.setState((state) => {
        const cache = new Map(state.cache);
        cache.set('/mock/works', {
          files: ['node_modules/pkg/index.js'],
          gitIgnoredFiles: [],
          emptyDirs: [],
          isLoading: false,
        });
        cache.set('/mock/fails', {
          files: ['node_modules/pkg/index.js'],
          gitIgnoredFiles: [],
          emptyDirs: [],
          isLoading: false,
        });
        return { cache };
      });

      await useWorkspacesStore.getState().trashSelectedWorkspaces();

      expect(useFileListStore.getState().cache.has('/mock/works')).toBe(false);
      expect(useFileListStore.getState().cache.has('/mock/fails')).toBe(true);
    });

    it('moves all selected workspaces to a target window', async () => {
      const ws1 = createWorkspace({ id: 'ws-1' });
      const ws2 = createWorkspace({ id: 'ws-2' });
      const api = createApiMock();
      (globalThis as { window: { api: ApiMock } }).window = { api };

      useWorkspacesStore.setState({
        workspaces: [ws1, ws2],
        selectionMode: true,
        selectedWorkspaceIds: new Set(['ws-1', 'ws-2']),
      });

      await useWorkspacesStore.getState().moveSelectedToWindow('window-2');

      expect(api.moveWorkspaceToWindow).toHaveBeenCalledWith(
        'ws-1',
        'window-2',
        expect.any(Object)
      );
      expect(api.moveWorkspaceToWindow).toHaveBeenCalledWith(
        'ws-2',
        'window-2',
        expect.any(Object)
      );
      expect(useWorkspacesStore.getState().selectionMode).toBe(false);
    });
  });
});

describe('unsaved edits in file panes', () => {
  const SURFACE_ID = 'surface:file:f1';
  let unregister: () => void;
  let confirm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const ws1 = createWorkspace({
      id: 'ws-1',
      terminals: [createTerminal({ id: 't-1', status: 'running' })],
    });
    const api = createApiMock({
      getWorkspaces: vi.fn().mockResolvedValue([ws1]),
      stopWorkspace: vi.fn().mockResolvedValue(undefined),
      restartWorkspace: vi.fn().mockResolvedValue({}),
      updateWorkspace: vi.fn().mockResolvedValue(undefined),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useWorkspacesStore.setState({ workspaces: [ws1] });
    usePaneSurfacesStore.setState({
      surfaces: { [SURFACE_ID]: { kind: 'file', workspaceId: 'ws-1', path: 'src/app.ts' } },
    });
    setFilePaneDraft(SURFACE_ID, 'edited');
    confirm = vi.fn().mockResolvedValue(false);
    unregister = registerPaneCloseConfirm(confirm);
    return () => {
      unregister();
      setFilePaneDraft(SURFACE_ID, null);
    };
  });

  function api(): ApiMock {
    return (globalThis as unknown as { window: { api: ApiMock } }).window.api;
  }

  it('keeps the workspace running when stopping asks and the edits stay', async () => {
    await useWorkspacesStore.getState().stopWorkspace('ws-1');

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'app.ts has unsaved changes. Discard them?' })
    );
    expect(api().stopWorkspace).not.toHaveBeenCalled();
  });

  it('stops the workspace once the edits may go', async () => {
    confirm.mockResolvedValue(true);

    await useWorkspacesStore.getState().stopWorkspace('ws-1');

    expect(api().stopWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('keeps the workspace running when restarting asks and the edits stay', async () => {
    await useWorkspacesStore.getState().restartWorkspace('ws-1');

    expect(confirm).toHaveBeenCalled();
    expect(api().restartWorkspace).not.toHaveBeenCalled();
  });

  it('keeps the workspace an agent asked to trash without asking about the edits', async () => {
    await useWorkspacesStore.getState().trashWorkspaceForAgent({ workspaceId: 'ws-1' });

    expect(confirm).not.toHaveBeenCalled();
    expect(api().stopWorkspace).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('unsaved files: app.ts');
  });

  it('keeps the workspace when trashing asks and the edits stay', async () => {
    await useWorkspacesStore.getState().setWorkspaceTrashed('ws-1', true);
    await useWorkspacesStore.getState().trashWorkspaces(['ws-1']);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api().stopWorkspace).not.toHaveBeenCalled();
    expect(useWorkspacesStore.getState().workspaces[0].status).toBe('active');
  });
});
