import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as { gitBackgroundFetch?: boolean },
  projects: [] as Array<Record<string, unknown>>,
  workspaces: [] as Array<Record<string, unknown>>,
  hasRemote: vi.fn(),
  fetch: vi.fn(),
  // Marks are taken before the origin check, which a workspace creation can then stop.
  backgroundMark: vi.fn((repoPath: string) => (repoPath === '/p/own' ? 2 : 1)),
  hostStates: new Map<string, 'connected' | 'unreachable'>(),
  sshFetch: vi.fn(),
  statusChange: vi.fn(),
  companionHostIds: new Set<string>(),
  deletingIds: new Set<string>(),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => mocks.config },
}));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: { list: () => mocks.projects },
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: {
    list: () => mocks.workspaces,
    isDeleting: (workspaceId: string) => mocks.deletingIds.has(workspaceId),
  },
}));
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: {
    hasRemote: mocks.hasRemote,
    fetchOriginWithoutPrompts: mocks.fetch,
    backgroundMark: mocks.backgroundMark,
  },
}));
vi.mock('../../../src/main/services/remote-workspace-observation.service', () => ({
  remoteWorkspaceObservationService: {
    companionForHost: (hostId: string) => (mocks.companionHostIds.has(hostId) ? {} : undefined),
  },
}));
vi.mock('../../../src/main/services/ssh-host-status.service', () => ({
  isSshConnectionFailure: (error: { code?: unknown }) => error.code === 255,
  sshHostStatusService: {
    get: (hostId: string) => {
      const state = mocks.hostStates.get(hostId);
      return state && { hostId, state, checkedAt: 0 };
    },
  },
}));
vi.mock('../../../src/main/services/workspace-git/ssh-git', () => ({
  sshWorkspaceGit: { fetchOriginWithoutPrompts: mocks.sshFetch },
}));
vi.mock('../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: { change: mocks.statusChange },
}));
vi.mock('../../../src/shared/lib/terminal-execution-state', () => ({
  isMonitored: (workspace: { monitored?: boolean }) => workspace.monitored === true,
}));

const base = { createdAt: 0, order: 0, defaultBranchPrefix: '' };

describe('gitBackgroundFetchService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.config = {};
    mocks.projects = [
      {
        ...base,
        id: 'managed',
        managed: true,
        repositoryPath: '/p/m',
        managedRepoPath: '/p/m.git',
      },
      { ...base, id: 'own', managed: false, repositoryPath: '/p/own' },
      { ...base, id: 'unused', managed: false, repositoryPath: '/p/unused' },
      { ...base, id: 'folder', kind: 'directory', managed: false, repositoryPath: '/p/folder' },
      { ...base, id: 'ssh-only', managed: false, repositoryPath: '/p/ssh' },
    ];
    mocks.workspaces = [
      { id: 'w1', projectId: 'managed' },
      { id: 'w2', projectId: 'own' },
      { id: 'w3', projectId: 'folder' },
      { id: 'w4', projectId: 'ssh-only', backend: { kind: 'ssh', hostId: 'h' } },
    ];
    mocks.hasRemote.mockReset().mockResolvedValue(true);
    mocks.fetch.mockReset().mockResolvedValue(undefined);
    mocks.hostStates = new Map();
    mocks.sshFetch.mockReset().mockResolvedValue(false);
    mocks.statusChange.mockReset().mockResolvedValue(undefined);
    mocks.companionHostIds = new Set();
    mocks.deletingIds = new Set();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches origin for git projects with local workspaces', async () => {
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();

    expect(mocks.fetch.mock.calls).toEqual([
      ['/p/m.git', true, 20_000, 1],
      ['/p/own', false, 20_000, 2],
    ]);
  });

  it('skips repositories fetched in the last five minutes, and ones without origin', async () => {
    mocks.hasRemote.mockImplementation(async (repoPath: string) => repoPath !== '/p/own');
    const { gitBackgroundFetchService, BACKGROUND_FETCH_INTERVAL_MS } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();
    await gitBackgroundFetchService.fetchStale();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(BACKGROUND_FETCH_INTERVAL_MS);
    await gitBackgroundFetchService.fetchStale();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a fetch fails', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('Permission denied (publickey)'));
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('does nothing when background fetch is off', async () => {
    mocks.config = { gitBackgroundFetch: false };
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  describe('on SSH hosts', () => {
    const ssh = (id: string, hostId: string, remoteRepoPath: string, extra = {}) => ({
      id,
      projectId: 'ssh-only',
      backend: { kind: 'ssh', hostId, remoteRepoPath, remoteDirectory: `${remoteRepoPath}/${id}` },
      ...extra,
    });

    beforeEach(() => {
      mocks.workspaces = [
        ssh('s1', 'h1', '/r/app'),
        ssh('s2', 'h1', '/r/app', { monitored: true }),
        ssh('s3', 'h1', '/r/other'),
        ssh('s4', 'h2', '/r/app'),
        { ...ssh('s5', 'h1', '/r/folder'), projectId: 'folder' },
      ];
    });

    it('fetches each clone once, only on hosts Komla has reached', async () => {
      mocks.hostStates.set('h1', 'connected').set('h2', 'unreachable');
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchStale();

      expect(mocks.sshFetch.mock.calls).toEqual([
        ['h1', '/r/app', 20_000],
        ['h1', '/r/other', 20_000],
      ]);
      expect(mocks.statusChange).not.toHaveBeenCalled();
    });

    it("refreshes the workspaces the Remote Companion doesn't watch when origin moved", async () => {
      mocks.hostStates.set('h1', 'connected');
      mocks.companionHostIds.add('h1');
      mocks.sshFetch.mockImplementation(async (_hostId: string, repoPath: string) => {
        return repoPath === '/r/app';
      });
      mocks.statusChange.mockRejectedValueOnce(new Error('Workspace s1 not found'));
      mocks.workspaces.splice(1, 0, ssh('s0', 'h1', '/r/app'), ssh('gone', 'h1', '/r/app'));
      mocks.deletingIds.add('gone');
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchStale();

      expect(mocks.statusChange.mock.calls).toEqual([
        [{ kind: 'refresh-requested', workspaceId: 's1', reason: 'fetched' }],
        [{ kind: 'refresh-requested', workspaceId: 's0', reason: 'fetched' }],
      ]);
    });

    it('refreshes watched workspaces too while their host has no Remote Companion', async () => {
      mocks.hostStates.set('h1', 'connected');
      mocks.sshFetch.mockImplementation(async (_hostId: string, repoPath: string) => {
        return repoPath === '/r/app';
      });
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchStale();

      expect(mocks.statusChange.mock.calls.map(([change]) => change.workspaceId)).toEqual([
        's1',
        's2',
      ]);
    });

    it('fetches again as soon as a host that dropped mid-fetch answers', async () => {
      mocks.hostStates.set('h2', 'connected');
      mocks.sshFetch
        .mockRejectedValueOnce(Object.assign(new Error('Connection reset'), { code: 255 }))
        .mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 128 }));
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchStaleOnSshHosts();
      await gitBackgroundFetchService.fetchStaleOnSshHosts();
      // A remote that refused the fetch waits out the interval like any other.
      await gitBackgroundFetchService.fetchStaleOnSshHosts();

      expect(mocks.sshFetch).toHaveBeenCalledTimes(2);
    });

    it('fetches a host reached during a run once that run ends', async () => {
      let finishLocal!: () => void;
      mocks.fetch.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishLocal = resolve))
      );
      mocks.workspaces.push({ id: 'w1', projectId: 'managed' });
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      const first = gitBackgroundFetchService.fetchStale();
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
      mocks.hostStates.set('h2', 'connected');
      const second = gitBackgroundFetchService.fetchStaleOnSshHosts();
      expect(mocks.sshFetch).not.toHaveBeenCalled();
      finishLocal();
      await Promise.all([first, second]);

      expect(mocks.sshFetch.mock.calls).toEqual([['h2', '/r/app', 20_000]]);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('leaves local repositories alone when a host answers', async () => {
      mocks.hostStates.set('h2', 'connected');
      mocks.workspaces.push({ id: 'w1', projectId: 'managed' });
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchStaleOnSshHosts();

      expect(mocks.sshFetch.mock.calls).toEqual([['h2', '/r/app', 20_000]]);
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  });
});
