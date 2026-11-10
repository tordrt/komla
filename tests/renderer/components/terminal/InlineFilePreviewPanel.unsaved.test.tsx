/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InlineFilePreviewPanel } from '../../../../src/renderer/components/terminal/InlineFilePreviewPanel';
import {
  getHtmlViewMode,
  setHtmlViewMode,
} from '../../../../src/renderer/components/workspaces/file-viewer/html-view-mode';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

const WS = 'ws-unsaved';
const DIR = '/repo-unsaved';

const mocks = vi.hoisted(() => {
  const editor = {
    filePath: 'a.ts',
    fileContent: 'edited',
    diskContent: 'content',
    loadingFile: false,
    isBrowserPreviewable: false,
    isUnsupportedBinary: false,
    error: null,
    missingOnDisk: false,
    isDirty: true,
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
    openFile: () => Promise.resolve(),
    setFileContent: () => {},
    setIsDirty: (_dirty: boolean) => {},
    setDiskContent: () => {},
    setMissingOnDisk: () => {},
    setExternalChange: () => {},
    reloadFromDisk: () => Promise.resolve(),
    loadMediaPreview: () => Promise.resolve(),
    reset: () => {},
  };
  const diff = {
    fileContent: null,
    grouped: { files: [] },
    selectedFile: null,
    viewMode: 'split',
    loading: false,
    loadingFile: false,
    fileError: null,
    forceLargeFile: false,
    largeFileBlock: null,
    hideUnchangedRegions: false,
    diffData: null,
    browserPreviewVersion: null,
    setViewMode: () => {},
    selectFileByPath: () => Promise.resolve(),
    retryFile: () => {},
    loadLargeFile: () => {},
    refresh: () => Promise.resolve(),
  };
  return { viewerState: { mode: 'browse', setMode: () => {}, editor, diff } };
});

vi.mock('../../../../src/renderer/lib/monaco-loader', () => ({
  ensureMonacoInitialized: () => Promise.resolve(),
}));

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/useFileViewerState', () => ({
  useFileViewerState: () => mocks.viewerState,
  getFileDiskToken: () => '',
  isMissingFileError: () => false,
  usesFileMetadata: () => false,
}));

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/ContentArea', () => ({
  ContentArea: () => <textarea aria-label="Preview editor" />,
}));

function preview() {
  return useFileViewerStore.getState().inlineFilePreviewByWorkspace[WS];
}

function treeMode() {
  return useFileViewerStore.getState().inlineFileTreeByWorkspace[WS]?.mode;
}

function prompt() {
  return screen.queryByRole('dialog', { name: 'Unsaved Changes' });
}

async function renderPanel() {
  const result = render(
    <InlineFilePreviewPanel workspaceId={WS} workingDirectory={DIR} isGitWorkspace />
  );
  await act(async () => {});
  return result;
}

describe('InlineFilePreviewPanel unsaved changes prompt', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: 'linux',
        onWorktreeChanged: () => () => {},
        readFile: vi.fn().mockResolvedValue('content'),
        updateWorkspace: vi.fn().mockResolvedValue(undefined),
      },
    });
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useFileViewerStore.setState({
      inlineFileTreeByWorkspace: { [WS]: { open: true, mode: 'diff' } },
      inlineFilePreviewByWorkspace: {
        [WS]: { open: true, mode: 'browse', filePath: 'a.ts', layout: 'full', isDirty: true },
      },
    });
    mocks.viewerState.editor.isDirty = true;
    setHtmlViewMode(DIR, 'source');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it('asks before switching files, without pointing the preview at the new file', async () => {
    await renderPanel();

    act(() => useFileViewerStore.getState().requestInlineFilePreviewNav(WS, 'browse', 'b.ts', 7));

    expect(prompt()).toHaveTextContent('Are you sure you want to switch files?');
    expect(preview()?.filePath).toBe('a.ts');
  });

  it('switches files once the edits are discarded', async () => {
    const setIsDirty = vi.spyOn(mocks.viewerState.editor, 'setIsDirty');
    const openFile = vi.spyOn(mocks.viewerState.editor, 'openFile');
    await renderPanel();
    act(() => useFileViewerStore.getState().requestInlineFilePreviewNav(WS, 'browse', 'b.ts', 7));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(prompt()).toBeNull();
    expect(setIsDirty).toHaveBeenCalledWith(false);
    expect(preview()).toMatchObject({ open: true, filePath: 'b.ts' });
    expect(openFile).toHaveBeenCalledWith('b.ts');
  });

  it('stays on the file when the prompt is cancelled, and asks again next time', async () => {
    await renderPanel();
    act(() => useFileViewerStore.getState().requestInlineFilePreviewNav(WS, 'browse', 'b.ts'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(prompt()).toBeNull();
    expect(preview()?.filePath).toBe('a.ts');
    act(() => useFileViewerStore.getState().requestInlineFilePreviewNav(WS, 'browse', 'b.ts'));
    expect(prompt()).not.toBeNull();
  });

  it('switches the tree to its files for a link only once the edits are discarded', async () => {
    await renderPanel();
    act(() =>
      useFileViewerStore
        .getState()
        .requestInlineFilePreviewNav(WS, 'browse', 'b.ts', undefined, { browseTree: true })
    );
    expect(treeMode()).toBe('diff');

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(treeMode()).toBe('browse');
    expect(preview()?.filePath).toBe('b.ts');
  });

  it('shows an HTML file in the browser only once the edits are discarded', async () => {
    await renderPanel();
    act(() =>
      useFileViewerStore
        .getState()
        .requestInlineFilePreviewNav(WS, 'browse', 'page.html', undefined, {
          htmlPreviewIntent: true,
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(getHtmlViewMode(DIR)).toBe('source');
    expect(treeMode()).toBe('diff');

    act(() =>
      useFileViewerStore
        .getState()
        .requestInlineFilePreviewNav(WS, 'browse', 'page.html', undefined, {
          htmlPreviewIntent: true,
        })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(getHtmlViewMode(DIR)).toBe('browser');
    expect(treeMode()).toBe('browse');
    expect(preview()?.filePath).toBe('page.html');
  });

  it('asks before switching view mode, and switches the tree and preview on Discard', async () => {
    await renderPanel();

    act(() => useFileViewerStore.getState().requestInlineFilePreviewModeChange(WS, 'diff'));
    expect(prompt()).toHaveTextContent('Are you sure you want to switch view mode?');
    expect(preview()?.mode).toBe('browse');
    expect(treeMode()).toBe('diff');
    act(() => useFileViewerStore.getState().setInlineFileTreeMode(WS, 'browse'));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(preview()?.mode).toBe('diff');
    expect(treeMode()).toBe('diff');
  });

  it('asks before a requested close, and closes and lets go of the file on Discard', async () => {
    const reset = vi.spyOn(mocks.viewerState.editor, 'reset');
    await renderPanel();

    act(() => useFileViewerStore.getState().requestInlineFilePreviewClose(WS));
    expect(prompt()).toHaveTextContent('Are you sure you want to close?');
    expect(preview()?.open).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(prompt()).toBeNull();
    expect(preview()?.open).toBe(false);
    expect(reset).toHaveBeenCalled();
  });

  it('asks before Escape closes it, and Escape on the prompt only dismisses the prompt', async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByLabelText('Preview editor'), { key: 'Escape' });
    expect(prompt()).toHaveTextContent('Are you sure you want to close?');

    fireEvent.keyDown(prompt()!, { key: 'Escape' });
    expect(prompt()).toBeNull();
    expect(preview()?.open).toBe(true);

    fireEvent.keyDown(screen.getByLabelText('Preview editor'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(preview()?.open).toBe(false);
  });

  it('acts on the latest request only', async () => {
    await renderPanel();
    act(() => useFileViewerStore.getState().requestInlineFilePreviewNav(WS, 'browse', 'b.ts'));

    act(() => useFileViewerStore.getState().requestInlineFilePreviewClose(WS));
    expect(prompt()).toHaveTextContent('Are you sure you want to close?');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(preview()).toMatchObject({ open: false, filePath: null });
  });

  it('drops the prompt when the preview closes under it, leaving the edits as they were', async () => {
    const setIsDirty = vi.spyOn(mocks.viewerState.editor, 'setIsDirty');
    await renderPanel();
    act(() => useFileViewerStore.getState().requestInlineFilePreviewNav(WS, 'browse', 'b.ts'));

    // As the file tree does for a file git now reports deleted.
    act(() => useFileViewerStore.getState().closeInlineFilePreview(WS));

    expect(prompt()).toBeNull();
    expect(setIsDirty).not.toHaveBeenCalledWith(false);
  });

  it('switches files directly when the preview is clean', async () => {
    mocks.viewerState.editor.isDirty = false;
    await renderPanel();

    act(() => useFileViewerStore.getState().requestInlineFilePreviewNav(WS, 'browse', 'b.ts'));

    expect(prompt()).toBeNull();
    expect(preview()?.filePath).toBe('b.ts');
  });
});
