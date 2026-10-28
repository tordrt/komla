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

/** Opens a note in the workspace's file panel, leaving the full-screen file viewer if it's open. */
export function openNote(workspaceId: string, name: string): void {
  const store = useFileViewerStore.getState();
  const filePath = getNotePath(name);
  if (store.fileViewerWorkspaceId === workspaceId) {
    store.requestFileViewerTransition({ kind: 'inline-preview', workspaceId, filePath });
  } else {
    store.requestInlineFilePreviewNav(workspaceId, 'browse', filePath);
  }
}

/** Starts a note in the workspace and opens it, without asking for a name. */
export async function createNote(workspaceId: string): Promise<void> {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return;
  try {
    const note = await useNotesStore.getState().create(workspace.id);
    openNote(workspace.id, note.name);
  } catch (error) {
    useToastStore
      .getState()
      .addToast(
        `Couldn't create a note: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'error'
      );
  }
}
