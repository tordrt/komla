/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { selectContentAreaProps } from '../../../../../src/renderer/components/workspaces/file-viewer/FileViewerMainPane';
import { useDiffViewerState } from '../../../../../src/renderer/components/workspaces/file-viewer/useFileViewerState';
import { useFileListStore } from '../../../../../src/renderer/stores/file-list.store';
import { useFileViewerStore } from '../../../../../src/renderer/stores/file-viewer.store';

import type {
  CommitDiff,
  CommitInfo,
  FileChange,
  FileDiffContent,
} from '../../../../../src/renderer/types';
import type { CommitGraph, CommitGraphCommit } from '../../../../../src/shared/types/commit-graph';

function graphCommit(hash: string): CommitGraphCommit {
  return { hash, parentHashes: [], author: 'Dev', timestamp: 1, message: 'Add files', refs: [] };
}

function page(commits: CommitGraphCommit[], hasMore = false): CommitGraph {
  return { commits, hasMore, currentBranch: 'main', upstream: 'origin/main' };
}

const commit: CommitInfo = {
  hash: 'abc123',
  shortHash: 'abc123',
  message: 'Add files',
  author: 'Dev',
  authorEmail: 'dev@example.com',
  timestamp: 1,
  parentHashes: [],
  refs: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fileChange(path: string): FileChange {
  return { path, status: 'modified', additions: 1, deletions: 1 } as FileChange;
}

const commitDiff: CommitDiff = {
  commit,
  files: [fileChange('a.ts'), fileChange('b.ts')],
  summary: { additions: 2, deletions: 2, filesChanged: 2 },
};

function content(path: string): FileDiffContent {
  return { path, oldContent: 'old', newContent: 'new', status: 'modified', isBinary: false };
}

describe('useDiffViewerState history errors', () => {
  const getWorkspaceCommitGraph = vi.fn();
  const getCommitDiff = vi.fn();
  const getCommitFileDiff = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceCommitGraph.mockReset();
    getCommitDiff.mockReset();
    getCommitFileDiff.mockReset();
    useFileListStore.setState(useFileListStore.getInitialState(), true);
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    window.api = {
      ...window.api,
      getWorkspaceCommitGraph,
      getWorkspaceCommitDiff: getCommitDiff,
      getWorkspaceCommitFileDiff: getCommitFileDiff,
    } as typeof window.api;
  });

  function renderDiffState() {
    return renderHook(() => useDiffViewerState('/repo', false, 'workspace-history'));
  }

  it('surfaces a commit log failure instead of an empty list, and Retry reloads it', async () => {
    getWorkspaceCommitGraph
      .mockRejectedValueOnce(new Error('fatal: bad revision'))
      .mockResolvedValue(page([graphCommit('abc123')]));
    const { result } = renderDiffState();

    await act(() => result.current.loadCommits());

    expect(result.current.historyError).toBe('fatal: bad revision');
    expect(result.current.commits).toEqual([]);

    act(() => result.current.retryHistory());

    await waitFor(() => expect(result.current.commits).toEqual([graphCommit('abc123')]));
    expect(result.current.historyError).toBeNull();
    expect(getWorkspaceCommitGraph).toHaveBeenCalledTimes(2);
  });

  it("reads the workspace's history a page at a time, of the chosen branch and file", async () => {
    getWorkspaceCommitGraph
      .mockResolvedValueOnce(page([graphCommit('c2')], true))
      .mockResolvedValueOnce(page([graphCommit('c1')]));
    const { result } = renderDiffState();

    act(() => {
      result.current.setHistoryBranch('origin/main');
      result.current.setHistoryFilterPath('src/a.ts');
    });
    await act(() => result.current.loadCommits());

    const query = { limit: 50, ref: 'origin/main', path: 'src/a.ts' };
    expect(getWorkspaceCommitGraph).toHaveBeenLastCalledWith('workspace-history', {
      ...query,
      skip: 0,
    });
    expect(result.current.historyBranchRoles).toEqual({
      currentBranch: 'main',
      upstream: 'origin/main',
    });
    expect(result.current.hasMoreCommits).toBe(true);

    await act(() => result.current.loadMoreCommits());

    expect(getWorkspaceCommitGraph).toHaveBeenLastCalledWith('workspace-history', {
      ...query,
      skip: 1,
    });
    expect(result.current.commits.map((c) => c.hash)).toEqual(['c2', 'c1']);
    expect(result.current.hasMoreCommits).toBe(false);
  });

  it('reads the older commits up to the one to show in one request, and shows up to its page', async () => {
    const commits = Array.from({ length: 150 }, (_, index) => graphCommit(`c${index}`));
    getWorkspaceCommitGraph
      .mockResolvedValueOnce(page(commits.slice(0, 50), true))
      .mockResolvedValueOnce(page(commits.slice(50)));
    const { result } = renderDiffState();

    await act(() => result.current.loadCommitsUntil('c60'));

    expect(getWorkspaceCommitGraph).toHaveBeenCalledTimes(2);
    expect(getWorkspaceCommitGraph).toHaveBeenLastCalledWith('workspace-history', {
      limit: 500,
      skip: 50,
    });
    expect(result.current.commits).toEqual(commits.slice(0, 100));
    expect(result.current.hasMoreCommits).toBe(true);
  });

  it('keeps the commit chosen last when an earlier choice answers later', async () => {
    const earlier = deferred<CommitDiff>();
    const later: CommitDiff = {
      ...commitDiff,
      commit: { ...commit, hash: 'def456' },
      files: [fileChange('c.ts')],
    };
    getCommitDiff.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(later);
    getCommitFileDiff.mockImplementation((_workspaceId: string, _hash: string, path: string) =>
      Promise.resolve(content(path))
    );
    const { result } = renderDiffState();

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.selectCommit('abc123');
    });
    await act(() => result.current.selectCommit('def456'));
    await act(async () => {
      earlier.resolve(commitDiff);
      await first;
    });

    expect(result.current.selectedCommitHash).toBe('def456');
    expect(result.current.commitDiff).toBe(later);
    expect(result.current.historySelectedFile).toBe('c.ts');
    expect(result.current.historyFileContent).toEqual(content('c.ts'));
    expect(result.current.loadingCommitDiff).toBe(false);
  });

  it('keeps the file chosen last when an earlier choice answers later', async () => {
    const earlier = deferred<FileDiffContent>();
    getCommitDiff.mockResolvedValue(commitDiff);
    getCommitFileDiff
      .mockResolvedValueOnce(content('a.ts'))
      .mockReturnValueOnce(earlier.promise)
      .mockResolvedValueOnce(content('a.ts'));
    const { result } = renderDiffState();
    await act(() => result.current.selectCommit('abc123'));

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.selectHistoryFile('b.ts');
    });
    await act(() => result.current.selectHistoryFile('a.ts'));
    await act(async () => {
      earlier.resolve(content('b.ts'));
      await first;
    });

    expect(result.current.historySelectedFile).toBe('a.ts');
    expect(result.current.historyFileContent).toEqual(content('a.ts'));
    expect(result.current.historyLoadingFile).toBe(false);
  });

  it("finishes loading a commit when another of its files is chosen before the first one's diff answers", async () => {
    const first = deferred<FileDiffContent>();
    getCommitDiff.mockResolvedValue(commitDiff);
    getCommitFileDiff.mockReturnValueOnce(first.promise).mockResolvedValueOnce(content('b.ts'));
    const { result } = renderDiffState();

    let opening: Promise<void> | undefined;
    await act(async () => {
      opening = result.current.selectCommit('abc123');
    });
    await act(() => result.current.selectHistoryFile('b.ts'));
    await act(async () => {
      first.resolve(content('a.ts'));
      await opening;
    });

    expect(result.current.historyFileContent).toEqual(content('b.ts'));
    expect(result.current.loadingCommitDiff).toBe(false);
  });

  it('stops loading a file of a commit left for one that changes no files', async () => {
    const pending = deferred<FileDiffContent>();
    getCommitDiff
      .mockResolvedValueOnce(commitDiff)
      .mockResolvedValueOnce({ ...commitDiff, commit: { ...commit, hash: 'def456' }, files: [] });
    getCommitFileDiff.mockReturnValueOnce(pending.promise);
    const { result } = renderDiffState();

    let opening: Promise<void> | undefined;
    await act(async () => {
      opening = result.current.selectCommit('abc123');
    });
    expect(result.current.historyLoadingFile).toBe(true);
    await act(() => result.current.selectCommit('def456'));
    await act(async () => {
      pending.resolve(content('a.ts'));
      await opening;
    });

    expect(result.current.historyFileContent).toBeNull();
    expect(result.current.historyLoadingFile).toBe(false);
  });

  it.each([
    ['branch', 'setHistoryBranch'],
    ["file's history", 'setHistoryFilterPath'],
  ] as const)('drops a commit still loading once History shows another %s', async (_, show) => {
    const diff = deferred<CommitDiff>();
    const file = deferred<FileDiffContent>();
    getCommitDiff
      .mockReturnValueOnce(diff.promise)
      .mockResolvedValueOnce({ ...commitDiff, commit: { ...commit, hash: 'def456' } });
    getCommitFileDiff.mockImplementation((_workspaceId: string, hash: string, path: string) =>
      hash === 'def456' ? file.promise : Promise.resolve(content(path))
    );
    const { result } = renderDiffState();

    // Before its diff answers.
    let opening: Promise<void> | undefined;
    act(() => {
      opening = result.current.selectCommit('abc123');
    });
    act(() => result.current[show]('feature'));
    await act(async () => {
      diff.resolve(commitDiff);
      await opening;
    });
    expect(result.current.commitDiff).toBeNull();
    expect(result.current.loadingCommitDiff).toBe(false);

    // Before its first file's diff answers.
    await act(async () => {
      opening = result.current.selectCommit('def456');
    });
    act(() => result.current[show](null));
    await act(async () => {
      file.resolve(content('a.ts'));
      await opening;
    });
    expect(result.current.historySelectedFile).toBeNull();
    expect(result.current.historyFileContent).toBeNull();
    expect(result.current.historyLoadingFile).toBe(false);
  });

  it("drops older commits of a branch left while they load, and keeps loading the new one's", async () => {
    const older = deferred<CommitGraph>();
    const feature = deferred<CommitGraph>();
    getWorkspaceCommitGraph
      .mockResolvedValueOnce(page([graphCommit('m2')], true))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(feature.promise);
    const { result } = renderDiffState();
    await act(() => result.current.loadCommits());

    let more: Promise<void> | undefined;
    act(() => {
      more = result.current.loadMoreCommits();
    });
    let load: Promise<void> | undefined;
    act(() => {
      result.current.setHistoryBranch('feature');
      load = result.current.loadCommits();
    });
    await act(async () => {
      older.resolve(page([graphCommit('m1')]));
      await more;
    });

    expect(result.current.loadingCommits).toBe(true);
    await act(async () => {
      feature.resolve(page([graphCommit('f1')]));
      await load;
    });
    expect(result.current.commits.map((c) => c.hash)).toEqual(['f1']);
    expect(result.current.loadingCommits).toBe(false);
  });

  it('surfaces a commit diff failure, and Retry reloads the same commit', async () => {
    getCommitDiff.mockRejectedValueOnce(new Error('diff failed')).mockResolvedValue(commitDiff);
    getCommitFileDiff.mockResolvedValue(content('a.ts'));
    const { result } = renderDiffState();

    await act(() => result.current.selectCommit('abc123'));

    expect(result.current.historyError).toBe('diff failed');

    act(() => result.current.retryHistory());

    await waitFor(() => expect(result.current.historyFileContent).toEqual(content('a.ts')));
    expect(result.current.historyError).toBeNull();
    expect(getCommitDiff).toHaveBeenNthCalledWith(2, 'workspace-history', 'abc123');
  });

  it('surfaces a file diff failure, and Retry reloads the same file', async () => {
    getCommitDiff.mockResolvedValue(commitDiff);
    getCommitFileDiff
      .mockResolvedValueOnce(content('a.ts'))
      .mockRejectedValueOnce(new Error('file diff failed'))
      .mockResolvedValue(content('b.ts'));
    const { result } = renderDiffState();

    await act(() => result.current.selectCommit('abc123'));
    await act(() => result.current.selectHistoryFile('b.ts'));

    expect(result.current.historyError).toBe('file diff failed');
    expect(result.current.historySelectedFile).toBe('b.ts');

    act(() => result.current.retryHistory());

    await waitFor(() => expect(result.current.historyFileContent).toEqual(content('b.ts')));
    expect(result.current.historyError).toBeNull();
    expect(getCommitFileDiff).toHaveBeenLastCalledWith('workspace-history', 'abc123', 'b.ts');
  });

  it('lets the user force-load a large history file, reset per file', async () => {
    getCommitDiff.mockResolvedValue(commitDiff);
    getCommitFileDiff.mockImplementation((_workspaceId: string, _hash: string, path: string) =>
      Promise.resolve(content(path))
    );
    const { result } = renderDiffState();

    await act(() => result.current.selectCommit('abc123'));
    expect(result.current.historyForceLargeFile).toBe(false);

    act(() => result.current.loadHistoryLargeFile());
    expect(result.current.historyForceLargeFile).toBe(true);

    await act(() => result.current.selectHistoryFile('b.ts'));
    expect(result.current.historyForceLargeFile).toBe(false);
  });
});

describe('selectContentAreaProps in History', () => {
  function historyState(overrides: Record<string, unknown> = {}) {
    return {
      diff: {
        historyFileContent: null,
        historyViewMode: 'split',
        historySelectedFile: 'a.ts',
        loadingCommitDiff: false,
        historyLoadingFile: false,
        selectedCommitHash: 'abc123',
        historyError: 'diff failed',
        historyForceLargeFile: true,
        retryHistory: vi.fn(),
        loadHistoryLargeFile: vi.fn(),
        fileError: 'working tree error',
        forceLargeFile: false,
        retryFile: vi.fn(),
        loadLargeFile: vi.fn(),
        ...overrides,
      },
    } as never;
  }

  it('wires history errors, Retry and Load Anyway to the history state', () => {
    const state = historyState();
    const props = selectContentAreaProps({
      state,
      isHistory: true,
      isMonacoReady: true,
      monacoLoadError: null,
    });
    const diff = (state as { diff: Record<string, ReturnType<typeof vi.fn>> }).diff;

    expect(props.diffError).toBe('diff failed');
    expect(props.forceLargeFile).toBe(true);

    props.onRetry();
    props.onLoadLargeFile();

    expect(diff.retryHistory).toHaveBeenCalledTimes(1);
    expect(diff.loadHistoryLargeFile).toHaveBeenCalledTimes(1);
    expect(diff.retryFile).not.toHaveBeenCalled();
    expect(diff.loadLargeFile).not.toHaveBeenCalled();
  });

  it('still prefers the Monaco load error', () => {
    const props = selectContentAreaProps({
      state: historyState(),
      isHistory: true,
      isMonacoReady: false,
      monacoLoadError: 'Failed to initialize editor',
    });
    expect(props.diffError).toBe('Failed to initialize editor');
  });
});
