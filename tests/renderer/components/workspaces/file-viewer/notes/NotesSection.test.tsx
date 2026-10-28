/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotesSection } from '../../../../../../src/renderer/components/workspaces/file-viewer/notes/NotesSection';
import { getNotePath } from '../../../../../../src/renderer/lib/notes';
import { useFileViewerStore } from '../../../../../../src/renderer/stores/file-viewer.store';
import { resetNotesStore } from '../../../../../../src/renderer/stores/notes.store';

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

describe('NotesSection', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    resetNotesStore();
    api = {
      listNotes: vi.fn().mockResolvedValue([PROMPT, BLANK]),
      trashNote: vi.fn().mockResolvedValue(undefined),
      onNotesChanged: vi.fn(() => () => {}),
      copyToClipboard: vi.fn(),
      showItemInFolder: vi.fn(),
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...api, platform: 'linux' },
    });
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  afterEach(() => {
    useFileViewerStore.setState({ inlineFilePreviewByWorkspace: {} });
  });

  async function renderSection(currentFile: string | null = null) {
    const view = render(<NotesSection workspaceId="w1" currentFile={currentFile} />);
    await act(async () => {});
    return view;
  }

  it('lists the project’s notes', async () => {
    await renderSection();

    expect(api.listNotes).toHaveBeenCalledWith('w1');
    const rows = screen.getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Prompt for the login fixnow',
      'Untitled note1h',
    ]);
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
