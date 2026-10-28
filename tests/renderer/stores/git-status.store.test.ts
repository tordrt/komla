import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/stores/project-sync-status.store', () => ({
  useProjectSyncStatusStore: {
    getState: () => ({ updateFromWorkspaceStatus: vi.fn() }),
  },
}));

import { useGitStatusStore } from '../../../src/renderer/stores/git-status.store';

function resetStore(): void {
  useGitStatusStore.setState(useGitStatusStore.getInitialState(), true);
}

const mockBranchStatus = {
  behindTargetBranch: 0,
  aheadTargetBranch: 1,
  mainBranch: 'main',
  defaultBranch: 'main',
  hasRemote: true,
  hasOriginRemote: true,
  unpushedCommits: 1,
  behindRemote: 0,
  currentBranch: 'feature',
  targetBranchHasRemote: true,
  targetBranchAheadRemote: 0,
  targetBranchBehindRemote: 0,
};

function mockApi(overrides: Record<string, any> = {}): void {
  (globalThis as any).window = {
    api: {
      getGitBranchStatus: vi.fn().mockResolvedValue(mockBranchStatus),
      getWorkspaceGitBranchStatus: vi.fn().mockResolvedValue(mockBranchStatus),
      ...overrides,
    },
  };
}

describe('git-status.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('hydrates a persisted status as fresh without overwriting live data', async () => {
    const store = useGitStatusStore.getState();
    store.hydrateStatus('ws-1', mockBranchStatus);

    expect(store.getStatus('ws-1')).toMatchObject({
      status: mockBranchStatus,
      isLoading: false,
    });
    expect(store.getStatus('ws-1')?.lastFetched).toBeGreaterThan(0);
    await store.fetchStatusIfStale('ws-1', '/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();

    const liveStatus = { ...mockBranchStatus, aheadTargetBranch: 2 };
    useGitStatusStore.setState({
      statusMap: new Map([['ws-1', { status: liveStatus, lastFetched: 1234, isLoading: false }]]),
    });
    useGitStatusStore.getState().hydrateStatus('ws-1', mockBranchStatus);

    expect(useGitStatusStore.getState().getStatus('ws-1')?.status).toEqual(liveStatus);
  });

  it('discards an in-flight pre-sync status after clearing the behind count', async () => {
    const staleStatus = { ...mockBranchStatus, behindTargetBranch: 2 };
    let resolveStatus!: (status: typeof staleStatus) => void;
    mockApi({
      getWorkspaceGitBranchStatus: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveStatus = resolve;
          })
      ),
    });
    const store = useGitStatusStore.getState();
    store.hydrateStatus('ws-1', staleStatus);
    const pending = store.fetchStatus('ws-1', '/repo');

    store.clearBehindTargetBranch('ws-1', 'main');
    resolveStatus(staleStatus);
    expect(await pending).toBeUndefined();
    expect(store.getStatus('ws-1')?.status).toEqual({ ...staleStatus, behindTargetBranch: 0 });

    store.applyPushedStatus('ws-1', staleStatus);
    expect(store.getStatus('ws-1')?.status).toEqual(staleStatus);
  });

  it('does not clear the count for a different target or create a missing workspace', () => {
    const store = useGitStatusStore.getState();
    const status = { ...mockBranchStatus, behindTargetBranch: 2 };
    store.hydrateStatus('ws-1', status);
    store.clearBehindTargetBranch('ws-1', 'develop');
    store.clearBehindTargetBranch('missing', 'main');
    expect(store.getStatus('ws-1')?.status).toEqual(status);
    expect(store.getStatus('missing')).toBeUndefined();
  });

  it('fetchStatus fetches and caches status', async () => {
    const result = await useGitStatusStore.getState().fetchStatus('ws-1', '/repo');
    expect(result).toEqual(mockBranchStatus);

    const cached = useGitStatusStore.getState().getStatus('ws-1');
    expect(cached?.status).toEqual(mockBranchStatus);
    expect(cached?.isLoading).toBe(false);
    expect(cached?.lastFetched).toBeGreaterThan(0);
  });

  it('shares target-branch remote fields within the same SSH repository scope', async () => {
    const staleSiblingStatus = {
      ...mockBranchStatus,
      currentBranch: 'other-feature',
      aheadTargetBranch: 7,
      targetBranchAheadRemote: 4,
    };
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-2',
          {
            status: staleSiblingStatus,
            lastFetched: 123,
            isLoading: false,
            targetStatusScope: 'ssh:host:/repo.git',
          },
        ],
      ]),
    });

    await useGitStatusStore
      .getState()
      .fetchStatus('ws-1', '/repo/worktree-1', 'project-1', 'ssh:host:/repo.git');

    const sibling = useGitStatusStore.getState().getStatus('ws-2');
    expect(sibling?.status.targetBranchAheadRemote).toBe(0);
    expect(sibling?.status.aheadTargetBranch).toBe(7);
    expect(sibling?.status.currentBranch).toBe('other-feature');
    expect(sibling?.lastFetched).toBe(123);
  });

  it('does not share target-branch remote fields across repositories', async () => {
    const siblingStatus = { ...mockBranchStatus, targetBranchAheadRemote: 4 };
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-2',
          {
            status: siblingStatus,
            lastFetched: 123,
            isLoading: false,
            targetStatusScope: 'ssh:host:/other.git',
          },
        ],
      ]),
    });

    await useGitStatusStore
      .getState()
      .fetchStatus('ws-1', '/repo/worktree-1', 'project-1', 'ssh:host:/repo.git');

    expect(useGitStatusStore.getState().getStatus('ws-2')?.status.targetBranchAheadRemote).toBe(4);
  });

  it('adopts the freshest shared target status when a cached workspace joins a scope', () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: { ...mockBranchStatus, targetBranchAheadRemote: 3 },
            lastFetched: 100,
            isLoading: false,
          },
        ],
        [
          'ws-2',
          {
            status: { ...mockBranchStatus, targetBranchAheadRemote: 0 },
            lastFetched: 200,
            isLoading: false,
            targetStatusScope: 'ssh:host:/repo.git',
          },
        ],
      ]),
    });

    useGitStatusStore.getState().registerTargetStatusScope('ws-1', 'ssh:host:/repo.git');

    expect(useGitStatusStore.getState().getStatus('ws-1')?.status.targetBranchAheadRemote).toBe(0);
  });

  it('keeps a superseded target-scope response from replacing the current status', async () => {
    let resolveOldRequest!: (status: typeof mockBranchStatus) => void;
    let resolveNewRequest!: (status: typeof mockBranchStatus) => void;
    const oldRequest = new Promise<typeof mockBranchStatus>((resolve) => {
      resolveOldRequest = resolve;
    });
    const newRequest = new Promise<typeof mockBranchStatus>((resolve) => {
      resolveNewRequest = resolve;
    });
    mockApi({
      getWorkspaceGitBranchStatus: vi
        .fn()
        .mockReturnValueOnce(oldRequest)
        .mockReturnValueOnce(newRequest),
    });

    const firstFetch = useGitStatusStore
      .getState()
      .fetchStatus('ws-1', '/repo', 'project-1', 'old-scope');
    useGitStatusStore.getState().registerTargetStatusScope('ws-1', 'new-scope');
    const secondFetch = useGitStatusStore
      .getState()
      .fetchStatusIfStale('ws-1', '/repo', 'project-1', 10_000, 'new-scope');

    const newStatus = {
      ...mockBranchStatus,
      mainBranch: 'develop',
      targetBranchAheadRemote: 2,
    };
    resolveNewRequest(newStatus);
    await secondFetch;
    resolveOldRequest({ ...mockBranchStatus, targetBranchAheadRemote: 9 });
    await firstFetch;

    const cached = useGitStatusStore.getState().getStatus('ws-1');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledTimes(2);
    expect(cached?.targetStatusScope).toBe('new-scope');
    expect(cached?.status).toEqual(newStatus);
    expect(cached?.isLoading).toBe(false);
  });

  it('fetchStatus calls workspace-aware branch status', async () => {
    await useGitStatusStore.getState().fetchStatus('ws-1', '/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).toHaveBeenCalledWith(
      'ws-1',
      undefined
    );
    expect(globalThis.window.api.getGitBranchStatus).not.toHaveBeenCalled();
  });

  it('fetchStatus handles errors gracefully', async () => {
    mockApi({ getWorkspaceGitBranchStatus: vi.fn().mockRejectedValue(new Error('Git error')) });

    // Pre-populate so error path has existing entry
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: mockBranchStatus,
            lastFetched: 1000,
            isLoading: false,
          },
        ],
      ]),
    });

    const result = await useGitStatusStore.getState().fetchStatus('ws-1', '/repo');
    expect(result).toBeUndefined();
    expect(useGitStatusStore.getState().getStatus('ws-1')?.isLoading).toBe(false);
  });

  it('fetchStatusIfStale skips if already loading', async () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: mockBranchStatus,
            lastFetched: Date.now(),
            isLoading: true,
          },
        ],
      ]),
    });
    await useGitStatusStore.getState().fetchStatusIfStale('ws-1', '/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();
  });

  it('fetchStatusIfStale skips if cache is fresh', async () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: mockBranchStatus,
            lastFetched: Date.now(),
            isLoading: false,
          },
        ],
      ]),
    });
    await useGitStatusStore.getState().fetchStatusIfStale('ws-1', '/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();
  });

  it('fetchStatusIfStale fetches when cache is stale', async () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: mockBranchStatus,
            lastFetched: 0,
            isLoading: false,
          },
        ],
      ]),
    });
    await useGitStatusStore.getState().fetchStatusIfStale('ws-1', '/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).toHaveBeenCalled();
  });

  it('does not poll companion-backed workspaces', async () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: mockBranchStatus,
            lastFetched: Date.now() - 60_000,
            isLoading: false,
          },
        ],
      ]),
    });

    await useGitStatusStore.getState().fetchStatusIfStale('ws-1', 'ssh://host/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();

    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: mockBranchStatus,
            lastFetched: Date.now() - 301_000,
            isLoading: false,
          },
        ],
      ]),
    });
    await useGitStatusStore.getState().fetchStatusIfStale('ws-1', 'ssh://host/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).not.toHaveBeenCalled();
  });

  it('fetchStatusIfStale fetches when no cache exists', async () => {
    await useGitStatusStore.getState().fetchStatusIfStale('ws-1', '/repo');
    expect(globalThis.window.api.getWorkspaceGitBranchStatus).toHaveBeenCalled();
  });

  it('invalidateStatus sets lastFetched to 0', () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        [
          'ws-1',
          {
            status: mockBranchStatus,
            lastFetched: 5000,
            isLoading: false,
          },
        ],
      ]),
    });
    useGitStatusStore.getState().invalidateStatus('ws-1');
    expect(useGitStatusStore.getState().getStatus('ws-1')?.lastFetched).toBe(0);
  });

  it('invalidateStatus is a no-op for unknown workspace', () => {
    useGitStatusStore.getState().invalidateStatus('unknown');
    expect(useGitStatusStore.getState().statusMap.size).toBe(0);
  });

  it('cleanup removes workspace from statusMap', () => {
    useGitStatusStore.setState({
      statusMap: new Map([
        ['ws-1', { status: mockBranchStatus, lastFetched: 1000, isLoading: false }],
      ]),
    });
    useGitStatusStore.getState().cleanup('ws-1');
    expect(useGitStatusStore.getState().getStatus('ws-1')).toBeUndefined();
  });

  it('getStatus returns undefined for unknown workspace', () => {
    expect(useGitStatusStore.getState().getStatus('unknown')).toBeUndefined();
  });
});
