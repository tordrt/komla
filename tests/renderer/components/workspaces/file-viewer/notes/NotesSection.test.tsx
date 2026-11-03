/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotesSection } from '../../../../../../src/renderer/components/workspaces/file-viewer/notes/NotesSection';
import { createNote, getNotePath, openNote } from '../../../../../../src/renderer/lib/notes';
import { openPaneSurface } from '../../../../../../src/renderer/lib/pane-surfaces';
import { useFileViewerStore } from '../../../../../../src/renderer/stores/file-viewer.store';
import { useLayoutStore } from '../../../../../../src/renderer/stores/layout.store';
import { usePaneSurfacesStore } from '../../../../../../src/renderer/stores/pane-surfaces.store';
import { resetNotesStore } from '../../../../../../src/renderer/stores/notes.store';
import { useWorkspacesStore } from '../../../../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../../../../src/shared/types';

const PROMPT = {
  name: '2026-10-15-143210.md',
  title: 'Prompt for the login fix',
  path: '/home/me/.komla/notes/w1/2026-10-15-143210.md',
  modifiedMs: Date.now(),
};
const BLANK = {
  name: '2026-10-15-120000.md',
  title: '',
  path: '/home/me/.komla/notes/w1/2026-10-15-120000.md',
  modifiedMs: Date.now() - 3_600_000,
};
const NEW = {
  name: '2026-10-15-150000.md',
  title: 'Fresh idea',
  path: '/home/me/.komla/notes/w1/2026-10-15-150000.md',
  modifiedMs: Date.now(),
};

describe('NotesSection', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    resetNotesStore();
    api = {
      listNotes: vi.fn().mockResolvedValue([PROMPT, BLANK]),
      trashNote: vi.fn().mockResolvedValue(undefined),
      createNote: vi.fn().mockResolvedValue(NEW),
      onNotesChanged: vi.fn(() => () => {}),
      copyToClipboard: vi.fn(),
      showItemInFolder: vi.fn(),
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...api, platform: 'linux' },
    });
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
  });

  afterEach(() => {
    useFileViewerStore.setState(useFileViewerStore.getInitialState(), true);
    useWorkspacesStore.setState({ workspaces: [] });
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    usePaneSurfacesStore.setState({ surfaces: {} });
  });

  async function renderSection(currentFile: string | null = null, workspaceId = 'w1') {
    const view = render(<NotesSection workspaceId={workspaceId} currentFile={currentFile} />);
    await act(async () => {});
    return view;
  }

  const noteRow = () => screen.queryByRole('button', { name: /Prompt for the login fix/ });

  it('lists the project’s notes, with their count', async () => {
    await renderSection();

    expect(api.listNotes).toHaveBeenCalledWith('w1');
    expect(screen.getByRole('button', { name: 'Notes' })).toHaveTextContent('Notes2');
    const rows = within(screen.getByRole('list')).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Prompt for the login fixnow',
      'Untitled note1h',
    ]);
  });

  it('keeps its collapsed state per workspace, across remounts', async () => {
    const { unmount } = await renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(screen.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-expanded', 'false');
    expect(noteRow()).toBeNull();

    unmount();
    const { unmount: unmountAgain } = await renderSection();
    expect(noteRow()).toBeNull();

    unmountAgain();
    await renderSection(null, 'w2');
    expect(noteRow()).toBeInTheDocument();
  });

  it('expands to show a new note, but stays collapsed when one opens from elsewhere', async () => {
    useWorkspacesStore.setState({ workspaces: [{ id: 'w1' } as unknown as Workspace] });
    useFileViewerStore.getState().setNotesCollapsed('w1', true);
    await renderSection();

    act(() => openNote('w1', PROMPT.name));
    expect(noteRow()).toBeNull();

    await act(async () => createNote('w1'));

    expect(api.createNote).toHaveBeenCalledWith('w1');
    expect(screen.getByRole('button', { name: /Fresh idea/ })).toBeInTheDocument();
  });

  it('forgets its collapsed state with the workspace', () => {
    const store = useFileViewerStore.getState();
    store.setNotesCollapsed('w1', true);

    store.clearWorkspaceFileViewerState('w1');

    expect(useFileViewerStore.getState().notesCollapsedByWorkspace.w1).toBeUndefined();
  });

  it('takes no room while there are no notes', async () => {
    api.listNotes.mockResolvedValue([]);
    const { container } = await renderSection();

    expect(container).toBeEmptyDOMElement();
  });

  it('opens a note in the file panel, and closes it on a second click', async () => {
    const { rerender } = await renderSection();

    fireEvent.click(screen.getByRole('button', { name: /Prompt for the login fix/ }));
    const preview = () => useFileViewerStore.getState().inlineFilePreviewByWorkspace.w1;
    expect(preview()).toMatchObject({ open: true, filePath: getNotePath(PROMPT.name) });

    rerender(<NotesSection workspaceId="w1" currentFile={getNotePath(PROMPT.name)} />);
    const open = screen.getByRole('button', { name: /Prompt for the login fix/ });
    expect(open).toHaveAttribute('aria-current', 'true');
    fireEvent.click(open);
    expect(preview()?.open).toBe(false);
  });

  it('shows a note open in a pane there, instead of in the file panel', async () => {
    useLayoutStore.getState().setCurrentWorkspace('w1', 'term-1');
    const id = openPaneSurface(
      'w1',
      { kind: 'note', workspaceId: 'w1', name: PROMPT.name },
      { kind: 'tab' }
    );
    useLayoutStore.getState().showTabInFullPane('term-1');
    await renderSection();

    fireEvent.click(screen.getByRole('button', { name: /Prompt for the login fix/ }));

    expect(useLayoutStore.getState().activeTabByWorkspace.w1).toBe(id);
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.w1?.open).toBeFalsy();
  });

  it('copies a note’s path for pointing an agent at it', async () => {
    await renderSection();

    fireEvent.contextMenu(screen.getByRole('button', { name: /Prompt for the login fix/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Path' }));

    expect(api.copyToClipboard).toHaveBeenCalledWith(PROMPT.path);
  });

  it('moves a deleted note to the trash and closes it', async () => {
    useFileViewerStore.getState().openInlineFilePreview('w1', 'browse', getNotePath(PROMPT.name));
    await renderSection(getNotePath(PROMPT.name));

    fireEvent.contextMenu(screen.getByRole('button', { name: /Prompt for the login fix/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    });

    expect(api.trashNote).toHaveBeenCalledWith('w1', PROMPT.name);
    expect(screen.queryByRole('button', { name: /Prompt for the login fix/ })).toBeNull();
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.w1?.open).toBe(false);
  });
});
