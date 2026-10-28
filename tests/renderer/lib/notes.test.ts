/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
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

    expect(createNoteApi).toHaveBeenCalledWith('w1');
    expect(useNotesStore.getState().byScope.w1).toEqual([NOTE]);
    expect(useFileViewerStore.getState().inlineFilePreviewByWorkspace.w1).toMatchObject({
      open: true,
      mode: 'browse',
      filePath: getNotePath(NOTE.name),
    });
  });

  it('leaves the full-screen file viewer for the file panel', async () => {
    createNoteApi.mockResolvedValue(NOTE);
    useFileViewerStore.setState({ fileViewerWorkspaceId: 'w1' });

    await createNote('w1');

    expect(useFileViewerStore.getState().pendingFileViewerTransition).toEqual({
      kind: 'inline-preview',
      workspaceId: 'w1',
      filePath: getNotePath(NOTE.name),
    });
  });

  it('says why when it cannot make a note', async () => {
    createNoteApi.mockRejectedValue(new Error('disk full'));
    const addToast = vi.spyOn(useToastStore.getState(), 'addToast');

    await createNote('w1');

    expect(addToast).toHaveBeenCalledWith("Couldn't create a note: disk full", 'error');
  });
});
