import { useEffect, useRef } from 'react';

import { useFileViewerStore } from '@/stores/file-viewer.store';

import type { FileViewerMode } from './types';

/**
 * Apply the initial file target (from picker / inline panel) when the dialog
 * opens, jumping to a line number when supplied.
 */
export function useInitialFileTarget(params: {
  open: boolean;
  initialFilePath: string | null | undefined;
  initialLineNumber: number | undefined;
  mode: FileViewerMode;
  editorFilePath: string | null;
  workspaceId: string;
  jumpToLine: (line: number) => void;
  pendingLineJumpRef: { current: number | null };
  openTab: (workspaceId: string, path: string) => void;
  openFile: (path: string) => void | Promise<void>;
  selectInDiff: (path: string) => void;
}): void {
  const {
    open,
    initialFilePath,
    initialLineNumber,
    mode,
    editorFilePath,
    workspaceId,
    jumpToLine,
    pendingLineJumpRef,
    openTab,
    openFile,
    selectInDiff,
  } = params;
  const lastAppliedRef = useRef<string | null>(null);
  const selectInDiffRef = useRef(selectInDiff);
  selectInDiffRef.current = selectInDiff;

  useEffect(() => {
    if (!open) {
      lastAppliedRef.current = null;
      return;
    }
    if (!initialFilePath) return;

    const targetKey = `${mode}:${initialFilePath}:${initialLineNumber ?? ''}`;
    if (lastAppliedRef.current === targetKey) return;
    lastAppliedRef.current = targetKey;

    if (mode === 'browse') {
      if (editorFilePath === initialFilePath) {
        if (initialLineNumber) jumpToLine(initialLineNumber);
        return;
      }
      if (initialLineNumber) pendingLineJumpRef.current = initialLineNumber;
      openTab(workspaceId, initialFilePath);
      void openFile(initialFilePath);
    } else if (mode === 'diff') {
      selectInDiffRef.current(initialFilePath);
    }
  }, [
    open,
    initialFilePath,
    initialLineNumber,
    mode,
    editorFilePath,
    workspaceId,
    jumpToLine,
    pendingLineJumpRef,
    openTab,
    openFile,
  ]);
}

/**
 * Reacts to a close-tab request from the ShortcutProvider (pane-close intercepted at
 * the IPC level). When in browse mode with an open file, closes the active tab;
 * otherwise closes the dialog.
 */
export function useCloseTabRequest(params: {
  open: boolean;
  mode: FileViewerMode;
  editorFilePath: string | null;
  closeTabRef: { current: (path: string) => void };
  onOpenChange: (open: boolean) => void;
}): void {
  const { open, mode, editorFilePath, closeTabRef, onOpenChange } = params;
  const closeTabRequest = useFileViewerStore((s) => s.closeTabRequest);
  const prevRef = useRef(closeTabRequest);

  useEffect(() => {
    if (closeTabRequest === prevRef.current) return;
    prevRef.current = closeTabRequest;
    if (!open || mode !== 'browse') return;
    if (editorFilePath) {
      closeTabRef.current(editorFilePath);
    } else {
      onOpenChange(false);
    }
  }, [closeTabRequest, open, mode, editorFilePath, closeTabRef, onOpenChange]);
}

/**
 * Reacts to a close-viewer request (e.g. from the chrome's close button).
 * Defers to the parent's handleOpenChange so the unsaved-changes flow runs.
 */
export function useCloseViewerRequest(params: {
  open: boolean;
  handleOpenChange: (open: boolean) => void;
}): void {
  const { open, handleOpenChange } = params;
  const closeViewerRequest = useFileViewerStore((s) => s.closeViewerRequest);
  const prevRef = useRef(closeViewerRequest);

  useEffect(() => {
    if (closeViewerRequest === prevRef.current) return;
    prevRef.current = closeViewerRequest;
    if (open) handleOpenChange(false);
  }, [closeViewerRequest, open, handleOpenChange]);
}

/**
 * Resets transient dialog state when the dialog closes. The optional
 * `extraReset` callback runs alongside the built-in resets.
 */
export function useResetOnClose(params: {
  open: boolean;
  setIsMonacoReady: (v: boolean) => void;
  setMonacoLoadError: (v: string | null) => void;
  setFileToDelete: (v: null) => void;
  setFileToRestore: (v: null) => void;
  setCreateTarget: (v: null) => void;
  setUnsavedConfirmOpen: (v: boolean) => void;
  setCopiedPath: (v: string | null) => void;
  setCurrentChangeIndex: (v: number) => void;
  setTotalChanges: (v: number) => void;
  setConflictDialogOpen: (v: boolean) => void;
  pendingLineJumpRef: { current: number | null };
  diffBaselineRef: { current: string | null };
  extraReset?: () => void;
}): void {
  const {
    open,
    setIsMonacoReady,
    setMonacoLoadError,
    setFileToDelete,
    setFileToRestore,
    setCreateTarget,
    setUnsavedConfirmOpen,
    setCopiedPath,
    setCurrentChangeIndex,
    setTotalChanges,
    setConflictDialogOpen,
    pendingLineJumpRef,
    diffBaselineRef,
    extraReset,
  } = params;

  useEffect(() => {
    if (open) return;
    setIsMonacoReady(false);
    setMonacoLoadError(null);
    setFileToDelete(null);
    setFileToRestore(null);
    setCreateTarget(null);
    setUnsavedConfirmOpen(false);
    setCopiedPath(null);
    setCurrentChangeIndex(-1);
    setTotalChanges(0);
    setConflictDialogOpen(false);
    pendingLineJumpRef.current = null;
    diffBaselineRef.current = null;
    if (extraReset) extraReset();
  }, [
    open,
    setIsMonacoReady,
    setMonacoLoadError,
    setFileToDelete,
    setFileToRestore,
    setCreateTarget,
    setUnsavedConfirmOpen,
    setCopiedPath,
    setCurrentChangeIndex,
    setTotalChanges,
    setConflictDialogOpen,
    pendingLineJumpRef,
    diffBaselineRef,
    extraReset,
  ]);
}
