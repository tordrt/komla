import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {} as { gitBackgroundFetch?: boolean },
  projects: [] as Array<Record<string, unknown>>,
  workspaces: [] as Array<Record<string, unknown>>,
  hasRemote: vi.fn(),
  mainBranch: vi.fn(),
  fetch: vi.fn(),
  fastForwardTargets: vi.fn(),
  // Marks are taken before the origin check, which a workspace creation can then stop.
  backgroundMark: vi.fn((repoPath: string) => (repoPath === '/p/own' ? 2 : 1)),
  hostStates: new Map<string, 'connected' | 'unreachable'>(),
  sshFetch: vi.fn(),
  statusChange: vi.fn(),
  companionHostIds: new Set<string>(),
  deletingIds: new Set<string>(),
  basePaths: new Map<string, string>(),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => mocks.config },
}));
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: {
    list: () => mocks.projects,
    get: (projectId: string) => mocks.projects.find((project) => project.id === projectId),
  },
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
    getMainBranch: mocks.mainBranch,
    fetchOriginWithoutPrompts: mocks.fetch,
    backgroundMark: mocks.backgroundMark,
  },
}));
vi.mock('../../../src/main/services/workspace-git.service', () => ({
  workspaceGitService: { fastForwardProjectTargets: mocks.fastForwardTargets },
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
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    knownWorkspaceBasePath: (hostId: string) => mocks.basePaths.get(hostId),
    managedRepoPath: (basePath: string, projectName: string) =>
      `${basePath}/repos/${projectName}/repo.git`,
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
      { ...base, id: 'ssh-only', name: 'app', managed: false, repositoryPath: '/p/ssh' },
    ];
    mocks.workspaces = [
      { id: 'w1', projectId: 'managed' },
      { id: 'w2', projectId: 'own' },
      { id: 'w3', projectId: 'folder' },
      { id: 'w4', projectId: 'ssh-only', backend: { kind: 'ssh', hostId: 'h' } },
    ];
    mocks.backgroundMark.mockImplementation((repoPath: string) => (repoPath === '/p/own' ? 2 : 1));
    mocks.hasRemote.mockReset().mockResolvedValue(true);
    mocks.mainBranch.mockReset().mockResolvedValue('trunk');
    mocks.fetch.mockReset().mockResolvedValue(undefined);
    mocks.fastForwardTargets.mockReset().mockResolvedValue([]);
    mocks.hostStates = new Map();
    mocks.sshFetch.mockReset().mockResolvedValue(false);
    mocks.statusChange.mockReset().mockResolvedValue(undefined);
    mocks.companionHostIds = new Set();
    mocks.deletingIds = new Set();
    mocks.basePaths = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches origin for git projects with local workspaces', async () => {
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();

    // The first fetch after Komla starts brings every branch.
    expect(mocks.fetch.mock.calls).toEqual([
      ['/p/m.git', true, 20_000, 1, undefined],
      ['/p/own', false, 20_000, 2, undefined],
    ]);
  });

  it('fetches just the branches in use between hourly fetches of every branch', async () => {
    mocks.projects = mocks.projects.filter((project) => project.id === 'own');
    mocks.projects[0].baseBranch = 'develop';
    mocks.workspaces = [
      { id: 'w2', projectId: 'own', branchName: 'agent/fox', baseBranch: 'release/1.0' },
      { id: 'w6', projectId: 'own', branchName: 'origin/agent/owl' },
      { id: 'w7', projectId: 'unused', branchName: 'agent/elsewhere' },
      { id: 'w8', projectId: 'own', branchName: 'agent/remote', backend: { kind: 'ssh' } },
    ];
    const {
      gitBackgroundFetchService,
      BACKGROUND_FETCH_INTERVAL_MS,
      EVERY_BRANCH_FETCH_INTERVAL_MS,
    } = await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();
    vi.advanceTimersByTime(BACKGROUND_FETCH_INTERVAL_MS);
    await gitBackgroundFetchService.fetchStale();
    vi.advanceTimersByTime(EVERY_BRANCH_FETCH_INTERVAL_MS - BACKGROUND_FETCH_INTERVAL_MS);
    await gitBackgroundFetchService.fetchStale();

    expect(mocks.fetch.mock.calls.map((call) => call[4])).toEqual([
      undefined,
      ['agent/fox', 'agent/owl', 'develop', 'main', 'master', 'release/1.0'],
      undefined,
    ]);
  });

  it("asks for the project's detected target when it has none set", async () => {
    mocks.projects = mocks.projects.filter((project) => project.id === 'own');
    mocks.workspaces = [];
    const { gitBackgroundFetchService, BACKGROUND_FETCH_INTERVAL_MS } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchProject('own');
    vi.advanceTimersByTime(BACKGROUND_FETCH_INTERVAL_MS);
    await gitBackgroundFetchService.fetchProject('own');

    expect(mocks.fetch.mock.calls[1][4]).toEqual(['main', 'master', 'trunk']);
  });

  it('waits for a fetch already running in the repository, then fetches what it did not', async () => {
    mocks.projects = mocks.projects.filter((project) => project.id === 'own');
    const { gitBackgroundFetchService, BACKGROUND_FETCH_INTERVAL_MS } =
      await import('../../../src/main/services/git-background-fetch.service');
    await gitBackgroundFetchService.fetchProject('own');
    vi.advanceTimersByTime(BACKGROUND_FETCH_INTERVAL_MS);
    let finishFirst!: () => void;
    mocks.fetch.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirst = resolve))
    );

    // The dialog's fetch of the branches in use, then its branch picker's of every branch.
    const dialog = gitBackgroundFetchService.fetchProject('own');
    const picker = gitBackgroundFetchService.fetchProject('own', null, true);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    finishFirst();

    await expect(Promise.all([dialog, picker])).resolves.toEqual([true, true]);
    expect(mocks.fetch.mock.calls.map((call) => call[4] === undefined)).toEqual([
      true,
      false,
      true,
    ]);
    // Nothing left to fetch, so nothing to list again.
    await expect(gitBackgroundFetchService.fetchProject('own', null, true)).resolves.toBe(false);
  });

  it('fetches the branches of every project sharing the repository, leaving out bad names', async () => {
    mocks.projects = [
      { ...base, id: 'a', managed: false, repositoryPath: '/p/shared', baseBranch: 'develop' },
      { ...base, id: 'b', managed: false, repositoryPath: '/p/shared', baseBranch: 'release candidate' },
      // Follows the repository's main branch, and spells the path another way.
      { ...base, id: 'c', managed: false, repositoryPath: '/p/shared/' },
    ];
    mocks.workspaces = [
      { id: 'wa', projectId: 'a', branchName: 'agent/a' },
      { id: 'wb', projectId: 'b', branchName: 'agent/b', baseBranch: 'HEAD~1' },
    ];
    const { gitBackgroundFetchService, BACKGROUND_FETCH_INTERVAL_MS } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchProject('a');
    vi.advanceTimersByTime(BACKGROUND_FETCH_INTERVAL_MS);
    await gitBackgroundFetchService.fetchProject('a');

    expect(mocks.fetch.mock.calls[1][4]).toEqual([
      'agent/a',
      'agent/b',
      'develop',
      'main',
      'master',
      'trunk',
    ]);
    // The same repository however its path is spelled, so it was just fetched.
    await gitBackgroundFetchService.fetchProject('c');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('counts a fetch of every branch it waited for as its own', async () => {
    mocks.projects = mocks.projects.filter((project) => project.id === 'own');
    let finishFirst!: () => void;
    mocks.fetch.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirst = resolve))
    );
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    // The first fetch after Komla starts brings every branch.
    const dialog = gitBackgroundFetchService.fetchProject('own');
    const picker = gitBackgroundFetchService.fetchProject('own', null, true);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    finishFirst();

    await expect(Promise.all([dialog, picker])).resolves.toEqual([true, true]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('drops a fetch waiting its turn once a workspace creation stops background work', async () => {
    mocks.projects = mocks.projects.filter((project) => project.id === 'own');
    let mark = 2;
    mocks.backgroundMark.mockImplementation(() => mark);
    let stop!: () => void;
    mocks.fetch.mockImplementationOnce(
      () => new Promise<void>((_, reject) => (stop = () => reject(new Error('stopped'))))
    );
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    const dialog = gitBackgroundFetchService.fetchProject('own');
    const picker = gitBackgroundFetchService.fetchProject('own', null, true);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    mark += 1;
    stop();

    await expect(Promise.all([dialog, picker])).resolves.toEqual([false, false]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    // The stopped fetch didn't count, so the next request fetches.
    await expect(gitBackgroundFetchService.fetchProject('own')).resolves.toBe(true);
  });

  it('reports a fetch that brought refs even when what follows it fails', async () => {
    mocks.fastForwardTargets.mockRejectedValueOnce(new Error('target moved'));
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await expect(gitBackgroundFetchService.fetchProject('managed', null, true)).resolves.toBe(true);
  });

  it('fetches every branch when asked, at most once in five minutes', async () => {
    const { gitBackgroundFetchService, BACKGROUND_FETCH_INTERVAL_MS } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchProject('own');
    // A branch list asking for every branch isn't held back by a fetch of just some.
    vi.advanceTimersByTime(BACKGROUND_FETCH_INTERVAL_MS);
    await gitBackgroundFetchService.fetchProject('own');
    await gitBackgroundFetchService.fetchProject('own', null, true);
    await gitBackgroundFetchService.fetchProject('own', null, true);

    expect(mocks.fetch.mock.calls.map((call) => call[4] === undefined)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('fetches one project when asked, sharing the five-minute window', async () => {
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchProject('unused');
    await gitBackgroundFetchService.fetchProject('own');
    expect(mocks.fetch.mock.calls).toEqual([
      ['/p/unused', false, 20_000, 1, undefined],
      ['/p/own', false, 20_000, 2, undefined],
    ]);

    await gitBackgroundFetchService.fetchProject('own');
    await gitBackgroundFetchService.fetchProject('folder');
    await gitBackgroundFetchService.fetchProject('missing');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    await gitBackgroundFetchService.fetchStale();
    expect(mocks.fetch.mock.calls.slice(2).map(([repoPath]) => repoPath)).not.toContain('/p/own');
  });

  it("fast-forwards Komla's own clone's targets after fetching just that project", async () => {
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchProject('managed');

    expect(mocks.fastForwardTargets.mock.calls.map(([projectId]) => projectId)).toEqual([
      'managed',
    ]);
  });

  it('does not fetch a project when asked while background fetch is off', async () => {
    mocks.config = { gitBackgroundFetch: false };
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchProject('own');

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fetches again soon after a workspace creation stopped the fetch', async () => {
    mocks.projects = mocks.projects.filter((project) => project.id === 'own');
    let mark = 2;
    mocks.backgroundMark.mockImplementation(() => mark);
    mocks.fetch.mockImplementationOnce(async () => {
      mark += 1;
      throw new Error('Git was stopped for other work in this repository');
    });
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchProject('own');
    await gitBackgroundFetchService.fetchStale();

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
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

  it("fast-forwards target branches after fetching Komla's own clone, not a user's", async () => {
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();

    expect(mocks.fastForwardTargets.mock.calls.map(([projectId]) => projectId)).toEqual([
      'managed',
    ]);
    // It gives way once a workspace creation stops background work.
    const proceed = mocks.fastForwardTargets.mock.calls[0][1] as () => boolean;
    expect(proceed()).toBe(true);
    mocks.backgroundMark.mockReturnValueOnce(3);
    expect(proceed()).toBe(false);
  });

  it('leaves target branches alone when the fetch fails', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('Permission denied (publickey)'));
    const { gitBackgroundFetchService } =
      await import('../../../src/main/services/git-background-fetch.service');

    await gitBackgroundFetchService.fetchStale();

    expect(mocks.fastForwardTargets).not.toHaveBeenCalled();
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
        ['h1', '/r/app', 20_000, undefined],
        ['h1', '/r/other', 20_000, undefined],
      ]);
      expect(mocks.statusChange).not.toHaveBeenCalled();
    });

    it('fetches nothing on a host the user disconnected from', async () => {
      mocks.hostStates.set('h1', 'connected').set('h2', 'connected');
      const { markSshHostDisconnected } =
        await import('../../../src/main/services/ssh-host-disconnection');
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');
      markSshHostDisconnected('h1', true);
      try {
        await gitBackgroundFetchService.fetchStale();
      } finally {
        markSshHostDisconnected('h1', false);
      }

      expect(mocks.sshFetch.mock.calls).toEqual([['h2', '/r/app', 20_000, undefined]]);
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

      expect(mocks.sshFetch.mock.calls).toEqual([['h2', '/r/app', 20_000, undefined]]);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it("fetches the clone a new workspace on the host would clone into", async () => {
      mocks.hostStates.set('h1', 'connected');
      mocks.basePaths.set('h1', '/home/h1/.komla');
      mocks.sshFetch.mockResolvedValue(true);
      mocks.workspaces.push(ssh('s6', 'h1', '/home/h1/.komla/repos/app/repo.git'));
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      // Not /r/app, an older clone of the project on the same host.
      await gitBackgroundFetchService.fetchProject('ssh-only', 'h1');

      expect(mocks.sshFetch.mock.calls).toEqual([
        ['h1', '/home/h1/.komla/repos/app/repo.git', 20_000, undefined],
      ]);
      expect(mocks.statusChange.mock.calls.map(([change]) => change.workspaceId)).toEqual(['s6']);
      // This computer's repository too, which gives a branch's commit on origin.
      expect(mocks.fetch.mock.calls).toEqual([['/p/ssh', false, 20_000, 1, undefined]]);

      // The focus fetch shares the five-minute window.
      await gitBackgroundFetchService.fetchStaleOnSshHosts();
      expect(mocks.sshFetch.mock.calls.map(([, repoPath]) => repoPath)).toEqual([
        '/home/h1/.komla/repos/app/repo.git',
        '/r/app',
        '/r/other',
      ]);
    });

    it("fetches just the branches a clone's workspaces use between hourly fetches", async () => {
      mocks.hostStates.set('h2', 'connected');
      mocks.projects.find((project) => project.id === 'ssh-only')!.baseBranch = 'develop';
      mocks.workspaces = [
        {
          ...ssh('s4', 'h2', '/r/app'),
          branchName: 'agent/fox',
          backend: {
            kind: 'ssh',
            hostId: 'h2',
            remoteRepoPath: '/r/app',
            baseBranch: 'trunk',
            // Origin's default branch, as the host found it.
            defaultBranch: 'stable',
          },
        },
      ];
      const { gitBackgroundFetchService, BACKGROUND_FETCH_INTERVAL_MS } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchStaleOnSshHosts();
      vi.advanceTimersByTime(BACKGROUND_FETCH_INTERVAL_MS);
      await gitBackgroundFetchService.fetchStaleOnSshHosts();

      expect(mocks.sshFetch.mock.calls.map((call) => call[3])).toEqual([
        undefined,
        ['agent/fox', 'develop', 'main', 'master', 'stable', 'trunk'],
      ]);
    });

    it("leaves the host alone until Komla has reached it and knows where workspaces go", async () => {
      mocks.hostStates.set('h2', 'unreachable').set('h3', 'connected');
      mocks.basePaths.set('h2', '/home/h2/.komla');
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchProject('ssh-only', 'h2');
      // Finding the base path could prompt.
      await gitBackgroundFetchService.fetchProject('ssh-only', 'h3');
      await gitBackgroundFetchService.fetchProject('ssh-only', 'unknown');

      expect(mocks.sshFetch).not.toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('leaves local repositories alone when a host answers', async () => {
      mocks.hostStates.set('h2', 'connected');
      mocks.workspaces.push({ id: 'w1', projectId: 'managed' });
      const { gitBackgroundFetchService } =
        await import('../../../src/main/services/git-background-fetch.service');

      await gitBackgroundFetchService.fetchStaleOnSshHosts();

      expect(mocks.sshFetch.mock.calls).toEqual([['h2', '/r/app', 20_000, undefined]]);
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  });
});
