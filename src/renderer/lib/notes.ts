import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useNotes, useNotesStore } from '@/stores/notes.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

// A note opens in the file panel under a path no workspace file can have: the
// main process rejects paths with a null byte, so a note path that strays into
// a file operation fails instead of touching a file.
const NOTE_PATH_PREFIX = '\0note:';

export const UNTITLED_NOTE = 'Untitled note';

/** The file panel path a note opens under. */
export function getNotePath(name: string): string {
  return `${NOTE_PATH_PREFIX}${name}`;
}

/** The note a file panel path names, or null for a workspace file. */
export function getNoteName(path: string | null | undefined): string | null {
  return path?.startsWith(NOTE_PATH_PREFIX) ? path.slice(NOTE_PATH_PREFIX.length) : null;
}

/** The title of the note a file panel path names: null for a workspace file, '' while untitled. */
export function useNoteTitle(workspaceId: string | null, path: string | null): string | null {
  const name = getNoteName(path);
  const notes = useNotes(name ? workspaceId : null);
  if (!name) return null;
  return notes.find((note) => note.name === name)?.title ?? '';
}

/** A file name for saving a note into a project, from its title. */
export function getNoteFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'note'}.md`;
}

/**
 * Opens a note in the workspace's full-screen file viewer if it's open, over its file or diff,
 * or else in the file panel.
 */
export function openNote(workspaceId: string, name: string): void {
  const store = useFileViewerStore.getState();
  if (store.fileViewerWorkspaceId === workspaceId) store.showFileViewerNote(name);
  else store.requestInlineFilePreviewNav(workspaceId, 'browse', getNotePath(name));
}

/**
 * Closes the note open in the workspace's full-screen file viewer, going back to its file or
 * diff, or else the file panel showing it. `discard` closes the file panel without asking about
 * its unsaved edits, as for a note that was deleted.
 */
export function closeNote(workspaceId: string, { discard = false } = {}): void {
  const store = useFileViewerStore.getState();
  if (store.fileViewerWorkspaceId === workspaceId) store.showFileViewerNote(null);
  else if (discard) store.closeInlineFilePreview(workspaceId);
  else store.requestInlineFilePreviewClose(workspaceId);
}

/**
 * Starts a note in the workspace and opens it, without asking for a name, holding `content` if
 * given; returns whether it did.
 */
export async function createNote(workspaceId: string, content?: string): Promise<boolean> {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return false;
  try {
    const note = await useNotesStore.getState().create(workspace.id, content);
    // A collapsed section would hide the new note's row, so it wouldn't show where the note lives.
    const fileViewer = useFileViewerStore.getState();
    if (fileViewer.notesCollapsedByWorkspace[workspace.id]) {
      fileViewer.setNotesCollapsed(workspace.id, false);
    }
    openNote(workspace.id, note.name);
    return true;
  } catch (error) {
    useToastStore
      .getState()
      .addToast(
        `Couldn't create a note: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
    return false;
  }
}
