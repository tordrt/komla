import { join, resolve as resolvePath } from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../../mocks/electron';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockGetActivityFingerprint = vi.fn(async () => '');
const mockGetChangedFilesWithSummary = vi.fn(async () => ({
  files: [],
  summary: { additions: 0, deletions: 0, filesChanged: 0 },
}));
const mockGetBranchQuickStatus = vi.fn();
const mockInvalidateBranchCache = vi.fn();
const mockListIgnoredDirectories = vi.fn(async (): Promise<string[]> => []);
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: {
    getActivityFingerprint: mockGetActivityFingerprint,
    getChangedFilesWithSummary: mockGetChangedFilesWithSummary,
    getBranchQuickStatus: mockGetBranchQuickStatus,
    invalidateBranchCache: mockInvalidateBranchCache,
    listIgnoredDirectories: mockListIgnoredDirectories,
  },
}));

interface MockSubscription {
  dir: string;
  callback: (err: Error | null, events: Array<{ path: string; type: string }>) => void;
  options?: { ignore?: string[] };
  unsubscribe: ReturnType<typeof vi.fn>;
}

const subscriptions: MockSubscription[] = [];
const mockSubscribe = vi.fn(
  async (
    dir: string,
    callback: (err: Error | null, events: Array<{ path: string; type: string }>) => void,
    options?: { ignore?: string[] }
  ) => {
    const sub: MockSubscription = {
      dir,
      callback,
      options,
      unsubscribe: vi.fn(async () => {}),
    };
    subscriptions.push(sub);
    return { unsubscribe: sub.unsubscribe };
  }
);
vi.mock('@parcel/watcher', () => ({
  subscribe: mockSubscribe,
}));

const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
  statSync: vi.fn(),
};
vi.mock('fs', () => mockFs);

/**
 * A POSIX fixture path as this platform spells it, as path.join and the watcher's events do:
 * unchanged on macOS and Linux, a path on the current drive on Windows.
 */
function nativePath(posixPath: string): string {
  return resolvePath(posixPath);
}

const REPO = nativePath('/repo');

function setupRegularRepo(dirPath: string) {
  const gitPath = join(dirPath, '.git');
  mockFs.existsSync.mockImplementation((path: string) => {
    if (path === dirPath) return true;
    if (path === gitPath) return true;
    if (path === join(dirPath, '.gitignore')) return false;
    if (path === join(gitPath, 'commondir')) return false;
    return false;
  });
  mockFs.statSync.mockImplementation((path: string) => {
    if (path === gitPath) {
      return { isDirectory: () => true, isFile: () => false };
    }
    throw new Error('ENOENT');
  });
  mockFs.readFileSync.mockImplementation(() => '');
}

function setupWorktreeWithSharedCommonDir(dirPath: string, gitDir: string, commonDir: string) {
  const gitPath = join(dirPath, '.git');
  mockFs.existsSync.mockImplementation((path: string) => {
    if (path === dirPath) return true;
    if (path === gitPath) return true;
    if (path === join(dirPath, '.gitignore')) return false;
    if (path === join(gitDir, 'commondir')) return true;
    if (path === commonDir) return true;
    return false;
  });

  mockFs.statSync.mockImplementation((path: string) => {
    if (path === gitPath) {
      return { isDirectory: () => false, isFile: () => true };
    }
    throw new Error('ENOENT');
  });

  mockFs.readFileSync.mockImplementation((path: string) => {
    if (path === gitPath) return `gitdir: ${gitDir}`;
    if (path === join(gitDir, 'commondir')) return commonDir;
    return '';
  });
}

describe('WorktreeWatcherService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    subscriptions.length = 0;
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([]);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('');
    mockFs.statSync.mockImplementation(() => ({ isDirectory: () => true, isFile: () => false }));
    mockGetActivityFingerprint.mockResolvedValue('');
    mockGetChangedFilesWithSummary.mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    });
    mockGetBranchQuickStatus.mockRejectedValue(new Error('branch status unavailable'));
    mockListIgnoredDirectories.mockResolvedValue([]);
  });

  it('skips watcher when directory does not exist', async () => {
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    // existsSync returns false by default (from beforeEach)
    await worktreeWatcherService.startWatching('ws-1', nativePath('/deleted-worktree'));

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(worktreeWatcherService.isWatching('ws-1')).toBe(false);
  });

  it('startAllWatchers continues when one workspace fails', async () => {
    setupRegularRepo(nativePath('/good-repo'));
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await worktreeWatcherService.startAllWatchers([
      { id: 'ws-ok', workingDirectory: nativePath('/good-repo') },
      { id: 'ws-gone', workingDirectory: nativePath('/deleted-dir') },
    ]);

    // The valid workspace should have a watcher; the missing one should not
    expect(worktreeWatcherService.isWatching('ws-ok')).toBe(true);
    expect(worktreeWatcherService.isWatching('ws-gone')).toBe(false);
  });

  it('starts only file watcher for non-git directories', async () => {
    mockFs.existsSync.mockImplementation((path: string) => path === nativePath('/not-git'));
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await worktreeWatcherService.startWatching('ws-1', nativePath('/not-git'));

    // Should have 1 subscription (file watcher), but no git watchers
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptions[0].dir).toBe(nativePath('/not-git'));
    expect(worktreeWatcherService.isWatching('ws-1')).toBe(true);
  });

  it('publishes an authoritative repository observation when a watcher starts', async () => {
    setupRegularRepo(REPO);
    const initialTree = {
      files: [
        { path: 'changed.txt', status: 'modified', staged: false, additions: 2, deletions: 1 },
      ],
      summary: { additions: 2, deletions: 1, filesChanged: 1 },
    };
    mockGetChangedFilesWithSummary.mockResolvedValue(initialTree);
    mockGetBranchQuickStatus.mockResolvedValue({
      behindTargetBranch: 0,
      aheadTargetBranch: 1,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 1,
      behindRemote: 0,
      currentBranch: 'feature/startup',
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    });
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onObservation = vi.fn(async () => undefined);
    worktreeWatcherService.onObservation = onObservation;

    await worktreeWatcherService.startWatching('ws-1', REPO);

    expect(onObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        source: expect.objectContaining({ kind: 'local-watcher', sequence: 1 }),
        workingTree: initialTree,
        branch: expect.objectContaining({ currentBranch: 'feature/startup' }),
      })
    );
  });

  it('reuses the last branch projection for file-only observations', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);
    setupRegularRepo(REPO);
    const branch = {
      behindTargetBranch: 0,
      aheadTargetBranch: 1,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: true,
      hasOriginRemote: true,
      unpushedCommits: 1,
      behindRemote: 0,
      currentBranch: 'feature/cache',
      targetBranchHasRemote: true,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    };
    mockGetBranchQuickStatus.mockResolvedValue(branch);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    worktreeWatcherService.onObservation = vi.fn(async () => undefined);

    await worktreeWatcherService.startWatching('ws-1', REPO);
    const fileSub = subscriptions.find((subscription) => subscription.dir === REPO);
    fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/file.ts') }]);
    await vi.advanceTimersByTimeAsync(500);

    expect(mockGetBranchQuickStatus).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      undefined,
      expect.anything(),
      branch
    );
  });

  it('orders overlapping observations by scan start instead of scan completion', async () => {
    setupRegularRepo(REPO);
    const initialTree = {
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    };
    const olderTree = {
      files: [{ path: 'older.txt', status: 'modified', staged: false, additions: 1, deletions: 0 }],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    };
    const newerTree = {
      files: [{ path: 'newer.txt', status: 'modified', staged: false, additions: 2, deletions: 0 }],
      summary: { additions: 2, deletions: 0, filesChanged: 1 },
    };
    let resolveOlder!: (value: typeof olderTree) => void;
    const olderScan = new Promise<typeof olderTree>((resolve) => {
      resolveOlder = resolve;
    });
    mockGetChangedFilesWithSummary
      .mockResolvedValueOnce(initialTree)
      .mockImplementationOnce(() => olderScan)
      .mockResolvedValueOnce(newerTree);
    mockGetBranchQuickStatus.mockResolvedValue({
      behindTargetBranch: 0,
      aheadTargetBranch: 0,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      currentBranch: 'main',
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    });
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const observations: Array<{ source: { sequence: number }; workingTree: unknown }> = [];
    worktreeWatcherService.onObservation = vi.fn(async (observation) => {
      observations.push(observation);
    });
    await worktreeWatcherService.startWatching('ws-1', REPO);
    const internal = worktreeWatcherService as unknown as {
      watchers: Map<string, { pendingChangeTypes: Set<string>; pendingActivity: boolean }>;
      notifyRenderer: (sessionId: string) => Promise<void>;
    };
    const entry = internal.watchers.get('ws-1')!;

    entry.pendingChangeTypes.add('file');
    const olderPublish = internal.notifyRenderer('ws-1');
    await Promise.resolve();
    entry.pendingChangeTypes.add('file');
    await internal.notifyRenderer('ws-1');
    resolveOlder(olderTree);
    await olderPublish;

    expect(observations.map((value) => value.source.sequence)).toEqual([1, 3]);
    expect(observations.map((value) => value.workingTree)).toEqual([initialTree, newerTree]);
  });

  it('debounces file change notifications and triggers activity callback', async () => {
    const liveWindow = createMockBrowserWindow();
    const destroyedWindow = createMockBrowserWindow({ isDestroyed: vi.fn(() => true) });
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([liveWindow, destroyedWindow]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onActivity = vi.fn();
    worktreeWatcherService.onActivity = onActivity;
    // Initial fingerprint (for startWatching) returns empty, subsequent returns changed files
    const changedResult = {
      files: [
        { path: 'src/index.ts', status: 'modified', staged: false, additions: 1, deletions: 0 },
      ],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    };
    mockGetChangedFilesWithSummary
      .mockResolvedValueOnce({
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      })
      .mockResolvedValueOnce(changedResult);

    await worktreeWatcherService.startWatching('ws-1', REPO);

    // Advance past the initial activity suppression window (5000ms)
    await vi.advanceTimersByTimeAsync(5000);

    const fileSub = subscriptions.find((s) => s.dir === REPO);
    fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/index.ts') }]);

    await vi.advanceTimersByTimeAsync(500);

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      expect.any(Number),
      changedResult
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledWith('ws-1', expect.any(Number));
  });

  it('keeps directories git ignores by any rule out of the file watcher', async () => {
    setupRegularRepo(REPO);
    const existsSync = mockFs.existsSync.getMockImplementation() as (path: string) => boolean;
    mockFs.existsSync.mockImplementation(
      (path: string) => path === nativePath('/repo/.gitignore') || existsSync(path)
    );
    mockFs.readFileSync.mockImplementation((path: string) =>
      path === nativePath('/repo/.gitignore') ? 'dist/\n' : ''
    );
    mockListIgnoredDirectories.mockResolvedValue(['dist', 'packages/app/node_modules', '.venv']);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await worktreeWatcherService.startWatching('ws-1', REPO);

    expect(mockListIgnoredDirectories).toHaveBeenCalledWith(REPO);
    // The root .gitignore's glob already covers dist.
    expect(subscriptions.find((s) => s.dir === REPO)?.options?.ignore).toEqual([
      '**/.git/**',
      '**/dist/**',
      'packages/app/node_modules',
      '.venv',
    ]);
  });

  it('keeps out an ignored directory whose rule a negation keeps out of the globs', async () => {
    setupRegularRepo(REPO);
    const existsSync = mockFs.existsSync.getMockImplementation() as (path: string) => boolean;
    mockFs.existsSync.mockImplementation(
      (path: string) => path === nativePath('/repo/.gitignore') || existsSync(path)
    );
    // Git can't re-include a path under an ignored directory, so it still ignores all of it.
    mockFs.readFileSync.mockImplementation((path: string) =>
      path === nativePath('/repo/.gitignore') ? 'node_modules/\n!node_modules/patched/\n' : ''
    );
    mockListIgnoredDirectories.mockResolvedValue(['node_modules']);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await worktreeWatcherService.startWatching('ws-1', REPO);

    expect(subscriptions.find((s) => s.dir === REPO)?.options?.ignore).toEqual([
      '**/.git/**',
      'node_modules',
    ]);
  });

  it('keeps dependency folders out of the file watcher of a directory without git', async () => {
    mockFs.existsSync.mockImplementation((path: string) => path === nativePath('/not-git'));
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await worktreeWatcherService.startWatching('ws-1', nativePath('/not-git'));

    expect(mockListIgnoredDirectories).not.toHaveBeenCalled();
    expect(subscriptions[0].options?.ignore).toEqual([
      '**/.git/**',
      '**/node_modules/**',
      '**/.venv/**',
    ]);
  });

  it('releases what a start subscribed after the watcher was stopped', async () => {
    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    let finishSubscribe!: () => void;
    const subscribed = new Promise<void>((resolve) => (finishSubscribe = resolve));
    const defaultSubscribe = mockSubscribe.getMockImplementation()!;
    mockSubscribe.mockImplementationOnce(async (...args) => {
      await subscribed;
      return defaultSubscribe(...args);
    });

    const starting = worktreeWatcherService.startWatching('ws-1', REPO);
    await vi.waitFor(() => expect(mockSubscribe).toHaveBeenCalledOnce());
    await worktreeWatcherService.stopWatching('ws-1');
    finishSubscribe();
    await starting;

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].unsubscribe).toHaveBeenCalledOnce();
    expect(worktreeWatcherService.isWatching('ws-1')).toBe(false);
  });

  it('shares one commondir git watcher between worktrees that start at once', async () => {
    const worktrees = new Map([
      [nativePath('/wt/one'), nativePath('/shared/worktrees/one')],
      [nativePath('/wt/two'), nativePath('/shared/worktrees/two')],
    ]);
    const gitFiles = new Map([...worktrees].map(([dir, gitDir]) => [join(dir, '.git'), gitDir]));
    const commondirFiles = new Set([...worktrees.values()].map((dir) => join(dir, 'commondir')));
    mockFs.existsSync.mockImplementation(
      (path: string) =>
        worktrees.has(path) ||
        gitFiles.has(path) ||
        commondirFiles.has(path) ||
        path === nativePath('/shared/main.git')
    );
    mockFs.statSync.mockImplementation(() => ({ isDirectory: () => false, isFile: () => true }));
    mockFs.readFileSync.mockImplementation((path: string) => {
      const worktreeGitDir = gitFiles.get(path);
      if (worktreeGitDir) return `gitdir: ${worktreeGitDir}`;
      return commondirFiles.has(path) ? nativePath('/shared/main.git') : '';
    });
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await Promise.all([
      worktreeWatcherService.startWatching('ws-1', nativePath('/wt/one')),
      worktreeWatcherService.startWatching('ws-2', nativePath('/wt/two')),
    ]);

    const shared = subscriptions.filter((s) => s.dir === nativePath('/shared/main.git'));
    expect(shared).toHaveLength(1);
    await worktreeWatcherService.stopWatching('ws-1');
    expect(shared[0].unsubscribe).not.toHaveBeenCalled();
    await worktreeWatcherService.stopWatching('ws-2');
    expect(shared[0].unsubscribe).toHaveBeenCalledOnce();
  });

  it('resubscribes file watcher when .gitignore changes', async () => {
    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await worktreeWatcherService.startWatching('ws-1', REPO);

    const firstFileSub = subscriptions.find((s) => s.dir === REPO);
    firstFileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.gitignore') }]);

    await vi.waitFor(() => expect(subscriptions.filter((s) => s.dir === REPO).length).toBe(2));
    expect(firstFileSub?.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest file subscription when .gitignore changes overlap', async () => {
    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    await worktreeWatcherService.startWatching('ws-1', REPO);
    const listings: Array<(directories: string[]) => void> = [];
    mockListIgnoredDirectories.mockImplementation(
      () => new Promise((resolve) => listings.push(resolve))
    );

    const firstFileSub = subscriptions.find((s) => s.dir === REPO);
    firstFileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.gitignore') }]);
    firstFileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.gitignore') }]);
    await vi.waitFor(() => expect(listings).toHaveLength(2));
    listings[1]([]);
    await vi.waitFor(() => expect(subscriptions.filter((s) => s.dir === REPO)).toHaveLength(2));
    listings[0]([]);
    await vi.waitFor(() => expect(subscriptions.filter((s) => s.dir === REPO)).toHaveLength(3));

    const resubscribed = subscriptions.filter((s) => s.dir === REPO).slice(1);
    await vi.waitFor(() =>
      expect(resubscribed.filter((s) => s.unsubscribe.mock.calls.length === 0)).toHaveLength(1)
    );
    await worktreeWatcherService.stopWatching('ws-1');
    for (const subscription of resubscribed)
      expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it('resubscribes after a .gitignore change when the old subscription fails to unsubscribe', async () => {
    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    await worktreeWatcherService.startWatching('ws-1', REPO);

    const firstFileSub = subscriptions.find((s) => s.dir === REPO);
    firstFileSub?.unsubscribe.mockRejectedValueOnce(new Error('watcher gone'));
    firstFileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.gitignore') }]);

    await vi.waitFor(() => expect(subscriptions.filter((s) => s.dir === REPO)).toHaveLength(2));
  });

  it('shares commondir git watcher across sessions and unsubscribes it when last session stops', async () => {
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    setupWorktreeWithSharedCommonDir(
      nativePath('/wt/one'),
      nativePath('/shared/worktrees/one'),
      nativePath('/shared/main.git')
    );
    await worktreeWatcherService.startWatching('ws-1', nativePath('/wt/one'));

    setupWorktreeWithSharedCommonDir(
      nativePath('/wt/two'),
      nativePath('/shared/worktrees/two'),
      nativePath('/shared/main.git')
    );
    await worktreeWatcherService.startWatching('ws-2', nativePath('/wt/two'));

    expect(subscriptions.length).toBe(5);
    const sharedSub = subscriptions[2];

    await worktreeWatcherService.stopWatching('ws-1');
    expect(sharedSub.unsubscribe).not.toHaveBeenCalled();

    await worktreeWatcherService.stopWatching('ws-2');
    expect(sharedSub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('notifies renderer on git watcher error without resubscribing', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onActivity = vi.fn();
    worktreeWatcherService.onActivity = onActivity;

    await worktreeWatcherService.startWatching('ws-1', REPO);
    const initialSubscribeCount = mockSubscribe.mock.calls.length;

    const gitSub = subscriptions.find((s) => s.dir === nativePath('/repo/.git'));

    gitSub?.callback(new Error('fsevents dropped'), []);
    gitSub?.callback(new Error('fsevents dropped again'), []);

    await vi.advanceTimersByTimeAsync(500);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['git-head', 'git-branch'],
      undefined,
      expect.anything()
    );
    expect(onActivity).not.toHaveBeenCalled();

    // No recovery resubscription should have happened
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockSubscribe).toHaveBeenCalledTimes(initialSubscribeCount);
  });

  it('does not emit synthetic file changes when no pending change types exist', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onActivity = vi.fn();
    worktreeWatcherService.onActivity = onActivity;

    await worktreeWatcherService.startWatching('ws-1', REPO);

    await (
      worktreeWatcherService as unknown as { notifyRenderer: (sessionId: string) => Promise<void> }
    ).notifyRenderer('ws-1');

    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('emits git-branch change for packed-refs and git-head for various git heads', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    await worktreeWatcherService.startWatching('ws-1', REPO);

    // Advance past activity suppression window
    await vi.advanceTimersByTimeAsync(5000);

    const gitSub = subscriptions.find((s) => s.dir === nativePath('/repo/.git'));

    // Test packed-refs (git-branch: file status pushed because branch ref changes affect diff)
    gitSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.git/packed-refs') }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['git-branch'],
      undefined,
      expect.objectContaining({ files: [], summary: expect.any(Object) })
    );
    vi.clearAllMocks();

    // Test FETCH_HEAD (git-head: file status pushed, no activity because fingerprint unchanged)
    gitSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.git/FETCH_HEAD') }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['git-head'],
      undefined,
      expect.objectContaining({ files: [], summary: expect.any(Object) })
    );
    vi.clearAllMocks();

    // Test MERGE_HEAD (git-head: file status pushed)
    gitSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.git/MERGE_HEAD') }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['git-head'],
      undefined,
      expect.objectContaining({ files: [], summary: expect.any(Object) })
    );
    vi.clearAllMocks();

    // Test robust branch matching (no trailing slash)
    gitSub?.callback(null, [{ type: 'update', path: nativePath('/repo/.git/refs/heads/feature') }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['git-branch'],
      undefined,
      expect.objectContaining({ files: [], summary: expect.any(Object) })
    );
  });

  it("ignores sibling worktree state, reflogs and objects in a repo's git dir", async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    setupWorktreeWithSharedCommonDir(
      nativePath('/wt/one'),
      nativePath('/shared/worktrees/one'),
      nativePath('/shared/main.git')
    );
    await worktreeWatcherService.startWatching('ws-1', nativePath('/wt/one'));
    setupWorktreeWithSharedCommonDir(
      nativePath('/wt/two'),
      nativePath('/shared/worktrees/two'),
      nativePath('/shared/main.git')
    );
    await worktreeWatcherService.startWatching('ws-2', nativePath('/wt/two'));
    await vi.advanceTimersByTimeAsync(5000);
    vi.mocked(window.webContents.send).mockClear();

    const sharedSub = subscriptions.find((s) => s.dir === nativePath('/shared/main.git'));
    expect(sharedSub?.options?.ignore).toEqual(['objects', 'logs', 'worktrees', 'lfs']);

    sharedSub?.callback(null, [
      { type: 'update', path: nativePath('/shared/main.git/worktrees/two/HEAD') },
      { type: 'update', path: nativePath('/shared/main.git/worktrees/two/COMMIT_EDITMSG') },
      { type: 'update', path: nativePath('/shared/main.git/logs/HEAD') },
      { type: 'update', path: nativePath('/shared/main.git/logs/refs/heads/two') },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(window.webContents.send).not.toHaveBeenCalled();

    sharedSub?.callback(null, [
      { type: 'update', path: nativePath('/shared/main.git/refs/heads/two') },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['git-branch'],
      undefined,
      expect.anything()
    );
  });

  it("ignores the main checkout's HEAD files in the shared git dir", async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    setupWorktreeWithSharedCommonDir(
      nativePath('/wt/one'),
      nativePath('/shared/worktrees/one'),
      nativePath('/shared/main.git')
    );
    await worktreeWatcherService.startWatching('ws-1', nativePath('/wt/one'));
    setupWorktreeWithSharedCommonDir(
      nativePath('/wt/two'),
      nativePath('/shared/worktrees/two'),
      nativePath('/shared/main.git')
    );
    await worktreeWatcherService.startWatching('ws-2', nativePath('/wt/two'));
    await vi.advanceTimersByTimeAsync(5000);
    vi.mocked(window.webContents.send).mockClear();
    const sharedSub = subscriptions.find((s) => s.dir === nativePath('/shared/main.git'));

    // A fetch or commit in the main checkout; each worktree keeps these files in its own git dir.
    sharedSub?.callback(null, [
      { type: 'update', path: nativePath('/shared/main.git/FETCH_HEAD') },
      { type: 'update', path: nativePath('/shared/main.git/COMMIT_EDITMSG') },
      { type: 'update', path: nativePath('/shared/main.git/ORIG_HEAD') },
      { type: 'update', path: nativePath('/shared/main.git/HEAD') },
    ]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('slows refreshes while nobody can see them and flushes once someone can', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    let backgroundOnly = true;
    worktreeWatcherService.isBackgroundOnly = () => backgroundOnly;
    await worktreeWatcherService.startWatching('ws-1', REPO);
    await vi.advanceTimersByTimeAsync(5000);
    const fileSub = subscriptions.find((s) => s.dir === REPO);

    // Sustained activity: the normal 3s cap no longer forces a refresh.
    for (let i = 0; i < 10; i++) {
      fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/app.ts') }]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(window.webContents.send).not.toHaveBeenCalled();

    // ...but the background cap still bounds staleness.
    for (let i = 0; i < 25; i++) {
      fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/app.ts') }]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    vi.mocked(window.webContents.send).mockClear();

    fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/app.ts') }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(window.webContents.send).not.toHaveBeenCalled();

    // Still nobody watching (e.g. a remote device disconnected): keep waiting.
    worktreeWatcherService.flushPendingNotifications();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.webContents.send).not.toHaveBeenCalled();

    backgroundOnly = false;
    worktreeWatcherService.flushPendingNotifications();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      undefined,
      expect.anything()
    );
  });

  it('slows refreshes of a workspace no window shows and refreshes it once one does', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    let offScreen = true;
    worktreeWatcherService.isOffScreen = (sessionId) => sessionId === 'ws-1' && offScreen;
    await worktreeWatcherService.startWatching('ws-1', REPO);
    await vi.advanceTimersByTimeAsync(5000);
    const fileSub = subscriptions.find((s) => s.dir === REPO);

    // An agent writing every second; on screen, each write would refresh.
    for (let i = 0; i < 10; i++) {
      fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/app.ts') }]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(window.webContents.send).not.toHaveBeenCalled();

    // Focusing the window refreshes what it shows, not this workspace.
    worktreeWatcherService.flushPendingNotifications();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.webContents.send).not.toHaveBeenCalled();

    offScreen = false;
    worktreeWatcherService.flushPendingNotification('ws-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      undefined,
      expect.anything()
    );
  });

  it('does not mark activity when fingerprint is unchanged', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onActivity = vi.fn();
    worktreeWatcherService.onActivity = onActivity;
    // Same file status for both init and notification → fingerprint unchanged
    const unchangedResult = {
      files: [
        { path: 'notes.txt', status: 'untracked', staged: false, additions: 0, deletions: 0 },
      ],
      summary: { additions: 0, deletions: 0, filesChanged: 1 },
    };
    mockGetChangedFilesWithSummary.mockResolvedValue(unchangedResult);

    await worktreeWatcherService.startWatching('ws-1', REPO);
    await vi.advanceTimersByTimeAsync(5000);

    const fileSub = subscriptions.find((s) => s.dir === REPO);
    fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/notes.txt') }]);
    await vi.advanceTimersByTimeAsync(500);

    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      undefined,
      unchangedResult
    );
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('marks activity when diff stats change for an already-modified file', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onActivity = vi.fn();
    worktreeWatcherService.onActivity = onActivity;

    mockGetChangedFilesWithSummary
      .mockResolvedValueOnce({
        files: [
          { path: 'src/index.ts', status: 'modified', staged: false, additions: 1, deletions: 0 },
        ],
        summary: { additions: 1, deletions: 0, filesChanged: 1 },
      })
      .mockResolvedValueOnce({
        files: [
          { path: 'src/index.ts', status: 'modified', staged: false, additions: 4, deletions: 2 },
        ],
        summary: { additions: 4, deletions: 2, filesChanged: 1 },
      });

    await worktreeWatcherService.startWatching('ws-1', REPO);
    await vi.advanceTimersByTimeAsync(5000);

    const fileSub = subscriptions.find((s) => s.dir === REPO);
    fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/index.ts') }]);
    await vi.advanceTimersByTimeAsync(500);

    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      expect.any(Number),
      {
        files: [
          { path: 'src/index.ts', status: 'modified', staged: false, additions: 4, deletions: 2 },
        ],
        summary: { additions: 4, deletions: 2, filesChanged: 1 },
      }
    );
    expect(onActivity).toHaveBeenCalledWith('ws-1', expect.any(Number));
  });

  it('restartWatching re-creates watcher and sends immediate notification with all change types', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');

    await worktreeWatcherService.startWatching('ws-1', REPO);
    const initialSubscribeCount = mockSubscribe.mock.calls.length;

    await worktreeWatcherService.restartWatching('ws-1', REPO);

    // startWatching was called again (stops old watcher, creates new one)
    expect(mockSubscribe.mock.calls.length).toBeGreaterThan(initialSubscribeCount);
    expect(worktreeWatcherService.isWatching('ws-1')).toBe(true);

    // Should have sent an immediate notification with all four change types
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      expect.arrayContaining(['file', 'git-head', 'git-branch']),
      undefined,
      expect.anything()
    );
  });

  it('uses a fresh observation epoch whenever a watcher is restarted', async () => {
    setupRegularRepo(REPO);
    mockGetBranchQuickStatus.mockResolvedValue({
      behindTargetBranch: 0,
      aheadTargetBranch: 0,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      currentBranch: 'main',
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    });
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onObservation = vi.fn(async () => undefined);
    worktreeWatcherService.onObservation = onObservation;

    await worktreeWatcherService.startWatching('ws-1', REPO);
    await worktreeWatcherService.restartWatching('ws-1', REPO);
    await worktreeWatcherService.restartWatching('ws-1', REPO);

    expect(onObservation).toHaveBeenCalledTimes(3);
    const observations = onObservation.mock.calls.map(([value]) => value);
    expect(observations.map((value) => value.source.sequence)).toEqual([1, 1, 1]);
    expect(new Set(observations.map((value) => value.source.epoch)).size).toBe(3);
  });

  it('discards an initial scan after its watcher has been replaced', async () => {
    setupRegularRepo(REPO);
    const oldTree = {
      files: [{ path: 'old.ts', status: 'modified', staged: false, additions: 1, deletions: 0 }],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    };
    const newTree = {
      files: [{ path: 'new.ts', status: 'modified', staged: false, additions: 2, deletions: 0 }],
      summary: { additions: 2, deletions: 0, filesChanged: 1 },
    };
    let resolveOldScan!: (value: typeof oldTree) => void;
    const oldScan = new Promise<typeof oldTree>((resolve) => {
      resolveOldScan = resolve;
    });
    mockGetChangedFilesWithSummary.mockImplementationOnce(() => oldScan).mockResolvedValue(newTree);
    mockGetBranchQuickStatus.mockResolvedValue({
      behindTargetBranch: 0,
      aheadTargetBranch: 0,
      mainBranch: 'main',
      defaultBranch: 'main',
      hasRemote: false,
      hasOriginRemote: false,
      unpushedCommits: 0,
      behindRemote: 0,
      currentBranch: 'main',
      targetBranchHasRemote: false,
      targetBranchAheadRemote: 0,
      targetBranchBehindRemote: 0,
    });
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onObservation = vi.fn(async () => undefined);
    worktreeWatcherService.onObservation = onObservation;

    const oldStart = worktreeWatcherService.startWatching('ws-1', REPO);
    await vi.waitFor(() => expect(mockGetChangedFilesWithSummary).toHaveBeenCalledTimes(1));
    await worktreeWatcherService.startWatching('ws-1', REPO);
    resolveOldScan(oldTree);
    await oldStart;

    expect(onObservation).toHaveBeenCalledTimes(1);
    expect(onObservation.mock.calls[0]?.[0].workingTree).toEqual(newTree);
  });

  it('emits activity when status resolves after suppression window expires', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onActivity = vi.fn();
    worktreeWatcherService.onActivity = onActivity;

    // Hold the second getChangedFilesWithSummary call so the await straddles the threshold.
    type StatusResult = {
      files: Array<{
        path: string;
        status: string;
        staged: boolean;
        additions: number;
        deletions: number;
      }>;
      summary: { additions: number; deletions: number; filesChanged: number };
    };
    let resolveStatus!: (v: StatusResult) => void;
    const heldPromise = new Promise<StatusResult>((resolve) => {
      resolveStatus = resolve;
    });
    mockGetChangedFilesWithSummary
      .mockResolvedValueOnce({
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      })
      .mockReturnValueOnce(heldPromise);

    await worktreeWatcherService.startWatching('ws-1', REPO);
    // ignoreActivityUntil is now ~5000ms from "now"

    // Fire change at t≈4400 so debounce (500ms) fires at t≈4900 — still inside
    // the suppression window. notifyRenderer then awaits the held status call.
    await vi.advanceTimersByTimeAsync(4400);
    const fileSub = subscriptions.find((s) => s.dir === REPO);
    fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/src/a.ts') }]);
    await vi.advanceTimersByTimeAsync(500);

    // Status call is still pending — activity should NOT yet be emitted.
    expect(onActivity).not.toHaveBeenCalled();

    // Cross the suppression threshold while the await is still pending.
    await vi.advanceTimersByTimeAsync(200);

    // Now resolve the held status. The post-await gate must re-read Date.now()
    // and emit activity — this is the regression test for the canEmitActivity
    // hoist bug (evaluating the gate pre-await would suppress this emission).
    resolveStatus({
      files: [{ path: 'src/a.ts', status: 'modified', staged: false, additions: 1, deletions: 0 }],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onActivity).toHaveBeenCalledWith('ws-1', expect.any(Number));
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      expect.any(Number),
      expect.objectContaining({ summary: expect.any(Object) })
    );
  });

  it('isolates onActivity exceptions and still sends the IPC notification', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    setupRegularRepo(REPO);
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const onActivity = vi.fn(() => {
      throw new Error('callback-fail');
    });
    worktreeWatcherService.onActivity = onActivity;

    mockGetChangedFilesWithSummary
      .mockResolvedValueOnce({
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      })
      .mockResolvedValueOnce({
        files: [{ path: 'a.ts', status: 'modified', staged: false, additions: 1, deletions: 0 }],
        summary: { additions: 1, deletions: 0, filesChanged: 1 },
      });

    await worktreeWatcherService.startWatching('ws-1', REPO);
    await vi.advanceTimersByTimeAsync(5000);

    const fileSub = subscriptions.find((s) => s.dir === REPO);
    fileSub?.callback(null, [{ type: 'update', path: nativePath('/repo/a.ts') }]);
    await vi.advanceTimersByTimeAsync(500);

    // Callback threw, but neither the IPC send nor the callback itself should
    // be invoked twice.
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'git-status:worktree-changed',
      'ws-1',
      ['file'],
      expect.any(Number),
      expect.anything()
    );
  });

  it('restartWatching logs warning when entry is missing after startWatching', async () => {
    const { worktreeWatcherService } =
      await import('../../../src/main/services/worktree-watcher.service');
    const { createLogger } = await import('../../../src/main/lib/logger');
    const mockLogger = (createLogger as ReturnType<typeof vi.fn>).mock.results[0]?.value;

    // Start and then manually remove the entry to simulate the edge case
    setupRegularRepo(REPO);
    await worktreeWatcherService.startWatching('ws-1', REPO);

    // Access the internal watchers map and delete the entry after startWatching completes
    // but before restartWatching checks for it
    const origStart = worktreeWatcherService.startWatching.bind(worktreeWatcherService);
    vi.spyOn(worktreeWatcherService, 'startWatching').mockImplementation(async (sid, dir) => {
      await origStart(sid, dir);
      // Simulate entry disappearing (edge case)
      (worktreeWatcherService as any).watchers.delete(sid);
    });

    await worktreeWatcherService.restartWatching('ws-1', REPO);

    expect(mockLogger.warn).toHaveBeenCalledWith('Watcher entry missing after startWatching', {
      sessionId: 'ws-1',
    });
  });
});
