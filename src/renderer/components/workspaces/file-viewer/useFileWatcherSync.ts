import { useEffect, useRef } from 'react';

import { useFileListStore } from '@/stores/file-list.store';

import { getFileDiskToken, isMissingFileError, usesFileMetadata } from './useFileViewerState';

import type { FileEditorState, DiffViewerState } from './useFileViewerState';

type DiffState = DiffViewerState;
type EditorState = FileEditorState;

/**
 * Rereads the editor's file and takes the disk's text when the editor has no
 * unsaved edits, else flags the change.
 */
export async function reconcileEditorWithDisk(
  editorState: EditorState,
  target: { workspaceId: string; workingDirectory: string; isRemoteWorkspace: boolean }
): Promise<void> {
  const { workspaceId, workingDirectory, isRemoteWorkspace } = target;
  if (!editorState.filePath) return;
  if (isRemoteWorkspace && usesFileMetadata(editorState.filePath, editorState.isMedia)) {
    // SSH binaries have no metadata to compare and aren't text to read, so load them again.
    void editorState.reloadFromDisk();
    return;
  }
  try {
    const currentDisk = usesFileMetadata(editorState.filePath, editorState.isMedia)
      ? getFileDiskToken(await window.api.getFileMetadata(workingDirectory, editorState.filePath))
      : isRemoteWorkspace
        ? await window.api.readWorkspaceFile(workspaceId, editorState.filePath)
        : await window.api.readFile(workingDirectory, editorState.filePath);
    editorState.setMissingOnDisk(false);
    if (currentDisk !== editorState.diskContent) {
      if (!editorState.isDirty) {
        void editorState.reloadFromDisk();
      } else {
        editorState.setExternalChange(true);
      }
    }
  } catch (err) {
    const missing = isMissingFileError(err);
    if (missing) {
      editorState.setMissingOnDisk(true);
    }
    // Preserve dirty buffers if disk state is unreadable or missing.
    if (editorState.isDirty) {
      editorState.setExternalChange(true);
    }
  }
}

/**
 * Subscribes to worktree file-change events while the dialog is open.
 * Refreshes the diff, if any, and reconciles editor disk content with smart conflict
 * detection (auto-reload when clean, flag external change when dirty).
 */
export function useFileWatcherSync(params: {
  open: boolean;
  workspaceId: string;
  workingDirectory: string;
  isRemoteWorkspace: boolean;
  diff?: DiffState;
  editor: EditorState;
}): void {
  const { open, workspaceId, workingDirectory, isRemoteWorkspace, diff, editor } = params;

  // Refs for watcher effect to avoid stale closures and unnecessary resubscribes
  const diffRefreshRef = useRef(diff?.refresh);
  diffRefreshRef.current = diff?.refresh;
  const editorStateRef = useRef(editor);
  editorStateRef.current = editor;

  useEffect(() => {
    if (!open) return;
    const unsubscribe = window.api.onWorktreeChanged(
      async (changedWorkspaceId, _changeTypes, _activityAt, _fileStatus, _gitStatus, change) => {
        if (changedWorkspaceId !== workspaceId) return;

        void diffRefreshRef.current?.(isRemoteWorkspace ? change?.changedPaths : undefined);

        const editorState = editorStateRef.current;
        if (!editorState.filePath) return;
        // An SSH read is a round trip, so skip files the Remote Companion says are unchanged.
        if (
          isRemoteWorkspace &&
          !useFileListStore
            .getState()
            .mayHaveChangedRemoteFile(workingDirectory, editorState.filePath, change)
        ) {
          return;
        }

        await reconcileEditorWithDisk(editorState, {
          workspaceId,
          workingDirectory,
          isRemoteWorkspace,
        });
      }
    );
    return unsubscribe;
  }, [open, workspaceId, workingDirectory, isRemoteWorkspace]);
}
