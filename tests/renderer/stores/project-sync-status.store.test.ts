import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectSyncStatusStore } from '../../../src/renderer/stores/project-sync-status.store';

function resetStore(): void {
  useProjectSyncStatusStore.setState(useProjectSyncStatusStore.getInitialState(), true);
}

function mockApi(overrides: Record<string, any> = {}): void {
  (globalThis as any).window = {
    api: {
      getAllProjectSyncStatuses: vi.fn().mockResolvedValue([
        {
          projectId: 'p-1',
          hasRemote: true,
          behindRemote: 2,
          aheadRemote: 1,
          lastFetched: 1000,
          mainBranch: 'main',
        },
        {
          projectId: 'p-2',
          hasRemote: false,
          behindRemote: 0,
          aheadRemote: 0,
          lastFetched: 2000,
          mainBranch: 'master',
        },
      ]),
      refreshProjectSyncStatus: vi.fn().mockResolvedValue({
        projectId: 'p-1',
        hasRemote: true,
        behindRemote: 0,
        aheadRemote: 0,
        lastFetched: 3000,
        mainBranch: 'main',
      }),
      ...overrides,
    },
  };
}

describe('project-sync-status.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadAllStatuses fetches all project statuses', async () => {
    await useProjectSyncStatusStore.getState().loadAllStatuses();
    const state = useProjectSyncStatusStore.getState();
    expect(state.statuses.size).toBe(2);
    expect(state.statuses.get('p-1')?.behindRemote).toBe(2);
    expect(state.statuses.get('p-2')?.mainBranch).toBe('master');
    expect(state.isLoading).toBe(false);
  });

  it('loadAllStatuses handles errors', async () => {
    mockApi({ getAllProjectSyncStatuses: vi.fn().mockRejectedValue(new Error('Failed')) });
    await useProjectSyncStatusStore.getState().loadAllStatuses();
    expect(useProjectSyncStatusStore.getState().isLoading).toBe(false);
  });

  it('refreshStatus updates existing project status', async () => {
    // Set up initial status
    useProjectSyncStatusStore.setState({
      statuses: new Map([
        [
          'p-1',
          {
            projectId: 'p-1',
            hasRemote: true,
            behindRemote: 2,
            aheadRemote: 1,
            lastFetched: 1000,
            mainBranch: 'main',
            defaultBranch: 'main',
            isFetching: false,
          },
        ],
      ]),
    });

    await useProjectSyncStatusStore.getState().refreshStatus('p-1');
    const status = useProjectSyncStatusStore.getState().statuses.get('p-1');
    expect(status?.behindRemote).toBe(0);
    expect(status?.isFetching).toBe(false);
  });

  it('refreshStatus creates placeholder for unknown project', async () => {
    mockApi({
      refreshProjectSyncStatus: vi.fn().mockResolvedValue({
        projectId: 'p-new',
        hasRemote: false,
        behindRemote: 0,
        aheadRemote: 0,
        lastFetched: 3000,
        mainBranch: 'main',
      }),
    });
    await useProjectSyncStatusStore.getState().refreshStatus('p-new');
    const status = useProjectSyncStatusStore.getState().statuses.get('p-new');
    expect(status).toBeDefined();
    expect(status?.isFetching).toBe(false);
  });

  it('refreshStatus handles null result', async () => {
    mockApi({ refreshProjectSyncStatus: vi.fn().mockResolvedValue(null) });
    useProjectSyncStatusStore.setState({
      statuses: new Map([
        [
          'p-1',
          {
            projectId: 'p-1',
            hasRemote: true,
            behindRemote: 2,
            aheadRemote: 1,
            lastFetched: 1000,
            mainBranch: 'main',
            defaultBranch: 'main',
            isFetching: false,
          },
        ],
      ]),
    });

    await useProjectSyncStatusStore.getState().refreshStatus('p-1');
    const status = useProjectSyncStatusStore.getState().statuses.get('p-1');
    expect(status?.isFetching).toBe(false);
    expect(status?.behindRemote).toBe(2); // unchanged
  });

  it('refreshStatus handles errors and clears fetching state', async () => {
    mockApi({ refreshProjectSyncStatus: vi.fn().mockRejectedValue(new Error('Fetch failed')) });
    useProjectSyncStatusStore.setState({
      statuses: new Map([
        [
          'p-1',
          {
            projectId: 'p-1',
            hasRemote: true,
            behindRemote: 2,
            aheadRemote: 1,
            lastFetched: 1000,
            mainBranch: 'main',
            defaultBranch: 'main',
            isFetching: false,
          },
        ],
      ]),
    });

    await useProjectSyncStatusStore.getState().refreshStatus('p-1');
    expect(useProjectSyncStatusStore.getState().statuses.get('p-1')?.isFetching).toBe(false);
  });

  it('getStatus returns status for project', () => {
    useProjectSyncStatusStore.setState({
      statuses: new Map([
        [
          'p-1',
          {
            projectId: 'p-1',
            hasRemote: true,
            behindRemote: 2,
            aheadRemote: 1,
            lastFetched: 1000,
            mainBranch: 'main',
            defaultBranch: 'main',
            isFetching: false,
          },
        ],
      ]),
    });
    expect(useProjectSyncStatusStore.getState().getStatus('p-1')?.behindRemote).toBe(2);
    expect(useProjectSyncStatusStore.getState().getStatus('missing')).toBeUndefined();
  });

  it('updateFromWorkspaceStatus creates or updates project status', () => {
    useProjectSyncStatusStore.getState().updateFromWorkspaceStatus('p-1', {
      hasRemote: false,
      aheadRemote: 3,
      behindRemote: 1,
      mainBranch: 'main',
      defaultBranch: 'develop',
    });
    const status = useProjectSyncStatusStore.getState().statuses.get('p-1');
    expect(status?.aheadRemote).toBe(3);
    expect(status?.behindRemote).toBe(1);
    expect(status?.hasRemote).toBe(false);
    expect(status?.defaultBranch).toBe('develop');
    expect(status?.lastFetched).toBeNull();
    expect(status?.isFetching).toBe(false);
  });

  it('updateFromWorkspaceStatus preserves existing lastFetched and isFetching', () => {
    useProjectSyncStatusStore.setState({
      statuses: new Map([
        [
          'p-1',
          {
            projectId: 'p-1',
            hasRemote: true,
            behindRemote: 2,
            aheadRemote: 1,
            lastFetched: 5000,
            mainBranch: 'main',
            defaultBranch: 'main',
            isFetching: true,
          },
        ],
      ]),
    });

    useProjectSyncStatusStore.getState().updateFromWorkspaceStatus('p-1', {
      hasRemote: false,
      aheadRemote: 0,
      behindRemote: 0,
      mainBranch: 'main',
      defaultBranch: 'main',
    });
    const status = useProjectSyncStatusStore.getState().statuses.get('p-1');
    expect(status?.hasRemote).toBe(false);
    expect(status?.lastFetched).toBe(5000);
    expect(status?.isFetching).toBe(true);
  });
});
