/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeNote,
  createNote,
  getNoteFileName,
  getNoteName,
  getNotePath,
} from '../../../src/renderer/lib/notes';
import { useFileViewerStore } from '../../../src/renderer/stores/file-viewer.store';
import { resetNotesStore, useNotesStore } from '../../../src/renderer/stores/notes.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../src/renderer/types';

const NOTE = {
  name: '2026-10-15-143210.md',
  title: '',
  path: '/home/me/.komla/notes/w1/2026-10-15-143210.md',
  modifiedMs: 1,
};

describe('note paths', () => {
  it('names notes apart from any workspace file', () => {
    const path = getNotePath(NOTE.name);
    expect(getNoteName(path)).toBe(NOTE.name);
    expect(getNoteName(NOTE.name)).toBeNull();
    expect(getNoteName('docs/note:x.md')).toBeNull();
    expect(getNoteName(null)).toBeNull();
    // A note path that reaches a file operation fails the main process's null byte check.
    expect(path).toContain('\0');
  });

  it.each([
    ['Fix the login bug', 'fix-the-login-bug.md'],
    ['  Café: «résumé» v2!  ', 'cafe-resume-v2.md'],
    ['', 'note.md'],
    ['🚀', 'note.md'],
    ['a'.repeat(100), `${'a'.repeat(60)}.md`],
  ])('saves %j as %j', (title, fileName) => {
    expect(getNoteFileName(title)).toBe(fileName);
  });
});

describe('createNote', () => {
  const createNoteApi = vi.fn();

  beforeEach(() => {
    resetNotesStore();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { createNote: createNoteApi, onNotesChanged: () => () => {} },
    });
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', projectId: 'p1' } as Workspace],
    });
    useFileViewerStore.setState({ fileViewerWorkspaceId: null, inlineFilePreviewByWorkspace: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
    useWorkspacesStore.setState({ workspaces: [] });
    useFileViewerStore.setState({ fileViewerWorkspaceId: null, inlineFilePreviewByWorkspace: {} });
  });

  it('starts a note for the project and opens it in the file panel', async () => {
    createNoteApi.mockResolvedValue(NOTE);

    await createNote('w1');

    expect(createNoteApi).toHaveBeenCalledWith('w1', undefined);
    expect(useNotesStore.getState().byScope.w1).toEqual([NOTE]);
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.w1).toMatchObject({
      open: true,
      mode: 'browse',
      filePath: getNotePath(NOTE.name),
    });
  });

  it('opens in the full-screen file viewer, over its file, while that is open', async () => {
    createNoteApi.mockResolvedValue(NOTE);
    useFileViewerStore.setState({ fileViewerWorkspaceId: 'w1' });

    await createNote('w1');

    const store = useFileViewerStore.getState();
    expect(store.fileViewerNoteName).toBe(NOTE.name);
    expect(store.fileViewerWorkspaceId).toBe('w1');
    expect(store.pendingFileViewerTransition).toBeNull();
  });

  it('writes what it starts with before it opens, as a prompt draft saved as a note', async () => {
    createNoteApi.mockResolvedValue(NOTE);

    expect(await createNote('w1', 'A plan to keep')).toBe(true);

    // Made with it, so it never takes over the workspace's blank note.
    expect(createNoteApi).toHaveBeenCalledWith('w1', 'A plan to keep');
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.w1?.filePath).toBe(
      getNotePath(NOTE.name)
    );
  });

  it('says why when it cannot make a note', async () => {
    createNoteApi.mockRejectedValue(new Error('disk full'));
    const addToast = vi.spyOn(useToastStore.getState(), 'addToast');

    expect(await createNote('w1', 'A plan to keep')).toBe(false);

    expect(addToast).toHaveBeenCalledWith("Couldn't create a note: disk full", 'error');
  });
});

describe('closeNote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useFileViewerStore.setState({ fileViewerWorkspaceId: null, fileViewerNoteName: null });
  });

  it("goes back to the full-screen file viewer's file, which stays open", () => {
    useFileViewerStore.setState({ fileViewerWorkspaceId: 'w1', fileViewerNoteName: NOTE.name });
    closeNote('w1');
    expect(useFileViewerStore.getState().fileViewerNoteName).toBeNull();
    expect(useFileViewerStore.getState().fileViewerWorkspaceId).toBe('w1');
  });

  it('closes the file panel showing it, asking about edits unless discarding', () => {
    const store = useFileViewerStore.getState();
    const requestClose = vi.spyOn(store, 'requestInlineFilePreviewClose');
    const close = vi.spyOn(store, 'closeInlineFilePreview');
    closeNote('w1');
    expect(requestClose).toHaveBeenCalledWith('w1');
    closeNote('w1', { discard: true });
    expect(close).toHaveBeenCalledWith('w1');
  });
});
