// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/window.store', () => ({
  useWindowStore: {
    getState: () => ({ windowId: 'window-1' }),
  },
}));
vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  disposeTerminalRenderers: vi.fn(),
  getTerminalRendererDimensions: vi.fn(() => undefined),
}));

import { useWorkspaceObservations } from '../../../src/renderer/hooks/useWorkspaceObservations';
import { useFileListStore } from '../../../src/renderer/stores/file-list.store';
import { useGitStatusStore } from '../../../src/renderer/stores/git-status.store';
import { useProjectsStore } from '../../../src/renderer/stores/projects.store';
import { useWorkspaceObservationStore } from '../../../src/renderer/stores/workspace-observation.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createWorkspace } from '../../factories';

import type { WorkspaceObservationProjection } from '../../../src/shared/types';

const persistedProjection: WorkspaceObservationProjection = {
  workspaceId: 'ssh-ws',
  revision: 1,
  repositoryRevision: 0,
  workingTree: {
    files: [
      {
        path: 'src/app.ts',
        status: 'modified',
        staged: false,
        additions: 3,
        deletions: 1,
      },
    ],
    summary: { additions: 3, deletions: 1, filesChanged: 1 },
  },
  branch: {
    currentBranch: 'feature/remote',
    targetBranch: 'release',
    defaultBranch: 'main',
    aheadTargetBranch: 2,
    behindTargetBranch: 0,
    hasRemote: true,
    hasOriginRemote: true,
    unpushedCommits: 1,
    behindRemote: 0,
    targetBranchHasRemote: true,
    targetBranchAheadRemote: 0,
    targetBranchBehindRemote: 0,
  },
  confirmation: {
    kind: 'stale',
    staleSince: 2_000,
    lastConfirmedAt: 1_000,
    reason: 'source-unreachable',
  },
};

describe('useWorkspaceObservations', () => {
  beforeEach(() => {
    useFileListStore.setState(useFileListStore.getInitialState(), true);
    useGitStatusStore.setState(useGitStatusStore.getInitialState(), true);
    useProjectsStore.setState(useProjectsStore.getInitialState(), true);
    useWorkspaceObservationStore.setState(useWorkspaceObservationStore.getInitialState(), true);
    useWorkspacesStore.setState({
      workspaces: [
        createWorkspace({
          id: 'ssh-ws',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          branchName: 'feature/remote',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'git@example.test:repo.git',
            projectName: 'Repo',
          },
        }),
      ],
      selectedWorkspaceId: 'ssh-ws',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getWorkspaceObservations: vi.fn(async () => [persistedProjection]),
        onWorkspaceObservation: vi.fn(() => vi.fn()),
      },
    });
  });

  it('projects the stale startup snapshot into the renderer status adapters', async () => {
    renderHook(() => useWorkspaceObservations());

    await waitFor(() => {
      expect(useWorkspaceObservationStore.getState().projections.get('ssh-ws')).toEqual(
        persistedProjection
      );
    });
    expect(useGitStatusStore.getState().getStatus('ssh-ws')).toMatchObject({
      status: {
        currentBranch: 'feature/remote',
        mainBranch: 'release',
        defaultBranch: 'main',
        aheadTargetBranch: 2,
      },
      isLoading: false,
    });
    expect(
      useFileListStore
        .getState()
        .getDiff('ssh://ssh-dev/home/dev/worktree', undefined, false, 'ssh-ws')
    ).toEqual({
      data: persistedProjection.workingTree,
      isLoading: false,
      hasFullDiff: false,
    });
  });

  it('leaves SSH file diffs to the worktree change that names the changed files', async () => {
    const content = {
      path: 'src/app.ts',
      oldContent: 'old',
      newContent: 'new',
      status: 'modified' as const,
      isBinary: false,
    };
    useFileListStore.setState({
      fileDiffCache: new Map([['workspace:ssh-ws:src/app.ts', { content, isLoading: false }]]),
    });

    renderHook(() => useWorkspaceObservations());

    await waitFor(() => {
      expect(useWorkspaceObservationStore.getState().projections.get('ssh-ws')).toBeDefined();
    });
    expect(
      useFileListStore.getState().fileDiffCache.get('workspace:ssh-ws:src/app.ts')?.isStale
    ).toBeFalsy();
  });
});
