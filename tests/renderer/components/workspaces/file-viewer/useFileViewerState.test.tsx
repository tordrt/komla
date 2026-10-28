/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useDiffViewerState,
  useFileEditorState,
} from '../../../../../src/renderer/components/workspaces/file-viewer/useFileViewerState';
import { useFileListStore } from '../../../../../src/renderer/stores/file-list.store';
import { useFileViewerStore } from '../../../../../src/renderer/stores/file-viewer.store';

describe('useFileEditorState binary previews', () => {
  const readFile = vi.fn();
  const readWorkspaceFile = vi.fn();
  const getFileMetadata = vi.fn();

  beforeEach(() => {
    useFileListStore.setState(useFileListStore.getInitialState(), true);
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    getFileMetadata.mockResolvedValue({ size: 42, mtimeMs: 100 });
    window.api = {
      ...window.api,
      readFile,
      readWorkspaceFile,
      getFileMetadata,
    } as typeof window.api;
  });

  it('offers self-contained browser previews for SSH HTML and SVG files', async () => {
    readWorkspaceFile.mockResolvedValue('<html><body>Remote report</body></html>');
    const { result } = renderHook(() =>
      useFileEditorState('ssh://host/home/dev/worktree', 'workspace-ssh')
    );

    await act(() => result.current.openFile('.komla-files/report.html'));

    expect(result.current.isBrowserPreviewable).toBe(true);
    expect(result.current.fileContent).toBe('<html><body>Remote report</body></html>');

    await act(() => result.current.openFile('diagram.svg'));
    expect(result.current.isBrowserPreviewable).toBe(true);

    await act(() => result.current.openFile('document.pdf'));
    expect(result.current.isBrowserPreviewable).toBe(true);
  });

  it('opens an SSH PDF without reading local file metadata', async () => {
    const { result } = renderHook(() =>
      useFileEditorState('ssh://host/home/dev/worktree', 'workspace-ssh')
    );

    await act(() => result.current.openFile('document.pdf'));

    expect(getFileMetadata).not.toHaveBeenCalled();
    expect(result.current.missingOnDisk).toBe(false);
    expect(result.current.fileContent).toBeNull();
    const firstVersion = result.current.diskContent;
    expect(firstVersion).not.toBeNull();

    await act(() => result.current.reloadFromDisk());

    expect(getFileMetadata).not.toHaveBeenCalled();
    expect(result.current.diskContent).not.toBe(firstVersion);
  });

  it.each(['photo.heic', 'photo.HEIF', 'document.pdf'])(
    'does not decode %s as UTF-8 text',
    async (filePath) => {
      const { result } = renderHook(() => useFileEditorState('/repo'));

      await act(() => result.current.openFile(filePath));

      expect(readFile).not.toHaveBeenCalled();
      expect(getFileMetadata).toHaveBeenCalledWith('/repo', filePath);
      expect(result.current.fileContent).toBeNull();
      expect(result.current.diskContent).toBe('42:100');
    }
  );

  it('keeps a deleted PDF diff available without reading working-tree metadata', async () => {
    const getWorkspaceFileDiffContent = vi.fn().mockResolvedValue({
      path: 'deleted.pdf',
      oldContent: null,
      newContent: null,
      status: 'deleted',
      isBinary: true,
    });
    getFileMetadata.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    window.api = {
      ...window.api,
      getWorkspaceFileDiffContent,
      getFileMetadata,
    } as typeof window.api;
    useFileListStore.setState({
      diffCache: new Map([
        [
          'workspace:workspace-deleted-pdf',
          {
            data: {
              files: [
                {
                  path: 'deleted.pdf',
                  status: 'deleted',
                  staged: false,
                  additions: 0,
                  deletions: 1,
                },
              ],
              summary: { additions: 0, deletions: 1, filesChanged: 1 },
            },
            isLoading: false,
            hasFullDiff: true,
          },
        ],
      ]),
    });

    const { result } = renderHook(() =>
      useDiffViewerState('/repo', false, 'workspace-deleted-pdf')
    );

    await act(() => result.current.selectFileByPath('deleted.pdf'));

    expect(getWorkspaceFileDiffContent).toHaveBeenCalledWith(
      'workspace-deleted-pdf',
      'deleted.pdf',
      false
    );
    expect(getFileMetadata).not.toHaveBeenCalled();
    expect(result.current.fileContent).toEqual(
      expect.objectContaining({ path: 'deleted.pdf', status: 'deleted', isBinary: true })
    );
    expect(result.current.fileError).toBeNull();
    expect(result.current.browserPreviewVersion).toBeNull();
  });

  it('keeps the current diff visible until a branch comparison finishes loading', async () => {
    const currentDiff = {
      files: [],
      summary: { additions: 1, deletions: 2, filesChanged: 1 },
    };
    const branchDiff = {
      files: [],
      summary: { additions: 3, deletions: 4, filesChanged: 2 },
    };
    let resolveBranchDiff: ((value: typeof branchDiff) => void) | undefined;
    const getWorkspaceDiffAgainstBranch = vi.fn(
      () =>
        new Promise<typeof branchDiff>((resolve) => {
          resolveBranchDiff = resolve;
        })
    );
    window.api = {
      ...window.api,
      getWorkspaceDiffAgainstBranch,
    } as typeof window.api;
    useFileListStore.setState({
      diffCache: new Map([
        [
          'workspace:workspace-branch-switch',
          { data: currentDiff, isLoading: false, hasFullDiff: true },
        ],
      ]),
    });

    const { result } = renderHook(() =>
      useDiffViewerState('/repo', false, 'workspace-branch-switch')
    );

    let switchPromise: Promise<void> | undefined;
    act(() => {
      switchPromise = result.current.setComparisonBranch('main', true);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.comparisonLoading).toBe(true);
    expect(result.current.comparisonBranch).toBeNull();
    expect(result.current.diffData).toEqual(currentDiff);

    await act(async () => {
      resolveBranchDiff?.(branchDiff);
      await switchPromise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.comparisonLoading).toBe(false);
    expect(result.current.comparisonBranch).toBe('main');
    expect(result.current.diffData).toEqual(branchDiff);
  });
});

describe('useFileEditorState reload from disk', () => {
  const readFile = vi.fn();

  beforeEach(() => {
    readFile.mockReset();
    window.api = { ...window.api, readFile } as typeof window.api;
  });

  function deferredRead(): (content: string) => Promise<void> {
    let resolve: (content: string) => void = () => {};
    readFile.mockReturnValueOnce(new Promise<string>((r) => (resolve = r)));
    return async (content) => {
      resolve(content);
      await Promise.resolve();
    };
  }

  async function openClean(content: string) {
    readFile.mockResolvedValueOnce(content);
    const hook = renderHook(() => useFileEditorState('/repo'));
    await act(() => hook.result.current.openFile('src/a.ts'));
    return hook;
  }

  it('keeps the editor showing while it rereads a file an agent changed', async () => {
    const { result } = await openClean('v1');
    const finishRead = deferredRead();

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFromDisk();
    });
    expect(result.current.loadingFile).toBe(false);

    await act(async () => {
      await finishRead('v2');
      await reload;
    });
    expect(result.current.fileContent).toBe('v2');
    expect(result.current.diskContent).toBe('v2');
    expect(result.current.isDirty).toBe(false);
  });

  it('keeps edits typed while the reread was in flight', async () => {
    const { result } = await openClean('v1');
    const finishRead = deferredRead();

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFromDisk();
    });
    act(() => {
      result.current.setFileContent('v1 typed');
      result.current.setIsDirty(true);
    });
    await act(async () => {
      await finishRead('v2');
      await reload;
    });

    expect(result.current.fileContent).toBe('v1 typed');
    expect(result.current.isDirty).toBe(true);
    expect(result.current.hasExternalChange).toBe(true);
  });

  it('discards edits when the buffer was already dirty, as Reload from disk asks', async () => {
    const { result } = await openClean('v1');
    act(() => {
      result.current.setFileContent('v1 typed');
      result.current.setIsDirty(true);
    });
    readFile.mockResolvedValueOnce('v2');

    await act(() => result.current.reloadFromDisk());

    expect(result.current.fileContent).toBe('v2');
    expect(result.current.isDirty).toBe(false);
  });
});

describe('useDiffViewerState split/unified preference', () => {
  const diff = {
    files: [
      { path: 'src/app.ts', status: 'modified', staged: false, additions: 2, deletions: 1 },
      { path: 'src/new.ts', status: 'added', staged: false, additions: 5, deletions: 0 },
    ],
    summary: { additions: 7, deletions: 1, filesChanged: 2 },
  };

  beforeEach(() => {
    useFileListStore.setState(useFileListStore.getInitialState(), true);
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    window.api = {
      ...window.api,
      getWorkspaceDiff: vi.fn().mockResolvedValue(diff),
      getWorkspaceFileDiffContent: vi.fn(async (_id: string, path: string) => ({
        path,
        oldContent: 'a',
        newContent: 'b',
        status: path === 'src/new.ts' ? 'added' : 'modified',
        isBinary: false,
      })),
    } as typeof window.api;
  });

  it('keeps the chosen layout when the diff loads and files are selected', async () => {
    useFileViewerStore.getState().setDiffViewMode('unified');
    const { result } = renderHook(() => useDiffViewerState('/repo', false, 'ws-layout'));

    await act(() => result.current.refresh());
    expect(result.current.selectedFile).toBe('src/app.ts');
    expect(result.current.viewMode).toBe('unified');

    await act(() => result.current.selectFileByPath('src/new.ts'));
    await act(() => result.current.selectFileByPath('src/app.ts'));

    expect(result.current.viewMode).toBe('unified');
    expect(useFileViewerStore.getState().diffViewMode).toBe('unified');
  });

  it('shows one-sided files unified without changing the chosen layout', async () => {
    const { result } = renderHook(() => useDiffViewerState('/repo', false, 'ws-one-sided'));
    await act(() => result.current.refresh());
    expect(result.current.viewMode).toBe('split');
    expect(result.current.splitViewAvailable).toBe(true);

    await act(() => result.current.selectFileByPath('src/new.ts'));
    expect(result.current.viewMode).toBe('unified');
    expect(result.current.splitViewAvailable).toBe(false);
    expect(useFileViewerStore.getState().diffViewMode).toBe('split');

    await act(() => result.current.selectFileByPath('src/app.ts'));
    expect(result.current.viewMode).toBe('split');
  });

  it('switches the layout for changes and history through the shared preference', () => {
    const { result } = renderHook(() => useDiffViewerState('/repo', false, 'ws-setter'));

    act(() => result.current.setViewMode('unified'));
    expect(result.current.viewMode).toBe('unified');
    expect(result.current.historyViewMode).toBe('unified');

    act(() => result.current.setHistoryViewMode('split'));
    expect(useFileViewerStore.getState().diffViewMode).toBe('split');
    expect(result.current.viewMode).toBe('split');
  });
});
