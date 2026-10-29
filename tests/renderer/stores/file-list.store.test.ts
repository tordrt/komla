import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '../../setup';
import { findRenameSource, useFileListStore } from '../../../src/renderer/stores/file-list.store';

import type { RemoteWorkingTreeChange } from '../../../src/renderer/types';

interface ApiMock {
  listFiles: ReturnType<typeof vi.fn>;
  listWorkspaceFiles: ReturnType<typeof vi.fn>;
  getDiff: ReturnType<typeof vi.fn>;
  getWorkspaceDiff: ReturnType<typeof vi.fn>;
  getDiffAgainstBranch: ReturnType<typeof vi.fn>;
  getWorkspaceDiffAgainstBranch: ReturnType<typeof vi.fn>;
  getFileDiffContent: ReturnType<typeof vi.fn>;
  getFileDiffContentAgainstBranch: ReturnType<typeof vi.fn>;
  getChangedFilesWithSummary: ReturnType<typeof vi.fn>;
}

function createApiMock(overrides: Partial<ApiMock> = {}): ApiMock {
  return {
    listFiles: vi.fn().mockResolvedValue({ files: [], gitIgnoredFiles: [] }),
    listWorkspaceFiles: vi
      .fn()
      .mockResolvedValue({ files: [], gitIgnoredFiles: [], emptyDirs: [] }),
    getDiff: vi.fn().mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    }),
    getWorkspaceDiff: vi.fn().mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    }),
    getDiffAgainstBranch: vi.fn().mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    }),
    getWorkspaceDiffAgainstBranch: vi.fn().mockResolvedValue({
      files: [],
      summary: { additions: 0, deletions: 0, filesChanged: 0 },
    }),
    getFileDiffContent: vi.fn().mockResolvedValue({
      path: 'x',
      oldContent: null,
      newContent: null,
      status: 'modified',
      isBinary: false,
    }),
    getFileDiffContentAgainstBranch: vi.fn().mockResolvedValue({
      path: 'x',
      oldContent: null,
      newContent: null,
      status: 'modified',
      isBinary: false,
    }),
    getChangedFilesWithSummary: vi
      .fn()
      .mockResolvedValue({ files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } }),
    ...overrides,
  };
}

function resetStore(): void {
  useFileListStore.setState(useFileListStore.getInitialState(), true);
}

function makeDiffEntry(overrides: Record<string, unknown> = {}) {
  return {
    data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
    isLoading: false,
    hasFullDiff: false,
    ...overrides,
  };
}

describe('file-list.store', () => {
  beforeEach(() => {
    resetStore();
    (globalThis as { window: { api: ApiMock } }).window = {
      api: createApiMock(),
    };
  });

  it('tracks async fetchFileList loading transitions and keeps cache stable on failure', async () => {
    const deferred = createDeferred<{ files: string[]; gitIgnoredFiles: string[] }>();
    const api = createApiMock({ listFiles: vi.fn().mockReturnValue(deferred.promise) });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    const dirPath = '/repo';
    useFileListStore.setState((state) => {
      const cache = new Map(state.cache);
      cache.set(dirPath, {
        files: ['existing.ts'],
        gitIgnoredFiles: ['ignored.log'],
        isLoading: false,
      });
      return { cache };
    });

    const promise = useFileListStore.getState().fetchFileList(dirPath);
    const loadingEntry = useFileListStore.getState().getFileList(dirPath);
    expect(loadingEntry?.isLoading).toBe(true);
    expect(loadingEntry?.files).toEqual(['existing.ts']);

    deferred.resolve({ files: ['next.ts'], gitIgnoredFiles: [] });
    await promise;

    const loaded = useFileListStore.getState().getFileList(dirPath);
    expect(loaded).toEqual({
      files: ['next.ts'],
      // gitIgnoredFiles preserved from cache when not explicitly requested
      gitIgnoredFiles: ['ignored.log'],
      emptyDirs: [],
      isLoading: false,
    });

    const failingApi = createApiMock({
      listFiles: vi.fn().mockRejectedValue(new Error('list failed')),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api: failingApi };

    await expect(useFileListStore.getState().fetchFileList(dirPath)).rejects.toThrow('list failed');
    expect(useFileListStore.getState().getFileList(dirPath)?.isLoading).toBe(false);
  });

  it('evicts a deleted subtree from tracked, ignored, and empty file lists', () => {
    const dirPath = '/repo';
    useFileListStore.setState((state) => {
      const cache = new Map(state.cache);
      cache.set(dirPath, {
        files: ['src/app.ts', 'build/kept.txt'],
        gitIgnoredFiles: ['build/cache/a.js', 'build.log'],
        emptyDirs: ['build/empty', 'docs'],
        isLoading: false,
      });
      const userCreatedDirs = new Map(state.userCreatedDirs);
      userCreatedDirs.set(dirPath, new Set(['build/empty', 'docs']));
      return { cache, userCreatedDirs };
    });

    useFileListStore.getState().evictPath(dirPath, 'build');

    expect(useFileListStore.getState().getFileList(dirPath)).toEqual({
      files: ['src/app.ts'],
      gitIgnoredFiles: ['build.log'],
      emptyDirs: ['docs'],
      isLoading: false,
    });
    expect(useFileListStore.getState().userCreatedDirs.get(dirPath)).toEqual(new Set(['docs']));
  });

  it('shares one request between file-list fetches made in the same tick', async () => {
    const api = createApiMock({
      listWorkspaceFiles: vi
        .fn()
        .mockResolvedValue({ files: ['src/app.ts'], gitIgnoredFiles: [], emptyDirs: [] }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const dirPath = '/repo';

    const first = useFileListStore.getState().fetchFileList(dirPath, false, 'ws-1');
    const second = useFileListStore.getState().fetchFileList(dirPath, false, 'ws-1');
    await Promise.all([first, second]);

    expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(await second).toEqual(await first);

    await useFileListStore.getState().fetchFileList(dirPath, false, 'ws-1');
    expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(2);
  });

  it('discards file-list responses started before a path eviction', async () => {
    const stale = createDeferred<{
      files: string[];
      gitIgnoredFiles: string[];
      emptyDirs: string[];
    }>();
    const api = createApiMock({
      listFiles: vi
        .fn()
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValueOnce({ files: ['src/keep.ts'], gitIgnoredFiles: [], emptyDirs: [] }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const dirPath = '/repo';

    const staleRequest = useFileListStore.getState().fetchFileList(dirPath);
    useFileListStore.getState().evictPath(dirPath, 'src/deleted.ts');
    const freshRequest = useFileListStore.getState().fetchFileList(dirPath);
    await freshRequest;
    stale.resolve({
      files: ['src/deleted.ts', 'src/keep.ts'],
      gitIgnoredFiles: [],
      emptyDirs: [],
    });
    await staleRequest;

    expect(useFileListStore.getState().getFileList(dirPath)?.files).toEqual(['src/keep.ts']);
  });

  it('preserves an in-flight ignored-file result during a basic refresh', async () => {
    const ignored = createDeferred<{
      files: string[];
      gitIgnoredFiles: string[];
      emptyDirs: string[];
    }>();
    const api = createApiMock({
      listFiles: vi
        .fn()
        .mockReturnValueOnce(ignored.promise)
        .mockResolvedValueOnce({ files: ['src/app.ts'], gitIgnoredFiles: [], emptyDirs: [] }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const dirPath = '/repo';

    const ignoredRequest = useFileListStore.getState().fetchFileList(dirPath, true);
    await useFileListStore.getState().fetchFileList(dirPath, false);
    ignored.resolve({
      files: ['src/app.ts'],
      gitIgnoredFiles: ['dist/bundle.js'],
      emptyDirs: [],
    });
    await ignoredRequest;

    expect(useFileListStore.getState().getFileList(dirPath)?.gitIgnoredFiles).toEqual([
      'dist/bundle.js',
    ]);
  });

  it('lists files through the workspace API when a workspace ID is provided', async () => {
    const api = createApiMock({
      listWorkspaceFiles: vi.fn().mockResolvedValue({
        files: ['src/remote.ts'],
        gitIgnoredFiles: ['dist/bundle.js'],
        emptyDirs: [],
      }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await useFileListStore.getState().fetchFileList('ssh://dev/repo', true, 'ws-ssh');

    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('ws-ssh', true);
    expect(api.listFiles).not.toHaveBeenCalled();
    expect(useFileListStore.getState().getFileList('ssh://dev/repo')?.files).toEqual([
      'src/remote.ts',
    ]);
  });

  it('re-fetches a stale list the next time it is needed', async () => {
    const api = createApiMock({
      listWorkspaceFiles: vi
        .fn()
        .mockResolvedValue({ files: ['src/new.ts'], gitIgnoredFiles: [], emptyDirs: [] }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const dirPath = 'ssh://dev/repo';
    useFileListStore.setState({
      cache: new Map([
        [dirPath, { files: ['src/old.ts'], gitIgnoredFiles: [], emptyDirs: [], isLoading: false }],
      ]),
    });

    await useFileListStore.getState().fetchFileListIfNeeded(dirPath, 'ws-ssh');
    expect(api.listWorkspaceFiles).not.toHaveBeenCalled();

    useFileListStore.getState().markFileListStale(dirPath);
    expect(useFileListStore.getState().getFileList(dirPath)).toMatchObject({
      files: ['src/old.ts'],
      isStale: true,
    });
    await useFileListStore.getState().fetchFileListIfNeeded(dirPath, 'ws-ssh');

    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('ws-ssh', false);
    expect(useFileListStore.getState().getFileList(dirPath)?.files).toEqual(['src/new.ts']);
    expect(useFileListStore.getState().getFileList(dirPath)?.isStale).toBeUndefined();
  });

  it('keeps a list stale when it goes stale during a fetch', async () => {
    const deferred = createDeferred<{
      files: string[];
      gitIgnoredFiles: string[];
      emptyDirs: string[];
    }>();
    const api = createApiMock({ listWorkspaceFiles: vi.fn().mockReturnValue(deferred.promise) });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    const dirPath = 'ssh://dev/repo';
    useFileListStore.setState({
      cache: new Map([
        [dirPath, { files: ['src/old.ts'], gitIgnoredFiles: [], emptyDirs: [], isLoading: false }],
      ]),
    });

    const request = useFileListStore.getState().fetchFileList(dirPath, false, 'ws-ssh');
    useFileListStore.getState().markFileListStale(dirPath);
    deferred.resolve({ files: ['src/new.ts'], gitIgnoredFiles: [], emptyDirs: [] });
    await request;

    expect(useFileListStore.getState().getFileList(dirPath)).toMatchObject({
      files: ['src/new.ts'],
      isLoading: false,
      isStale: true,
    });
  });

  it('keeps a list current while reports show the files it lists', () => {
    const dirPath = 'ssh://dev/repo';
    const list = {
      files: ['src/old.ts'],
      gitIgnoredFiles: [],
      emptyDirs: [],
      isLoading: false,
      fileListHash: 'listed',
    };
    useFileListStore.setState({ cache: new Map([[dirPath, list]]) });
    const before = useFileListStore.getState().cache;

    useFileListStore.getState().markFileListStale(dirPath, 'listed');
    expect(useFileListStore.getState().cache).toBe(before);

    // A file came and went before the tree re-listed.
    useFileListStore.getState().markFileListStale(dirPath, 'added');
    expect(useFileListStore.getState().getFileList(dirPath)?.isStale).toBe(true);
    useFileListStore.getState().markFileListStale(dirPath, 'listed');
    expect(useFileListStore.getState().getFileList(dirPath)?.isStale).toBeFalsy();
  });

  it.each([
    { listed: 'latest', staysStale: false },
    { listed: 'earlier', staysStale: true },
  ])(
    'clears a mark set during a fetch only if the listing has the latest report’s files ($listed)',
    async ({ listed, staysStale }) => {
      const deferred = createDeferred<{
        files: string[];
        gitIgnoredFiles: string[];
        emptyDirs: string[];
        fileListHash: string;
      }>();
      const api = createApiMock({ listWorkspaceFiles: vi.fn().mockReturnValue(deferred.promise) });
      (globalThis as { window: { api: ApiMock } }).window = { api };
      const dirPath = 'ssh://dev/repo';
      useFileListStore.setState({
        cache: new Map([
          [
            dirPath,
            {
              files: ['src/old.ts'],
              gitIgnoredFiles: [],
              emptyDirs: [],
              isLoading: false,
              fileListHash: 'earlier',
            },
          ],
        ]),
      });

      const request = useFileListStore.getState().fetchFileList(dirPath, false, 'ws-ssh');
      // A report matching the list being replaced still marks it: the fetch may predate it.
      useFileListStore.getState().markFileListStale(dirPath, 'earlier');
      useFileListStore.getState().markFileListStale(dirPath, 'latest');
      deferred.resolve({
        files: ['src/new.ts'],
        gitIgnoredFiles: [],
        emptyDirs: [],
        fileListHash: listed,
      });
      await request;

      expect(useFileListStore.getState().getFileList(dirPath)).toMatchObject({
        files: ['src/new.ts'],
        fileListHash: listed,
      });
      expect(!!useFileListStore.getState().getFileList(dirPath)?.isStale).toBe(staysStale);
    }
  );

  it('ignores a stale mark for a list it never loaded', () => {
    useFileListStore.getState().markFileListStale('ssh://dev/repo');

    expect(useFileListStore.getState().getFileList('ssh://dev/repo')).toBeUndefined();
  });

  it('preserves backend-provided empty directories in the renderer cache', async () => {
    const api = createApiMock({
      listWorkspaceFiles: vi.fn().mockResolvedValue({
        files: [],
        gitIgnoredFiles: [],
        emptyDirs: ['docs/empty'],
      }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await useFileListStore.getState().fetchFileList('ssh://dev/repo', false, 'ws-ssh');

    expect(useFileListStore.getState().getFileList('ssh://dev/repo')?.emptyDirs).toEqual([
      'docs/empty',
    ]);
  });

  it('keeps the cached arrays when a re-list returns the same paths, so trees skip the update', async () => {
    const listing = () => ({
      files: ['src/a.ts', 'src/b.ts'],
      gitIgnoredFiles: ['dist/out.js'],
      emptyDirs: ['notes'],
    });
    const api = createApiMock({
      listWorkspaceFiles: vi.fn().mockResolvedValueOnce(listing()).mockResolvedValueOnce(listing()),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    await useFileListStore.getState().fetchFileList('/repo', true, 'ws-1');
    const first = useFileListStore.getState().getFileList('/repo')!;
    await useFileListStore.getState().fetchFileList('/repo', true, 'ws-1');
    const second = useFileListStore.getState().getFileList('/repo')!;

    expect(second.files).toBe(first.files);
    expect(second.gitIgnoredFiles).toBe(first.gitIgnoredFiles);
    expect(second.emptyDirs).toBe(first.emptyDirs);
  });

  it('fetchDiffIfNeeded returns cached data, skips stale loading requests, and fetches when absent', async () => {
    const dirPath = '/repo';
    const cachedData = {
      files: [],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    };

    useFileListStore.setState((state) => {
      const diffCache = new Map(state.diffCache);
      diffCache.set(dirPath, { data: cachedData, isLoading: false, hasFullDiff: true });
      return { diffCache };
    });

    const fromCache = await useFileListStore.getState().fetchDiffIfNeeded(dirPath);
    expect(fromCache).toEqual(cachedData);
    expect(globalThis.window.api.getDiff).not.toHaveBeenCalled();

    useFileListStore.setState((state) => {
      const diffCache = new Map(state.diffCache);
      diffCache.set(dirPath, { data: cachedData, isLoading: true, hasFullDiff: true });
      return { diffCache };
    });

    const whileLoading = await useFileListStore.getState().fetchDiffIfNeeded(dirPath);
    expect(whileLoading).toBeUndefined();
    expect(globalThis.window.api.getDiff).not.toHaveBeenCalled();

    useFileListStore.setState((state) => {
      const diffCache = new Map(state.diffCache);
      diffCache.delete(dirPath);
      return { diffCache };
    });

    const fetched = await useFileListStore.getState().fetchDiffIfNeeded(dirPath);
    expect(globalThis.window.api.getDiff).toHaveBeenCalledWith(dirPath);
    expect(fetched?.summary.filesChanged).toBe(0);
  });

  it('fetchDiffIfNeeded waits for the diff already being fetched', async () => {
    const dirPath = '/repo';
    const diff = createDeferred<unknown>();
    const fetchedDiff = {
      files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    };
    globalThis.window.api.getDiff.mockReturnValueOnce(diff.promise);

    const running = useFileListStore.getState().fetchDiff(dirPath);
    const waiting = useFileListStore.getState().fetchDiffIfNeeded(dirPath);
    diff.resolve(fetchedDiff);

    await expect(waiting).resolves.toEqual(fetchedDiff);
    await running;
    expect(globalThis.window.api.getDiff).toHaveBeenCalledOnce();
  });

  it('fetchDiffIfNeeded leaves a failed fetch to the caller that started it', async () => {
    const dirPath = '/repo';
    const diff = createDeferred<unknown>();
    globalThis.window.api.getDiff.mockReturnValueOnce(diff.promise);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const running = useFileListStore.getState().fetchDiff(dirPath);
    const waiting = useFileListStore.getState().fetchDiffIfNeeded(dirPath);
    diff.reject(new Error('host offline'));

    await expect(waiting).resolves.toBeUndefined();
    await expect(running).rejects.toThrow('host offline');
  });

  it('refreshes both workspace and directory diff cache entries', async () => {
    const dirPath = 'ssh://dev/repo';
    const workspaceId = 'ssh-workspace';
    const persistedDiff = {
      files: [{ path: 'old.ts', status: 'modified' as const }],
      summary: { additions: 1, deletions: 0, filesChanged: 1 },
    };
    const freshDiff = {
      files: [{ path: 'fresh.ts', status: 'added' as const }],
      summary: { additions: 2, deletions: 0, filesChanged: 1 },
    };
    const api = createApiMock({ getWorkspaceDiff: vi.fn().mockResolvedValue(freshDiff) });
    (globalThis as { window: { api: ApiMock } }).window = { api };
    useFileListStore.getState().applyPushedFileStatus(dirPath, persistedDiff, workspaceId);

    await useFileListStore.getState().fetchDiff(dirPath, undefined, false, workspaceId);

    const expected = { data: freshDiff, isLoading: false, hasFullDiff: true };
    expect(useFileListStore.getState().getDiff(dirPath)).toEqual(expected);
    expect(useFileListStore.getState().getDiff(dirPath, undefined, false, workspaceId)).toEqual(
      expected
    );
    expect(api.getWorkspaceDiff).toHaveBeenCalledWith(workspaceId);
  });

  it('reuses in-flight file diff content requests', async () => {
    const dirPath = '/repo';
    const deferred = createDeferred<{
      path: string;
      oldContent: string | null;
      newContent: string | null;
      status: 'modified';
      isBinary: false;
    }>();
    const api = createApiMock({
      getFileDiffContent: vi.fn().mockReturnValue(deferred.promise),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    const firstLoad = useFileListStore
      .getState()
      .fetchFileDiffContent(dirPath, 'src/app.ts', false);
    const secondLoad = useFileListStore
      .getState()
      .fetchFileDiffContentIfNeeded(dirPath, 'src/app.ts', false);

    expect(api.getFileDiffContent).toHaveBeenCalledTimes(1);
    expect(
      useFileListStore.getState().getFileDiffContent(dirPath, 'src/app.ts', false)?.isLoading
    ).toBe(true);

    deferred.resolve({
      path: 'src/app.ts',
      oldContent: 'old',
      newContent: 'new',
      status: 'modified',
      isBinary: false,
    });

    await expect(firstLoad).resolves.toMatchObject({ path: 'src/app.ts' });
    await expect(secondLoad).resolves.toMatchObject({ path: 'src/app.ts' });
    expect(api.getFileDiffContent).toHaveBeenCalledTimes(1);
    expect(useFileListStore.getState().getFileDiffContent(dirPath, 'src/app.ts', false)).toEqual({
      content: {
        path: 'src/app.ts',
        oldContent: 'old',
        newContent: 'new',
        status: 'modified',
        isBinary: false,
      },
      isLoading: false,
    });
  });

  it('keeps the file diff cache identity when nothing needs invalidating', () => {
    const before = useFileListStore.getState().fileDiffCache;

    useFileListStore.getState().invalidateFileDiffs('/repo', 'ws-1');

    expect(useFileListStore.getState().fileDiffCache).toBe(before);
  });

  it('marks stale only the file diffs of the changed paths it is given', () => {
    const content = {
      path: '',
      oldContent: 'old',
      newContent: 'new',
      status: 'modified' as const,
      isBinary: false,
    };
    const keys = [
      'workspace:ws-1:src/app.ts',
      'workspace:ws-1:src/app.ts:branch:main',
      'workspace:ws-1:lib/nested/util.ts',
      'workspace:ws-1:src/app.tsx',
      'workspace:ws-1:README.md',
    ];
    useFileListStore.setState({
      fileDiffCache: new Map(keys.map((key) => [key, { content, isLoading: false }])),
    });

    useFileListStore
      .getState()
      .invalidateFileDiffs('ssh://dev/repo', 'ws-1', ['src/app.ts', 'lib']);

    const stale = keys.filter((key) => useFileListStore.getState().fileDiffCache.get(key)?.isStale);
    expect(stale).toEqual([
      'workspace:ws-1:src/app.ts',
      'workspace:ws-1:src/app.ts:branch:main',
      'workspace:ws-1:lib/nested/util.ts',
    ]);
  });

  it('keeps file diff content stale when invalidated during an in-flight request', async () => {
    const dirPath = '/repo';
    const deferred = createDeferred<{
      path: string;
      oldContent: string | null;
      newContent: string | null;
      status: 'modified';
      isBinary: false;
    }>();
    const api = createApiMock({
      getFileDiffContent: vi.fn().mockReturnValue(deferred.promise),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    const load = useFileListStore.getState().fetchFileDiffContent(dirPath, 'src/app.ts', false);
    useFileListStore.getState().invalidateFileDiffs(dirPath);

    deferred.resolve({
      path: 'src/app.ts',
      oldContent: 'old',
      newContent: 'new',
      status: 'modified',
      isBinary: false,
    });
    await load;

    expect(
      useFileListStore.getState().getFileDiffContent(dirPath, 'src/app.ts', false)?.isStale
    ).toBe(true);
  });

  it.each([false, 'main'] as const)(
    'keeps file diff content stale when invalidated during a request that started stale (%s)',
    async (stagedOrBranch) => {
      const dirPath = '/repo';
      const content = {
        path: 'src/app.ts',
        oldContent: 'old',
        newContent: 'new',
        status: 'modified' as const,
        isBinary: false,
      };
      const deferred = createDeferred<typeof content>();
      const fetchContent = vi
        .fn()
        .mockResolvedValueOnce(content)
        .mockReturnValueOnce(deferred.promise);
      (globalThis as { window: { api: ApiMock } }).window = {
        api: createApiMock({
          getFileDiffContent: fetchContent,
          getFileDiffContentAgainstBranch: fetchContent,
        }),
      };
      const store = () => useFileListStore.getState();
      const fetch = () =>
        store().fetchFileDiffContentIfNeeded(dirPath, 'src/app.ts', stagedOrBranch);
      await fetch();
      store().invalidateFileDiffs(dirPath);

      const load = fetch();
      store().invalidateFileDiffs(dirPath);
      deferred.resolve(content);
      await load;

      expect(store().getFileDiffContent(dirPath, 'src/app.ts', stagedOrBranch)?.isStale).toBe(true);
    }
  );

  it('clears stale when a file diff content request starts from a stale entry', async () => {
    const dirPath = '/repo';
    const api = createApiMock({
      getFileDiffContent: vi.fn().mockResolvedValue({
        path: 'src/app.ts',
        oldContent: 'fresh old',
        newContent: 'fresh new',
        status: 'modified',
        isBinary: false,
      }),
    });
    (globalThis as { window: { api: ApiMock } }).window = { api };

    useFileListStore.setState((state) => {
      const fileDiffCache = new Map(state.fileDiffCache);
      fileDiffCache.set(`${dirPath}:src/app.ts`, {
        content: {
          path: 'src/app.ts',
          oldContent: 'old',
          newContent: 'new',
          status: 'modified',
          isBinary: false,
        },
        isLoading: false,
        isStale: true,
      });
      return { fileDiffCache };
    });

    await useFileListStore.getState().fetchFileDiffContentIfNeeded(dirPath, 'src/app.ts', false);

    expect(useFileListStore.getState().getFileDiffContent(dirPath, 'src/app.ts', false)).toEqual({
      content: {
        path: 'src/app.ts',
        oldContent: 'fresh old',
        newContent: 'fresh new',
        status: 'modified',
        isBinary: false,
      },
      isLoading: false,
    });
  });

  it('invalidates only matching directory entries and handles empty caches', () => {
    const dirPath = '/repo';
    const otherDir = '/other';

    useFileListStore.setState((state) => {
      const cache = new Map(state.cache);
      cache.set(dirPath, { files: ['a.ts'], gitIgnoredFiles: [], isLoading: false });
      cache.set(otherDir, { files: ['b.ts'], gitIgnoredFiles: [], isLoading: false });

      const statusCache = new Map(state.statusCache);
      statusCache.set(dirPath, { statuses: new Map([['a.ts', 'modified']]), isLoading: false });
      statusCache.set(otherDir, { statuses: new Map([['b.ts', 'modified']]), isLoading: false });

      const diffCache = new Map(state.diffCache);
      diffCache.set(dirPath, {
        data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        isLoading: false,
      });
      diffCache.set(`${dirPath}:main`, {
        data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        isLoading: false,
      });
      diffCache.set(otherDir, {
        data: { files: [], summary: { additions: 0, deletions: 0, filesChanged: 0 } },
        isLoading: false,
      });

      const fileDiffCache = new Map(state.fileDiffCache);
      fileDiffCache.set(`${dirPath}:a.ts`, {
        content: {
          path: 'a.ts',
          oldContent: null,
          newContent: null,
          status: 'modified',
          isBinary: false,
        },
        isLoading: false,
      });
      fileDiffCache.set(`${otherDir}:b.ts`, {
        content: {
          path: 'b.ts',
          oldContent: null,
          newContent: null,
          status: 'modified',
          isBinary: false,
        },
        isLoading: false,
      });

      return { cache, statusCache, diffCache, fileDiffCache };
    });

    useFileListStore.getState().invalidate(dirPath);

    expect(useFileListStore.getState().cache.has(dirPath)).toBe(false);
    expect(useFileListStore.getState().statusCache.has(dirPath)).toBe(false);
    expect(useFileListStore.getState().diffCache.has(dirPath)).toBe(false);
    expect(useFileListStore.getState().diffCache.has(`${dirPath}:main`)).toBe(false);
    expect(useFileListStore.getState().fileDiffCache.has(`${dirPath}:a.ts`)).toBe(false);

    expect(useFileListStore.getState().cache.has(otherDir)).toBe(true);
    expect(useFileListStore.getState().diffCache.has(otherDir)).toBe(true);

    useFileListStore.getState().invalidate('/does-not-exist');
    expect(useFileListStore.getState().cache.has(otherDir)).toBe(true);
  });

  it('also invalidates the diffs cached under the workspace id', async () => {
    const store = useFileListStore.getState();
    await store.fetchDiff('/repo', undefined, false, 'ws-1');
    await store.fetchDiff('/repo', 'main', true, 'ws-1');
    await store.fetchDiff('/repo-10', 'main', true, 'ws-10');

    store.invalidate('/repo', 'ws-1');

    expect(store.getDiff('/repo', undefined, false, 'ws-1')).toBeUndefined();
    expect(store.getDiff('/repo', 'main', true, 'ws-1')).toBeUndefined();
    expect(store.getDiff('/repo-10', 'main', true, 'ws-10')).toBeDefined();
  });

  describe('applyPushedFileStatus', () => {
    it('clears hasFullDiff so stale data is re-fetched on next viewer open', () => {
      const dirPath = '/repo';

      // Seed a full diff cache entry
      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(
          dirPath,
          makeDiffEntry({
            data: {
              files: [
                { path: 'old.ts', status: 'modified', staged: false, additions: 1, deletions: 1 },
              ],
              summary: { additions: 1, deletions: 1, filesChanged: 1 },
            },
            hasFullDiff: true,
          })
        );
        return { diffCache };
      });

      // Apply pushed status with updated files (simulates a file edit)
      useFileListStore.getState().applyPushedFileStatus(dirPath, {
        files: [
          {
            path: 'old.ts',
            status: 'modified' as const,
            staged: false,
            additions: 5,
            deletions: 2,
          },
          { path: 'new.ts', status: 'added' as const, staged: false, additions: 10, deletions: 0 },
        ],
        summary: { additions: 15, deletions: 2, filesChanged: 2 },
      });

      const cached = useFileListStore.getState().diffCache.get(dirPath)!;

      // hasFullDiff should be false so fetchDiffIfNeeded re-fetches
      expect(cached.hasFullDiff).toBe(false);

      // File list and summary should be updated immediately
      expect(cached.data.files).toHaveLength(2);
      expect(cached.data.summary.additions).toBe(15);
      expect(cached.data.summary.filesChanged).toBe(2);
    });

    it('updates file statuses and sets ancestor directories as modified', () => {
      const dirPath = '/repo';

      useFileListStore.getState().applyPushedFileStatus(dirPath, {
        files: [
          {
            path: 'src/lib/utils.ts',
            status: 'modified' as const,
            staged: false,
            additions: 3,
            deletions: 1,
          },
        ],
        summary: { additions: 3, deletions: 1, filesChanged: 1 },
      });

      const statuses = useFileListStore.getState().statusCache.get(dirPath)!.statuses;
      expect(statuses.get('src/lib/utils.ts')).toBe('modified');
      expect(statuses.get('src/lib')).toBe('modified');
      expect(statuses.get('src')).toBe('modified');
    });

    it('does not touch branch comparison diff cache entries', () => {
      const dirPath = '/repo';

      // Seed both base and branch comparison entries
      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(dirPath, makeDiffEntry({ hasFullDiff: true }));
        diffCache.set(
          `${dirPath}:main`,
          makeDiffEntry({
            data: {
              files: [{ path: 'x.ts', status: 'modified' }],
              summary: { additions: 1, deletions: 0, filesChanged: 1 },
            },
            hasFullDiff: true,
          })
        );
        return { diffCache };
      });

      // Apply pushed status — should only update the base key
      useFileListStore.getState().applyPushedFileStatus(dirPath, {
        files: [],
        summary: { additions: 0, deletions: 0, filesChanged: 0 },
      });

      // Base entry was updated
      expect(useFileListStore.getState().diffCache.get(dirPath)!.hasFullDiff).toBe(false);

      // Branch comparison entry was NOT touched
      const branchEntry = useFileListStore.getState().diffCache.get(`${dirPath}:main`)!;
      expect(branchEntry.hasFullDiff).toBe(true);
      expect(branchEntry.data.files).toHaveLength(1);
    });

    it('fetchDiffIfNeeded re-fetches after applyPushedFileStatus clears hasFullDiff', async () => {
      const dirPath = '/repo';
      const freshDiff = {
        files: [{ path: 'fresh.ts', status: 'added' }],
        summary: { additions: 5, deletions: 0, filesChanged: 1 },
      };
      const api = createApiMock({ getDiff: vi.fn().mockResolvedValue(freshDiff) });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      // Seed with stale full diff
      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(
          dirPath,
          makeDiffEntry({
            data: {
              files: [],
              summary: { additions: 0, deletions: 0, filesChanged: 0 },
            },
            hasFullDiff: true,
          })
        );
        return { diffCache };
      });

      // Apply pushed status clears hasFullDiff
      useFileListStore.getState().applyPushedFileStatus(dirPath, {
        files: [
          { path: 'fresh.ts', status: 'added' as const, staged: false, additions: 5, deletions: 0 },
        ],
        summary: { additions: 5, deletions: 0, filesChanged: 1 },
      });

      // Now fetchDiffIfNeeded should re-fetch because hasFullDiff is false
      const result = await useFileListStore.getState().fetchDiffIfNeeded(dirPath);
      expect(api.getDiff).toHaveBeenCalledWith(dirPath);
      expect(result?.summary.additions).toBe(5);
      expect(result?.files[0]?.path).toBe('fresh.ts');
    });
  });

  describe('invalidateBranchComparisonDiffs', () => {
    it('clears branch comparison entries but preserves the base diff', () => {
      const dirPath = '/repo';

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(dirPath, makeDiffEntry({ hasFullDiff: true }));
        diffCache.set(`${dirPath}:main`, makeDiffEntry({ hasFullDiff: true }));
        diffCache.set(`${dirPath}:develop`, makeDiffEntry({ hasFullDiff: true }));
        return { diffCache };
      });

      useFileListStore.getState().invalidateBranchComparisonDiffs(dirPath);

      // Base entry preserved with original data
      expect(useFileListStore.getState().diffCache.has(dirPath)).toBe(true);
      // Branch comparison entries preserved but marked stale
      const mainEntry = useFileListStore.getState().diffCache.get(`${dirPath}:main`);
      const developEntry = useFileListStore.getState().diffCache.get(`${dirPath}:develop`);
      expect(mainEntry).toBeDefined();
      expect(developEntry).toBeDefined();
      expect(mainEntry!.hasFullDiff).toBe(false);
      expect(developEntry!.hasFullDiff).toBe(false);
      // Data is preserved (not cleared)
      expect(mainEntry!.data).toBeDefined();
    });

    it('does not affect entries for other directories', () => {
      const dirPath = '/repo';
      const otherDir = '/other';

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(`${dirPath}:main`, makeDiffEntry());
        diffCache.set(otherDir, makeDiffEntry());
        diffCache.set(`${otherDir}:main`, makeDiffEntry());
        return { diffCache };
      });

      useFileListStore.getState().invalidateBranchComparisonDiffs(dirPath);

      // Target dir entry preserved but marked stale
      expect(useFileListStore.getState().diffCache.get(`${dirPath}:main`)?.hasFullDiff).toBe(false);
      // Other dir entries untouched
      expect(useFileListStore.getState().diffCache.has(otherDir)).toBe(true);
      expect(useFileListStore.getState().diffCache.has(`${otherDir}:main`)).toBe(true);
    });

    it('is a no-op when there are no branch comparison entries', () => {
      const dirPath = '/repo';

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(dirPath, makeDiffEntry({ hasFullDiff: true }));
        return { diffCache };
      });

      useFileListStore.getState().invalidateBranchComparisonDiffs(dirPath);

      expect(useFileListStore.getState().diffCache.has(dirPath)).toBe(true);
      expect(useFileListStore.getState().diffCache.size).toBe(1);
    });

    it('keeps the cache identity when every branch comparison is already stale', () => {
      const dirPath = '/repo';

      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(dirPath, makeDiffEntry({ hasFullDiff: true }));
        diffCache.set(`${dirPath}:main`, makeDiffEntry({ hasFullDiff: false }));
        return { diffCache };
      });
      const before = useFileListStore.getState().diffCache;

      useFileListStore.getState().invalidateBranchComparisonDiffs(dirPath);

      expect(useFileListStore.getState().diffCache).toBe(before);
    });

    it('causes fetchDiffIfNeeded to re-fetch branch comparison after invalidation', async () => {
      const dirPath = '/repo';
      const freshBranchDiff = {
        files: [{ path: 'updated.ts', status: 'modified' }],
        summary: { additions: 10, deletions: 3, filesChanged: 1 },
      };
      const api = createApiMock({
        getDiffAgainstBranch: vi.fn().mockResolvedValue(freshBranchDiff),
      });
      (globalThis as { window: { api: ApiMock } }).window = { api };

      // Seed stale branch comparison
      useFileListStore.setState((state) => {
        const diffCache = new Map(state.diffCache);
        diffCache.set(
          `${dirPath}:main`,
          makeDiffEntry({
            data: {
              files: [],
              summary: { additions: 0, deletions: 0, filesChanged: 0 },
            },
            hasFullDiff: true,
          })
        );
        return { diffCache };
      });

      // Before invalidation: returns stale cached data
      const staleResult = await useFileListStore.getState().fetchDiffIfNeeded(dirPath, 'main');
      expect(staleResult?.files).toHaveLength(0);
      expect(api.getDiffAgainstBranch).not.toHaveBeenCalled();

      // Invalidate branch comparisons
      useFileListStore.getState().invalidateBranchComparisonDiffs(dirPath);

      // After invalidation: fetches fresh data
      const freshResult = await useFileListStore.getState().fetchDiffIfNeeded(dirPath, 'main');
      expect(api.getDiffAgainstBranch).toHaveBeenCalledWith(dirPath, 'main', false);
      expect(freshResult?.summary.additions).toBe(10);
      expect(freshResult?.files[0]?.path).toBe('updated.ts');
    });
  });

  describe('mayHaveChangedRemoteFile', () => {
    const dirPath = 'ssh://dev/repo';
    const mayHaveChanged = (filePath: string, change?: RemoteWorkingTreeChange) =>
      useFileListStore.getState().mayHaveChangedRemoteFile(dirPath, filePath, change);

    beforeEach(() => {
      const files = [
        'src/app.ts',
        'src/lib/util.ts',
        'README.md',
        '.komla-files/a.png',
        'linked-workspaces/peer/a.ts',
      ];
      useFileListStore.setState({
        cache: new Map([[dirPath, { files, gitIgnoredFiles: [], isLoading: false }]]),
      });
    });

    it('rules out a listed file the report does not name', () => {
      expect(mayHaveChanged('README.md', { changedPaths: ['src/app.ts'] })).toBe(false);
    });

    it.each([
      ['the file itself', ['src/app.ts']],
      ['a folder holding it', ['src']],
    ])('counts a file whose report names %s', (_, changedPaths) => {
      expect(mayHaveChanged('src/app.ts', { changedPaths })).toBe(true);
    });

    it('does not treat a sibling sharing a prefix as inside a changed folder', () => {
      expect(mayHaveChanged('src/lib/util.ts', { changedPaths: ['src/li'] })).toBe(false);
    });

    it.each([
      ['paths are unknown', 'README.md', { fileListHash: 'hash' }],
      ['there is no report', 'README.md', undefined],
      ['the file is ignored, so unwatched', '.env', { changedPaths: [] }],
      ['the file is a Komla import', '.komla-files/a.png', { changedPaths: [] }],
      ['the file is in a linked workspace', 'linked-workspaces/peer/a.ts', { changedPaths: [] }],
    ])('counts any file when %s', (_, filePath, change) => {
      expect(mayHaveChanged(filePath, change)).toBe(true);
    });

    it('counts any file while the list is not loaded', () => {
      useFileListStore.setState({ cache: new Map() });
      expect(mayHaveChanged('README.md', { changedPaths: [] })).toBe(true);
    });
  });
});

describe('findRenameSource', () => {
  const renamed = {
    path: 'new.ts',
    originalPath: 'old.ts',
    status: 'renamed' as const,
    staged: false,
    additions: 1,
    deletions: 0,
  };
  const listed = (files: (typeof renamed)[]) => ({
    data: { files, summary: { additions: 1, deletions: 0, filesChanged: files.length } },
    isLoading: false,
    hasFullDiff: false,
  });

  beforeEach(() => {
    useFileListStore.setState(useFileListStore.getInitialState(), true);
  });

  it("reads a renamed file's previous path from the workspace's changes", () => {
    useFileListStore.setState({ diffCache: new Map([['workspace:ws-1', listed([renamed])]]) });

    expect(findRenameSource('/repo', 'new.ts', 'ws-1')).toBe('old.ts');
  });

  it('reads it from the statuses the file tree fetched for the directory', () => {
    useFileListStore.setState({ diffCache: new Map([['/repo', listed([renamed])]]) });

    expect(findRenameSource('/repo', 'new.ts', 'ws-1')).toBe('old.ts');
  });

  it('ignores the comparison against a branch', () => {
    useFileListStore.setState({ diffCache: new Map([['workspace:ws-1:main', listed([renamed])]]) });

    expect(findRenameSource('/repo', 'new.ts', 'ws-1')).toBeUndefined();
  });
});
