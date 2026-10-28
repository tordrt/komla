// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Mock window.store before any store imports (useWorkspacesStore depends on it)
vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));
vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderers: vi.fn(),
  getTerminalRendererDimensions: vi.fn(() => undefined),
}));

import { useFileListStore } from '../../../src/renderer/stores/file-list.store';
import { useGitStatusStore } from '../../../src/renderer/stores/git-status.store';
import { useWorktreeEventsStore } from '../../../src/renderer/stores/worktree-events.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createWorkspace } from '../../factories';
import { useWorktreeWatcher } from '../../../src/renderer/hooks/useWorktreeWatcher';

function createApiMock() {
  return {
    onWorktreeChanged: vi.fn(),
    updateWorkspace: vi.fn(),
    getWorkspaceGitBranchStatus: vi.fn().mockResolvedValue({
      behindTargetBranch: 0,
      aheadTargetBranch: 0,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 0,
      behindRemote: 0,
      currentBranch: 'feature',
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    }),
    listFiles: vi.fn().mockResolvedValue({ files: [], gitIgnoredFiles: [] }),
    listWorkspaceFiles: vi.fn().mockResolvedValue({ files: [], gitIgnoredFiles: [] }),
    getDiff: vi.fn().mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    }),
    getDiffAgainstBranch: vi.fn().mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    }),
    getFileDiffContent: vi.fn(),
    getFileDiffContentAgainstBranch: vi.fn(),
    getChangedFilesWithSummary: vi
      .fn()
      .mockResolvedValue({ files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } }),
  };
}

function installApi(api: ReturnType<typeof createApiMock>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: api,
  });
}

function resetStores(): void {
  useFileListStore.setState(useFileListStore.getInitialState(), true);
  useGitStatusStore.setState(useGitStatusStore.getInitialState(), true);
  useWorktreeEventsStore.setState(useWorktreeEventsStore.getInitialState(), true);
  // Partial update to preserve action functions (setState with `true` would wipe them)
  useWorkspacesStore.setState({ workspaces: [], selectedWorkspaceId: null });
}

function makeDiffEntry(overrides: Record<string, unknown> = {}) {
  return {
    data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
    isLoading: false,
    hasFullDiff: false,
    ...overrides,
  };
}

/**
 * Simulate the exact logic from useWorktreeWatcher's onWorktreeChanged callback.
 * This avoids needing React rendering while testing the same invalidation logic.
 */
async function simulateWorktreeChange(
  workspaceId: string,
  changeTypes: string[],
  activityAt?: number,
  pushedFileStatus?: {
    files: Array<{
      path: string;
      status: string;
      staged: boolean;
      additions: number;
      deletions: number;
    }>;
    summary: { additions: number; deletions: number; filesChanged: number };
  }
) {
  const workspacesStore = useWorkspacesStore.getState();
  const workspace = workspacesStore.workspaces.find((w) => w.id === workspaceId);
  if (!workspace?.workingDirectory) return;
  const isGitWorkspace = workspace.isWorktree;
  useWorktreeEventsStore.getState().recordEvent(workspaceId);

  const fileListStore = useFileListStore.getState();
  const hasFileChange = changeTypes.includes('file');
  const hasGitHeadChange = changeTypes.includes('git-head');
  const hasGitBranchChange = changeTypes.includes('git-branch');

  if (activityAt !== undefined) {
    workspacesStore.updateWorkspace(workspaceId, { lastActivityAt: activityAt });
  }

  const needsFileStatusRefresh = hasFileChange || hasGitHeadChange || hasGitBranchChange;
  if (needsFileStatusRefresh) {
    fileListStore.invalidateFileDiffs(workspace.workingDirectory);
    fileListStore.invalidateBranchComparisonDiffs(workspace.workingDirectory);

    if (pushedFileStatus) {
      fileListStore.applyPushedFileStatus(workspace.workingDirectory, pushedFileStatus as never);
    } else if (hasFileChange || hasGitBranchChange) {
      fileListStore.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
    }

    if (fileListStore.getFileList(workspace.workingDirectory)) {
      fileListStore.fetchFileList(workspace.workingDirectory).catch(() => {});
    }
  }

  if (!isGitWorkspace) return;

  const needsBranchRefresh = hasGitHeadChange || hasGitBranchChange;
  if (needsBranchRefresh) {
    const { fetchStatus } = useGitStatusStore.getState();
    const status = await fetchStatus(workspaceId, workspace.workingDirectory, workspace.projectId);

    if (status?.currentBranch && status.currentBranch !== workspace.branchName) {
      useWorkspacesStore
        .getState()
        .updateWorkspace(workspaceId, { branchName: status.currentBranch });
      window.api.updateWorkspace(workspaceId, { branchName: status.currentBranch });
    }
  }
}

describe('useWorktreeWatcher invalidation logic', () => {
  beforeEach(() => {
    resetStores();
    const api = createApiMock();
    installApi(api);
  });

  function setupWorkspace(overrides: Record<string, unknown> = {}) {
    const ws = createWorkspace({
      id: 'ws-1',
      workingDirectory: '/repo',
      branchName: 'feature',
      ...overrides,
    });
    useWorkspacesStore.setState({ workspaces: [ws] });
    return ws;
  }

  function setupSshWatcher() {
    const api = createApiMock();
    let onChanged: ((...args: unknown[]) => Promise<void>) | undefined;
    api.onWorktreeChanged.mockImplementation((callback) => {
      onChanged = callback;
      return vi.fn();
    });
    installApi(api);
    const workingDirectory = 'ssh://ssh-dev/home/dev/worktree';
    setupWorkspace({
      workingDirectory,
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
    useFileListStore.setState({
      cache: new Map([
        [
          workingDirectory,
          {
            files: ['old.ts'],
            gitIgnoredFiles: [],
            emptyDirs: [],
            isLoading: false,
            fileListHash: 'listed',
          },
        ],
      ]),
    });
    renderHook(() => useWorktreeWatcher());
    expect(onChanged).toBeDefined();
    return { api, workingDirectory, change: (...args: unknown[]) => onChanged?.(...args) };
  }

  it('marks cached SSH file lists stale instead of re-listing them over SSH', async () => {
    const { api, workingDirectory, change } = setupSshWatcher();

    await act(async () => {
      await change('ws-1', ['file'], undefined, undefined, undefined);
    });

    expect(useFileListStore.getState().getFileList(workingDirectory)).toMatchObject({
      files: ['old.ts'],
      isStale: true,
    });
    expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(api.listFiles).not.toHaveBeenCalled();
    expect(api.getChangedFilesWithSummary).not.toHaveBeenCalled();
  });

  it('keeps an SSH list and the diffs of unnamed files when the Remote Companion reports', async () => {
    const { workingDirectory, change } = setupSshWatcher();
    const content = {
      path: '',
      oldContent: 'old',
      newContent: 'new',
      status: 'modified' as const,
      isBinary: false,
    };
    useFileListStore.setState({
      fileDiffCache: new Map([
        ['workspace:ws-1:src/app.ts', { content, isLoading: false }],
        ['workspace:ws-1:README.md', { content, isLoading: false }],
      ]),
    });

    await act(async () => {
      await change('ws-1', ['file'], undefined, undefined, undefined, {
        fileListHash: 'listed',
        changedPaths: ['src/app.ts'],
      });
    });

    const { getFileList, fileDiffCache } = useFileListStore.getState();
    expect(getFileList(workingDirectory)?.isStale).toBeFalsy();
    expect(fileDiffCache.get('workspace:ws-1:src/app.ts')?.isStale).toBe(true);
    expect(fileDiffCache.get('workspace:ws-1:README.md')?.isStale).toBeFalsy();
  });

  describe('branch comparison diffs invalidated on file-relevant changes', () => {
    it('records the last worktree event timestamp for the workspace', async () => {
      setupWorkspace();

      expect(useWorktreeEventsStore.getState().lastEventByWorkspace['ws-1']).toBeUndefined();

      await simulateWorktreeChange('ws-1', ['file']);

      expect(useWorktreeEventsStore.getState().lastEventByWorkspace['ws-1']).toEqual(
        expect.any(Number)
      );
    });

    it('clears branch comparison diffs on file change', async () => {
      setupWorkspace();

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set('/repo', makeDiffEntry({ hasFullDiff: true }));
        diffCache.set('/repo:main', makeDiffEntry({ hasFullDiff: true }));
        diffCache.set('/repo:develop', makeDiffEntry({ hasFullDiff: true }));
        return { diffCache };
      });

      await simulateWorktreeChange('ws-1', ['file'], undefined, {
        files: [
          { path: 'src/index.ts', status: 'modified', staged: false, additions: 1, deletions: 0 },
        ],
        summary: { additions: 1, deletions: 0, filesChanged: 1 },
      });

      // Branch comparison entries preserved but marked stale
      expect(useFileListStore.getState().diffCache.get('/repo:main')?.hasFullDiff).toBe(false);
      expect(useFileListStore.getState().diffCache.get('/repo:develop')?.hasFullDiff).toBe(false);
      // Base diff preserved (updated by applyPushedFileStatus)
      expect(useFileListStore.getState().diffCache.has('/repo')).toBe(true);
    });

    it('clears branch comparison diffs on git-head change (commit)', async () => {
      setupWorkspace();

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(
          '/repo:main',
          makeDiffEntry({
            data: {
              files: [{ path: 'old.ts', status: 'modified' }],
              summary: { additions: 5, deletions: 2, filesChanged: 1 },
            },
            hasFullDiff: true,
          })
        );
        return { diffCache };
      });

      await simulateWorktreeChange('ws-1', ['git-head'], undefined, {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });

      // Branch comparison entry preserved but marked stale
      expect(useFileListStore.getState().diffCache.get('/repo:main')?.hasFullDiff).toBe(false);
      expect(useFileListStore.getState().diffCache.get('/repo:main')?.data).toBeDefined();
    });

    it('marks branch comparison diffs stale on git-branch change (commit ref update)', async () => {
      setupWorkspace();

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set('/repo:main', makeDiffEntry({ hasFullDiff: true }));
        return { diffCache };
      });

      // git-branch (e.g. refs/heads/<branch> update after commit) triggers file status refresh
      await simulateWorktreeChange('ws-1', ['git-branch']);

      // Branch comparison entry preserved but marked stale
      expect(useFileListStore.getState().diffCache.get('/repo:main')?.hasFullDiff).toBe(false);
    });
  });

  describe('hasFullDiff cleared by applyPushedFileStatus', () => {
    it('marks base diff text as stale when pushed status is applied', async () => {
      setupWorkspace();

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(
          '/repo',
          makeDiffEntry({
            data: {
              files: [{ path: 'a.ts', status: 'modified' }],
              summary: { additions: 1, deletions: 0, filesChanged: 1 },
            },
            hasFullDiff: true,
          })
        );
        return { diffCache };
      });

      await simulateWorktreeChange('ws-1', ['file'], Date.now(), {
        files: [
          { path: 'a.ts', status: 'modified', staged: false, additions: 3, deletions: 1 },
          { path: 'b.ts', status: 'added', staged: false, additions: 10, deletions: 0 },
        ],
        summary: { additions: 13, deletions: 1, filesChanged: 2 },
      });

      const cached = useFileListStore.getState().diffCache.get('/repo')!;
      expect(cached.hasFullDiff).toBe(false);
      // File list and summary are updated immediately
      expect(cached.data.files).toHaveLength(2);
      expect(cached.data.summary.additions).toBe(13);
    });
  });

  describe('per-file diff cache cleared on changes', () => {
    it('clears all per-file diff content on file change', async () => {
      setupWorkspace();

      useFileListStore.setState((state) => {
        const fileDiffCache = new Map(state.fileDiffCache);
        fileDiffCache.set('/repo:src/a.ts:false', {
          content: {
            path: 'src/a.ts',
            oldContent: 'old',
            newContent: 'new',
            status: 'modified' as const,
            isBinary: false,
          },
          isLoading: false,
        });
        fileDiffCache.set('/repo:src/b.ts:true', {
          content: {
            path: 'src/b.ts',
            oldContent: null,
            newContent: 'staged',
            status: 'added' as const,
            isBinary: false,
          },
          isLoading: false,
        });
        return { fileDiffCache };
      });

      await simulateWorktreeChange('ws-1', ['file'], undefined, {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });

      expect(useFileListStore.getState().fileDiffCache.get('/repo:src/a.ts:false')?.isStale).toBe(
        true
      );
      expect(useFileListStore.getState().fileDiffCache.get('/repo:src/b.ts:true')?.isStale).toBe(
        true
      );
    });

    it('clears per-file diff content on git-head change', async () => {
      setupWorkspace();

      useFileListStore.setState((state) => {
        const fileDiffCache = new Map(state.fileDiffCache);
        fileDiffCache.set('/repo:x.ts:false', {
          content: {
            path: 'x.ts',
            oldContent: 'a',
            newContent: 'b',
            status: 'modified' as const,
            isBinary: false,
          },
          isLoading: false,
        });
        return { fileDiffCache };
      });

      await simulateWorktreeChange('ws-1', ['git-head'], undefined, {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });

      expect(useFileListStore.getState().fileDiffCache.get('/repo:x.ts:false')?.isStale).toBe(true);
    });
  });

  describe('file-list.store diff summary updated on file changes', () => {
    it('updates diff summary in file-list.store on file change with pushed status', async () => {
      setupWorkspace();

      await simulateWorktreeChange('ws-1', ['file'], undefined, {
        files: [{ path: 'x.ts', status: 'modified', staged: false, additions: 7, deletions: 3 }],
        summary: { additions: 7, deletions: 3, filesChanged: 1 },
      });

      const diff = useFileListStore.getState().diffCache.get('/repo');
      expect(diff?.data.summary.additions).toBe(7);
      expect(diff?.data.summary.deletions).toBe(3);
    });
  });

  describe('non-git workspaces', () => {
    it('still invalidates file diffs for non-git workspaces', async () => {
      setupWorkspace({ branchName: undefined });

      useFileListStore.setState((state) => {
        const fileDiffCache = new Map(state.fileDiffCache);
        fileDiffCache.set('/repo:file.txt:false', {
          content: {
            path: 'file.txt',
            oldContent: null,
            newContent: null,
            status: 'modified' as const,
            isBinary: false,
          },
          isLoading: false,
        });
        return { fileDiffCache };
      });

      await simulateWorktreeChange('ws-1', ['file'], undefined, {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });

      expect(useFileListStore.getState().fileDiffCache.get('/repo:file.txt:false')?.isStale).toBe(
        true
      );
    });

    it('does not trigger git status fetch for non-git workspaces', async () => {
      setupWorkspace({ branchName: undefined });
      const api = window.api as unknown as ReturnType<typeof createApiMock>;

      await simulateWorktreeChange('ws-1', ['file'], undefined, {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });

      expect(api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();
    });
  });

  describe('combined change types', () => {
    it('handles file + git-head together (commit that also changes files)', async () => {
      setupWorkspace();

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set('/repo', makeDiffEntry({ hasFullDiff: true }));
        diffCache.set('/repo:main', makeDiffEntry({ hasFullDiff: true }));

        const fileDiffCache = new Map(state.fileDiffCache);
        fileDiffCache.set('/repo:a.ts:false', {
          content: {
            path: 'a.ts',
            oldContent: null,
            newContent: null,
            status: 'modified' as const,
            isBinary: false,
          },
          isLoading: false,
        });

        return { diffCache, fileDiffCache };
      });

      await simulateWorktreeChange('ws-1', ['file', 'git-head'], undefined, {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });

      // Branch comparison entry preserved but marked stale
      expect(useFileListStore.getState().diffCache.get('/repo:main')?.hasFullDiff).toBe(false);
      expect(useFileListStore.getState().fileDiffCache.get('/repo:a.ts:false')?.isStale).toBe(true);
      // Base diff updated with empty post-commit state
      const baseDiff = useFileListStore.getState().diffCache.get('/repo')!;
      expect(baseDiff.data.files).toHaveLength(0);
      expect(baseDiff.hasFullDiff).toBe(false);
    });
  });
});
