/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useFileWatcherSync } from '../../../../../src/renderer/components/workspaces/file-viewer/useFileWatcherSync';
import { useFileListStore } from '../../../../../src/renderer/stores/file-list.store';

import type {
  DiffViewerState,
  FileEditorState,
} from '../../../../../src/renderer/components/workspaces/file-viewer/useFileViewerState';

function makeEditor(overrides: Partial<FileEditorState> = {}): FileEditorState {
  return {
    filePath: 'src/app.ts',
    fileContent: 'before',
    diskContent: 'before',
    isDirty: false,
    hasExternalChange: false,
    missingOnDisk: false,
    loadingFile: false,
    error: null,
    language: 'typescript',
    isBrowserPreviewable: false,
    isUnsupportedBinary: false,
    isImage: false,
    imageData: null,
    imageMimeType: null,
    isMedia: false,
    mediaData: null,
    mediaMimeType: null,
    mediaKind: null,
    mediaSize: null,
    mediaPreviewLoading: false,
    mediaPreviewError: null,
    openFile: vi.fn(),
    loadMediaPreview: vi.fn(),
    reloadFromDisk: vi.fn(),
    setFileContent: vi.fn(),
    setDiskContent: vi.fn(),
    setIsDirty: vi.fn(),
    setExternalChange: vi.fn(),
    setMissingOnDisk: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

function makeDiff(): DiffViewerState {
  return {
    refresh: vi.fn(),
  } as unknown as DiffViewerState;
}

function setup(editor: FileEditorState, { isRemoteWorkspace = false } = {}) {
  let onWorktreeChanged: ((workspaceId: string, ...details: unknown[]) => Promise<void>) | null =
    null;
  const unsubscribe = vi.fn();
  const readFile = vi.fn();
  const readWorkspaceFile = vi.fn();
  const getFileMetadata = vi.fn();
  window.api = {
    onWorktreeChanged: vi.fn((callback) => {
      onWorktreeChanged = callback;
      return unsubscribe;
    }),
    readFile,
    readWorkspaceFile,
    getFileMetadata,
  } as unknown as typeof window.api;

  const diff = makeDiff();
  renderHook(() =>
    useFileWatcherSync({
      open: true,
      workspaceId: 'ws-1',
      workingDirectory: isRemoteWorkspace ? 'ssh://dev/home/dev/repo' : '/repo',
      isRemoteWorkspace,
      diff,
      editor,
    })
  );

  if (!onWorktreeChanged) throw new Error('watcher did not subscribe');
  return { onWorktreeChanged, readFile, readWorkspaceFile, getFileMetadata, diff };
}

describe('useFileWatcherSync', () => {
  it('marks a clean open file as missing when it is deleted on disk', async () => {
    const editor = makeEditor();
    const { onWorktreeChanged, readFile } = setup(editor);
    readFile.mockRejectedValue(new Error('ENOENT: no such file or directory, open src/app.ts'));

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(editor.setMissingOnDisk).toHaveBeenCalledWith(true);
    expect(editor.reloadFromDisk).not.toHaveBeenCalled();
    expect(editor.setExternalChange).not.toHaveBeenCalled();
  });

  it('preserves a dirty buffer and flags an external change when the file is deleted', async () => {
    const editor = makeEditor({ isDirty: true, fileContent: 'edited' });
    const { onWorktreeChanged, readFile } = setup(editor);
    readFile.mockRejectedValue(new Error('ENOENT: no such file or directory, open src/app.ts'));

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(editor.setMissingOnDisk).toHaveBeenCalledWith(true);
    expect(editor.setExternalChange).toHaveBeenCalledWith(true);
    expect(editor.reloadFromDisk).not.toHaveBeenCalled();
  });

  it('clears missing state once the file can be read again', async () => {
    const editor = makeEditor({ missingOnDisk: true });
    const { onWorktreeChanged, readFile } = setup(editor);
    readFile.mockResolvedValue('before');

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(editor.setMissingOnDisk).toHaveBeenCalledWith(false);
  });

  it('reloads a clean PDF when its metadata token changes', async () => {
    const editor = makeEditor({
      filePath: 'document.pdf',
      diskContent: '10:100',
      isBrowserPreviewable: true,
    });
    const { onWorktreeChanged, readFile, getFileMetadata } = setup(editor);
    getFileMetadata.mockResolvedValue({ size: 20, mtimeMs: 200 });

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(getFileMetadata).toHaveBeenCalledWith('/repo', 'document.pdf');
    expect(readFile).not.toHaveBeenCalled();
    expect(editor.reloadFromDisk).toHaveBeenCalledTimes(1);
  });

  it('marks a deleted HEIC file as missing without reading it as text', async () => {
    const editor = makeEditor({
      filePath: 'photo.heic',
      diskContent: '10:100',
      isUnsupportedBinary: true,
    });
    const { onWorktreeChanged, readFile, getFileMetadata } = setup(editor);
    getFileMetadata.mockRejectedValue(
      new Error('ENOENT: no such file or directory, stat photo.heic')
    );

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(editor.setMissingOnDisk).toHaveBeenCalledWith(true);
    expect(editor.reloadFromDisk).not.toHaveBeenCalled();
  });

  it('reloads a clean SSH file through the workspace API', async () => {
    const editor = makeEditor();
    const { onWorktreeChanged, readFile, readWorkspaceFile } = setup(editor, {
      isRemoteWorkspace: true,
    });
    readWorkspaceFile.mockResolvedValue('after');

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(readWorkspaceFile).toHaveBeenCalledWith('ws-1', 'src/app.ts');
    expect(readFile).not.toHaveBeenCalled();
    expect(editor.reloadFromDisk).toHaveBeenCalledTimes(1);
  });

  it('reloads an SSH PDF without reading it as text', async () => {
    const editor = makeEditor({ filePath: 'paper.pdf', fileContent: null, diskContent: 'v1' });
    const { onWorktreeChanged, readWorkspaceFile, getFileMetadata } = setup(editor, {
      isRemoteWorkspace: true,
    });

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(getFileMetadata).not.toHaveBeenCalled();
    expect(editor.reloadFromDisk).toHaveBeenCalledTimes(1);
  });

  describe('when the Remote Companion names the changed paths', () => {
    function listRemoteFiles(files: string[]): void {
      useFileListStore.setState({
        cache: new Map([
          [
            'ssh://dev/home/dev/repo',
            { files, gitIgnoredFiles: [], emptyDirs: [], isLoading: false },
          ],
        ]),
      });
    }

    it('skips reading an open SSH file the report leaves out', async () => {
      listRemoteFiles(['src/app.ts', 'README.md']);
      const editor = makeEditor();
      const { onWorktreeChanged, readWorkspaceFile, diff } = setup(editor, {
        isRemoteWorkspace: true,
      });

      await act(async () => {
        await onWorktreeChanged('ws-1', ['file'], 1, undefined, undefined, {
          changedPaths: ['README.md'],
        });
      });

      expect(readWorkspaceFile).not.toHaveBeenCalled();
      expect(diff.refresh).toHaveBeenCalledWith(['README.md']);
    });

    it.each([
      ['names its folder', ['src/app.ts'], ['src']],
      ['leaves out a file it does not watch', ['README.md'], ['README.md']],
    ])('reads an open SSH file when the report %s', async (_, listed, changedPaths) => {
      listRemoteFiles(listed);
      const editor = makeEditor();
      const { onWorktreeChanged, readWorkspaceFile } = setup(editor, { isRemoteWorkspace: true });
      readWorkspaceFile.mockResolvedValue('after');

      await act(async () => {
        await onWorktreeChanged('ws-1', ['file'], 1, undefined, undefined, { changedPaths });
      });

      expect(readWorkspaceFile).toHaveBeenCalledWith('ws-1', 'src/app.ts');
      expect(editor.reloadFromDisk).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps a dirty SSH buffer without a conflict when the file is unchanged', async () => {
    const editor = makeEditor({ isDirty: true, fileContent: 'edited' });
    const { onWorktreeChanged, readWorkspaceFile } = setup(editor, { isRemoteWorkspace: true });
    readWorkspaceFile.mockResolvedValue('before');

    await act(async () => {
      await onWorktreeChanged('ws-1');
    });

    expect(editor.setExternalChange).not.toHaveBeenCalled();
    expect(editor.reloadFromDisk).not.toHaveBeenCalled();
  });
});
