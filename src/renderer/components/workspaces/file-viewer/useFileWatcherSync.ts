import { useEffect, useRef } from 'react';

import { useFileListStore } from '@/stores/file-list.store';

import { isMediaFile } from '../../../../shared/image-utils';

import { decideDiskReconcile, type DiskObservation } from './editor-buffer';
import { getFileDiskToken, isMissingFileError, usesFileMetadata } from './useFileViewerState';

import type { FileEditorState, DiffViewerState } from './useFileViewerState';

type DiffState = DiffViewerState;
type EditorState = FileEditorState;

interface DiskTarget {
  workspaceId: string;
  workingDirectory: string;
  isRemoteWorkspace: boolean;
}

/** Looks at the shown file on disk: its text, or its metadata for a file not read as text. */
async function observeDisk(
  filePath: string,
  { workspaceId, workingDirectory, isRemoteWorkspace }: DiskTarget
): Promise<DiskObservation> {
  // By its path, so a video that couldn't be shown isn't read whole as text either.
  const byMetadata = usesFileMetadata(filePath, isMediaFile(filePath));
  // SSH binaries have no metadata to compare and aren't text to read.
  if (isRemoteWorkspace && byMetadata) return { kind: 'unversioned' };
  try {
    const version = byMetadata
      ? getFileDiskToken(await window.api.getFileMetadata(workingDirectory, filePath))
      : isRemoteWorkspace
        ? await window.api.readWorkspaceFile(workspaceId, filePath)
        : await window.api.readFile(workingDirectory, filePath);
    return { kind: 'version', version };
  } catch (err) {
    return { kind: isMissingFileError(err) ? 'missing' : 'unreadable' };
  }
}

/**
 * Rereads the editor's file and takes the disk's text when the editor has no
 * unsaved edits, else flags the change. Nothing changes once `isCancelled` says so.
 */
export async function reconcileEditorWithDisk(
  editorState: EditorState,
  target: DiskTarget,
  isCancelled: () => boolean = () => false
): Promise<void> {
  if (!editorState.filePath) return;
  const observation = await observeDisk(editorState.filePath, target);
  if (isCancelled()) return;
  const decision = decideDiskReconcile(
    { diskVersion: editorState.diskContent, dirty: editorState.isDirty },
    observation
  );
  if (decision.missingOnDisk !== undefined) editorState.setMissingOnDisk(decision.missingOnDisk);
  if (decision.action === 'reload') void editorState.reloadFromDisk();
  if (decision.action === 'conflict') editorState.setExternalChange(true);
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
