/**
 * @vitest-environment jsdom
 */
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InlineFilePreviewPanel } from '../../../../src/renderer/components/terminal/InlineFilePreviewPanel';
import { getNotePath } from '../../../../src/renderer/lib/notes';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { usePaneSurfacesStore } from '../../../../src/renderer/stores/pane-surfaces.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

const WORKSPACE_ID = 'ws-preview';

const mocks = vi.hoisted(() => {
  const editorState = {
    filePath: 'src/app.ts',
    fileContent: 'content',
    diskContent: 'content',
    loadingFile: false,
    isBrowserPreviewable: false,
    isUnsupportedBinary: false,
    error: null,
    missingOnDisk: false,
    isDirty: false,
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
    setIsDirty: () => {},
    setDiskContent: () => {},
    setMissingOnDisk: () => {},
    setExternalChange: () => {},
    reloadFromDisk: () => Promise.resolve(),
    loadMediaPreview: () => Promise.resolve(),
    reset: () => {},
  };
  const diffState = {
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
    refresh: vi.fn(() => Promise.resolve()),
  };
  return {
    viewerState: { mode: 'browse', setMode: () => {}, editor: editorState, diff: diffState },
    contentAreaProps: null as Record<string, unknown> | null,
  };
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

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/notes/NoteEditor', () => ({
  NoteEditor: ({ name }: { name: string }) => <textarea aria-label={`Note ${name}`} />,
}));

vi.mock('../../../../src/renderer/components/workspaces/file-viewer/ContentArea', () => ({
  ContentArea: (props: Record<string, unknown>) => {
    mocks.contentAreaProps = props;
    return <textarea aria-label="Preview editor" />;
  },
}));

function isPreviewOpen() {
  return useFileViewerStore.getState().inlineFilePreviewByWorkspace[WORKSPACE_ID]?.open ?? false;
}

async function renderPanel({ workingDirectory = '/repo', isGitWorkspace = false } = {}) {
  const result = render(
    <>
      <input aria-label="Terminal find" />
      <div data-inline-file-preview-scope={WORKSPACE_ID}>
        <button type="button">Full</button>
      </div>
      <div data-inline-file-preview-scope={WORKSPACE_ID}>
        <button type="button">src/app.ts</button>
      </div>
      <div data-inline-file-preview-scope="ws-other">
        <button type="button">other/app.ts</button>
      </div>
      <InlineFilePreviewPanel
        workspaceId={WORKSPACE_ID}
        workingDirectory={workingDirectory}
        isGitWorkspace={isGitWorkspace}
      />
    </>
  );
  // Let the lazy Monaco init promise settle.
  await act(async () => {});
  return result;
}

describe('InlineFilePreviewPanel keyboard handling', () => {
  beforeEach(() => {
    mocks.contentAreaProps = null;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: 'linux',
        onWorktreeChanged: () => () => {},
        readFile: vi.fn().mockResolvedValue('content'),
        writeFile: vi.fn().mockResolvedValue(undefined),
        showItemInFolder: vi.fn(),
      },
    });
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [WORKSPACE_ID]: { open: true, mode: 'browse', filePath: null, layout: 'full' },
      },
    });
  });

  afterEach(() => {
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it('closes the preview on Escape from inside the panel', async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByLabelText('Preview editor'), { key: 'Escape' });

    expect(isPreviewOpen()).toBe(false);
  });

  it('closes the preview on Escape from the preview header', async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Full' }), { key: 'Escape' });

    expect(isPreviewOpen()).toBe(false);
  });

  it('closes the preview on Escape from the file tree beside it', async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByRole('button', { name: 'src/app.ts' }), { key: 'Escape' });

    expect(isPreviewOpen()).toBe(false);
  });

  it("keeps the preview open on Escape from another workspace's file tree", async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByRole('button', { name: 'other/app.ts' }), { key: 'Escape' });

    expect(isPreviewOpen()).toBe(true);
  });

  it('keeps the preview open on Escape that ends an IME composition', async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByLabelText('Preview editor'), {
      key: 'Escape',
      isComposing: true,
    });

    expect(isPreviewOpen()).toBe(true);
  });

  it('keeps the preview open on Escape from outside the panel', async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByLabelText('Terminal find'), { key: 'Escape' });

    expect(isPreviewOpen()).toBe(true);
  });

  it('keeps the preview open when another handler already consumed Escape', async () => {
    await renderPanel();
    const editor = screen.getByLabelText('Preview editor');
    const consume = (event: Event) => event.preventDefault();
    editor.addEventListener('keydown', consume);

    fireEvent.keyDown(editor, { key: 'Escape' });

    editor.removeEventListener('keydown', consume);
    expect(isPreviewOpen()).toBe(true);
  });

  async function mountEditorActions(options?: Parameters<typeof renderPanel>[0]) {
    await renderPanel(options);
    const addAction = vi.fn();
    const fakeEditor = {
      addAction,
      getAction: () => null,
      createContextKey: () => ({ set: () => {} }),
    };

    const onEditorMount = mocks.contentAreaProps?.onEditorMount as
      | ((ed: unknown) => void)
      | undefined;
    if (!onEditorMount) throw new Error('ContentArea was not rendered');
    act(() => onEditorMount(fakeEditor));

    return addAction.mock.calls.map(([action]) => action as { id: string; label: string });
  }

  it('labels the editor reveal action for the current platform', async () => {
    const actions = await mountEditorActions();

    const revealAction = actions.find((action) => action.id === 'reveal-in-finder');
    expect(revealAction?.label).toBe('Show in File Manager');
  });

  it('offers Add to .gitignore in a local git workspace', async () => {
    const actions = await mountEditorActions({ isGitWorkspace: true });

    expect(actions.map((action) => action.id)).toContain('add-to-gitignore');
  });

  it('omits local-only editor actions for an SSH workspace', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: WORKSPACE_ID,
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: { kind: 'ssh', hostId: 'ssh-dev' },
          terminals: [],
        } as never,
      ],
    });

    const actions = await mountEditorActions({
      workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      isGitWorkspace: true,
    });

    const actionIds = actions.map((action) => action.id);
    expect(actionIds).toContain('copy-at-path');
    expect(actionIds).not.toContain('reveal-in-finder');
    expect(actionIds).not.toContain('add-to-gitignore');
  });
});

describe('InlineFilePreviewPanel saving a Markdown file shown as rich text', () => {
  beforeEach(() => {
    mocks.contentAreaProps = null;
    mocks.viewerState.editor.filePath = 'PLAN.md';
    mocks.viewerState.editor.isDirty = true;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: 'linux',
        onWorktreeChanged: () => () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [WORKSPACE_ID]: { open: true, mode: 'browse', filePath: 'PLAN.md', layout: 'full' },
      },
    });
  });

  afterEach(() => {
    mocks.viewerState.editor.filePath = 'src/app.ts';
    mocks.viewerState.editor.fileContent = 'content';
    mocks.viewerState.editor.isDirty = false;
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  it('saves the rich editor, not the Monaco editor it replaced', async () => {
    await renderPanel();
    const props = mocks.contentAreaProps!;
    // A Monaco editor from Source mode, now unmounted: it reads as empty.
    act(() =>
      (props.onEditorMount as (editor: unknown) => void)({
        addAction: () => {},
        getAction: () => null,
        createContextKey: () => ({ set: () => {} }),
        getValue: () => '',
      })
    );
    act(() =>
      (props.onMarkdownEditorMount as (handle: unknown) => void)({
        getMarkdown: () => '# Plan\n\nEdited as rich text.\n',
        revealLine: () => {},
      })
    );

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Preview editor'), { key: 's', ctrlKey: true });
    });

    expect(window.api.writeFile).toHaveBeenCalledWith(
      '/repo',
      'PLAN.md',
      '# Plan\n\nEdited as rich text.\n'
    );
  });

  it.each([
    ['saves a mounted Monaco editor', { getModel: () => ({}) }, '# Plan\n'],
    // An HTML file's Browser view disposes the source editor; the last edit made there is kept.
    [
      'saves the last edits when a view switch disposed the Monaco editor',
      { getModel: () => null },
      '# Plan, as last edited\n',
    ],
  ])('%s', async (_name, model, saved) => {
    mocks.viewerState.editor.fileContent = '# Plan, as last edited\n';
    await renderPanel();
    act(() =>
      (mocks.contentAreaProps!.onEditorMount as (editor: unknown) => void)({
        addAction: () => {},
        getAction: () => null,
        createContextKey: () => ({ set: () => {} }),
        // A disposed editor reads as empty.
        getValue: () => (model.getModel() ? '# Plan\n' : ''),
        ...model,
      })
    );

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('Preview editor'), { key: 's', ctrlKey: true });
    });

    expect(window.api.writeFile).toHaveBeenCalledWith('/repo', 'PLAN.md', saved);
  });
});

describe('InlineFilePreviewPanel beside a file pane of the same file', () => {
  beforeEach(() => {
    mocks.contentAreaProps = null;
    mocks.viewerState.editor.filePath = 'PLAN.md';
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: 'linux',
        onWorktreeChanged: () => () => {},
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
    });
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [WORKSPACE_ID]: { open: true, mode: 'browse', filePath: 'PLAN.md', layout: 'full' },
      },
    });
  });

  afterEach(() => {
    mocks.viewerState.editor.filePath = 'src/app.ts';
    mocks.viewerState.editor.isDirty = false;
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
    usePaneSurfacesStore.setState({ surfaces: {} });
  });

  it('is read-only while the pane has unsaved edits to the file', async () => {
    usePaneSurfacesStore.setState({
      surfaces: {
        'surface:file:f1': {
          kind: 'file',
          workspaceId: WORKSPACE_ID,
          path: 'PLAN.md',
          dirty: true,
        },
      },
    });

    await renderPanel();

    expect(mocks.contentAreaProps!.readOnly).toBe(true);
  });

  it('leaves Cmd+S to the pane that claimed it', async () => {
    mocks.viewerState.editor.isDirty = true;
    await renderPanel();
    const editor = screen.getByLabelText('Preview editor');
    const event = createEvent.keyDown(editor, { key: 's', ctrlKey: true });
    event.preventDefault();

    await act(async () => {
      fireEvent(editor, event);
    });

    expect(window.api.writeFile).not.toHaveBeenCalled();
  });
});

describe('InlineFilePreviewPanel without preview state', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: 'linux', onWorktreeChanged: () => () => {} },
    });
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  // The panel stays mounted for workspaces that never opened a preview, and
  // zustand 5 re-renders forever if the selector builds a new default object.
  it('renders for a workspace that has never opened a preview', async () => {
    await expect(renderPanel()).resolves.toBeDefined();
  });
});

describe('InlineFilePreviewPanel missing diff file', () => {
  beforeEach(() => {
    mocks.contentAreaProps = null;
    mocks.viewerState.diff.refresh.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: 'linux', onWorktreeChanged: () => () => {} },
    });
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [WORKSPACE_ID]: { open: true, mode: 'diff', filePath: 'src/gone.ts', layout: 'full' },
      },
    });
  });

  afterEach(() => {
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  it('refreshes the changes instead of closing the preview', async () => {
    render(
      <InlineFilePreviewPanel workspaceId={WORKSPACE_ID} workingDirectory="/repo" isGitWorkspace />
    );
    await act(async () => {});

    const onRefreshMissingDiff = mocks.contentAreaProps?.onRefreshMissingDiff as
      | (() => void)
      | undefined;
    expect(onRefreshMissingDiff).toEqual(expect.any(Function));
    act(() => onRefreshMissingDiff?.());

    expect(mocks.viewerState.diff.refresh).toHaveBeenCalledTimes(1);
    expect(isPreviewOpen()).toBe(true);
  });
});

describe('InlineFilePreviewPanel diff layout', () => {
  beforeEach(() => {
    mocks.viewerState.mode = 'diff';
    mocks.viewerState.diff.grouped = {
      files: [{ path: 'src/app.ts', status: 'modified' }],
    } as never;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: 'linux', onWorktreeChanged: () => () => {} },
    });
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [WORKSPACE_ID]: { open: true, mode: 'diff', filePath: 'src/app.ts', layout: 'full' },
      },
    });
  });

  afterEach(() => {
    mocks.viewerState.mode = 'browse';
    mocks.viewerState.diff.grouped = { files: [] };
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  // The layout is saved for the full-screen viewer's Split/Unified toggle.
  it('opens a changed file without overwriting the saved layout', async () => {
    const setViewMode = vi.spyOn(mocks.viewerState.diff, 'setViewMode');
    const selectFileByPath = vi.spyOn(mocks.viewerState.diff, 'selectFileByPath');

    await renderPanel({ isGitWorkspace: true });

    expect(selectFileByPath).toHaveBeenCalled();
    expect(setViewMode).not.toHaveBeenCalled();
  });
});

describe('InlineFilePreviewPanel with a note', () => {
  const NOTE = '2026-10-15-143210.md';

  beforeEach(() => {
    mocks.contentAreaProps = null;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: 'linux', onWorktreeChanged: () => () => {}, readFile: vi.fn() },
    });
    useWorkspacesStore.setState({
      workspaces: [{ id: WORKSPACE_ID, projectId: 'p1', workingDirectory: '/repo' } as never],
    });
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [WORKSPACE_ID]: { open: true, mode: 'browse', filePath: getNotePath(NOTE), layout: 'full' },
      },
    });
  });

  afterEach(() => {
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it('shows the note instead of reading it as a workspace file', async () => {
    const reset = vi.spyOn(mocks.viewerState.editor, 'reset');
    const openFile = vi.spyOn(mocks.viewerState.editor, 'openFile');
    await renderPanel();

    expect(screen.getByLabelText(`Note ${NOTE}`)).toBeInTheDocument();
    expect(mocks.contentAreaProps).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    // The file the note replaced is let go.
    expect(reset).toHaveBeenCalled();
    expect(window.api.readFile).not.toHaveBeenCalled();
  });

  it('closes the note on Escape, like a file', async () => {
    await renderPanel();

    fireEvent.keyDown(screen.getByLabelText(`Note ${NOTE}`), { key: 'Escape' });

    expect(isPreviewOpen()).toBe(false);
  });
});
