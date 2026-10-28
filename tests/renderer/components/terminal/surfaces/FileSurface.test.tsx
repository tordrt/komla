/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileSurface } from '../../../../../src/renderer/components/terminal/surfaces/FileSurface';
import {
  getFilePaneDraft,
  openFilePane,
  setFilePaneDraft,
} from '../../../../../src/renderer/lib/pane-surfaces';
import { useFileViewerStore } from '../../../../../src/renderer/stores/file-viewer.store';
import { usePaneSurfacesStore } from '../../../../../src/renderer/stores/pane-surfaces.store';
import { useWorktreeEventsStore } from '../../../../../src/renderer/stores/worktree-events.store';
import { createWorkspace } from '../../../../factories';

import type { SurfaceHeader } from '../../../../../src/renderer/components/terminal/surfaces/surface-props';
import type { MarkdownEditorHandle } from '../../../../../src/renderer/components/workspaces/file-viewer/markdown/RichMarkdownEditor';

const mocks = vi.hoisted(() => ({
  onMarkdownEditorMount: null as ((handle: MarkdownEditorHandle | null) => void) | null,
  autoFocus: false,
}));

vi.mock('../../../../../src/renderer/lib/monaco-loader', () => ({
  ensureMonacoInitialized: () => Promise.resolve(),
}));
// The file shows in a plain text box in place of Monaco.
vi.mock('../../../../../src/renderer/components/workspaces/file-viewer/ContentArea', () => ({
  ContentArea: (props: {
    fileContent: string | null;
    readOnly?: boolean;
    onChange?: (content: string) => void;
    onMarkdownEditorMount?: (handle: MarkdownEditorHandle | null) => void;
    autoFocus?: boolean;
  }) => {
    mocks.onMarkdownEditorMount = props.onMarkdownEditorMount ?? null;
    mocks.autoFocus = !!props.autoFocus;
    return props.fileContent === null ? null : (
      <textarea
        aria-label="File text"
        value={props.fileContent}
        readOnly={props.readOnly}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    );
  },
}));
vi.mock('../../../../../src/renderer/components/ui/icon-button', () => ({
  IconButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{label}</button>
  ),
}));

const WORKSPACE_ID = 'ws-1';
const SURFACE_ID = 'surface:file:f1';
const OTHER_SURFACE_ID = 'surface:file:f2';
const PATH = 'src/app.ts';

const header: SurfaceHeader = (title, options = {}) => (
  <div>
    {title}
    {options.actions}
  </div>
);

const writeFile = vi.fn();
const readFile = vi.fn();
const readWorkspaceFile = vi.fn();
const worktreeListeners = new Set<(workspaceId: string) => void>();

function renderFile({
  surfaceId = SURFACE_ID,
  isTabActive = true,
}: { surfaceId?: string; isTabActive?: boolean } = {}) {
  return render(
    <FileSurface
      surfaceId={surfaceId}
      workspace={createWorkspace({ id: WORKSPACE_ID, workingDirectory: '/repo' })}
      isTabActive={isTabActive}
      isFocused
      header={header}
      onClose={vi.fn()}
      path={PATH}
    />
  );
}

/** An agent rewrites the file on disk. */
async function writeOnDisk(text: string) {
  readFile.mockResolvedValue(text);
  readWorkspaceFile.mockResolvedValue(text);
  await act(async () => {
    for (const listener of worktreeListeners) listener(WORKSPACE_ID);
  });
}

async function fileText(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('File text')) as HTMLTextAreaElement;
}

beforeEach(() => {
  writeFile.mockReset().mockResolvedValue(undefined);
  readFile.mockReset().mockResolvedValue('on disk');
  readWorkspaceFile.mockReset().mockResolvedValue('on disk');
  worktreeListeners.clear();
  useWorktreeEventsStore.setState({ lastEventByWorkspace: {} });
  Object.assign(window, {
    api: {
      readFile,
      readWorkspaceFile,
      writeFile,
      onWorktreeChanged: vi.fn((listener: (workspaceId: string) => void) => {
        worktreeListeners.add(listener);
        return () => worktreeListeners.delete(listener);
      }),
    },
  });
  usePaneSurfacesStore.setState({
    surfaces: {
      [SURFACE_ID]: { kind: 'file', workspaceId: WORKSPACE_ID, path: PATH },
      [OTHER_SURFACE_ID]: { kind: 'file', workspaceId: WORKSPACE_ID, path: PATH },
    },
  });
  useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
});

afterEach(() => {
  setFilePaneDraft(SURFACE_ID, null);
  setFilePaneDraft(OTHER_SURFACE_ID, null);
});

describe('FileSurface', () => {
  it('keeps edits as unsaved until Cmd+S writes them', async () => {
    renderFile();
    const text = await fileText();
    expect(text.value).toBe('on disk');
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();

    fireEvent.change(text, { target: { value: 'edited' } });

    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
    expect(getFilePaneDraft(SURFACE_ID)).toBe('edited');

    // Claimed, so the file panel's own Cmd+S doesn't save too.
    expect(fireEvent.keyDown(text, { key: 's', ctrlKey: true })).toBe(false);

    await waitFor(() => expect(screen.queryByLabelText('Unsaved changes')).toBeNull());
    expect(writeFile).toHaveBeenCalledWith('/repo', PATH, 'edited');
    expect(getFilePaneDraft(SURFACE_ID)).toBeUndefined();
  });

  it('keeps the edits unsaved when the write fails', async () => {
    writeFile.mockRejectedValue(new Error('disk full'));
    renderFile();
    const text = await fileText();
    fireEvent.change(text, { target: { value: 'edited' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writeFile).toHaveBeenCalled());
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
    expect(getFilePaneDraft(SURFACE_ID)).toBe('edited');
  });

  it('shows the unsaved text again when the pane remounts', async () => {
    setFilePaneDraft(SURFACE_ID, 'edited');

    renderFile();

    await waitFor(async () => expect((await fileText()).value).toBe('edited'));
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
  });

  it('is read-only while another pane has unsaved edits to the file', async () => {
    renderFile();
    const text = await fileText();
    expect(text.readOnly).toBe(false);

    setFilePaneDraft(OTHER_SURFACE_ID, 'edited elsewhere');

    await waitFor(() => expect(text.readOnly).toBe(true));
    expect(screen.getByText('Read-only')).toBeInTheDocument();

    setFilePaneDraft(OTHER_SURFACE_ID, null);
    await waitFor(() => expect(text.readOnly).toBe(false));
  });

  it('is read-only while the file panel has unsaved edits to the file', async () => {
    useFileViewerStore.setState({
      inlineFilePreviewByWorkspace: {
        [WORKSPACE_ID]: {
          open: true,
          mode: 'browse',
          filePath: PATH,
          layout: 'full',
          isDirty: true,
        },
      },
    });

    renderFile();

    expect((await fileText()).readOnly).toBe(true);
  });

  it('warns of a change on disk while editing, and asks before saving over it', async () => {
    renderFile();
    fireEvent.change(await fileText(), { target: { value: 'edited' } });

    await writeOnDisk('agent wrote');

    expect(screen.getByText('Changed on disk while you were editing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('app.ts changed on disk while you were editing');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writeFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Overwrite' })
    );

    await waitFor(() => expect(writeFile).toHaveBeenCalledWith('/repo', PATH, 'edited'));
    await waitFor(() =>
      expect(screen.queryByText('Changed on disk while you were editing')).toBeNull()
    );
  });

  it('saves over a change on disk without asking once the edits are kept', async () => {
    renderFile();
    fireEvent.change(await fileText(), { target: { value: 'edited' } });
    await writeOnDisk('agent wrote');

    fireEvent.click(screen.getByRole('button', { name: 'Keep My Changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(writeFile).toHaveBeenCalledWith('/repo', PATH, 'edited'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('drops the edits for the text on disk', async () => {
    renderFile();
    fireEvent.change(await fileText(), { target: { value: 'edited' } });
    await writeOnDisk('agent wrote');

    fireEvent.click(screen.getByRole('button', { name: 'Reload from Disk' }));

    await waitFor(async () => expect((await fileText()).value).toBe('agent wrote'));
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(getFilePaneDraft(SURFACE_ID)).toBeUndefined();
  });

  it('watches only while its tab shows, and rereads a file changed meanwhile', async () => {
    const { rerender } = renderFile({ isTabActive: false });
    await fileText();
    expect(worktreeListeners.size).toBe(0);

    readFile.mockResolvedValue('agent wrote');
    readWorkspaceFile.mockResolvedValue('agent wrote');
    useWorktreeEventsStore.setState({ lastEventByWorkspace: { [WORKSPACE_ID]: 5 } });
    rerender(
      <FileSurface
        surfaceId={SURFACE_ID}
        workspace={createWorkspace({ id: WORKSPACE_ID, workingDirectory: '/repo' })}
        isTabActive
        isFocused
        header={header}
        onClose={vi.fn()}
        path={PATH}
      />
    );

    await waitFor(async () => expect((await fileText()).value).toBe('agent wrote'));
    expect(worktreeListeners.size).toBe(1);
  });

  it('opens the file full screen', async () => {
    const requestFileViewerTransition = vi.fn();
    useFileViewerStore.setState({ requestFileViewerTransition });
    renderFile();
    await fileText();

    fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }));

    expect(requestFileViewerTransition).toHaveBeenCalledWith({
      kind: 'mode',
      workspaceId: WORKSPACE_ID,
      mode: 'browse',
      after: { kind: 'browse-file', filePath: PATH },
    });
  });

  it('takes focus when it opens and has the rich editor take it, once', async () => {
    const id = openFilePane(WORKSPACE_ID, 'PLAN.md', { kind: 'tab' });

    const { unmount } = renderFile({ surfaceId: id });
    await fileText();
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
    expect(mocks.autoFocus).toBe(true);

    unmount();
    renderFile({ surfaceId: id });
    await fileText();
    expect(mocks.autoFocus).toBe(false);
  });

  it('shows the line it opened at in the rich editor instead', async () => {
    const id = openFilePane(WORKSPACE_ID, 'PLAN.md', { kind: 'tab' }, 7);
    const handle = { getMarkdown: () => '', revealLine: vi.fn() };

    renderFile({ surfaceId: id });
    await fileText();
    act(() => mocks.onMarkdownEditorMount?.(handle));

    expect(mocks.autoFocus).toBe(false);
    expect(handle.revealLine).toHaveBeenCalledWith(7);
  });
});
