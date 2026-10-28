import { useEffect, useCallback, useState, useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ensureMonacoInitialized } from '@/lib/monaco-loader';
import { getNoteName } from '@/lib/notes';
import { hasUnsavedFilePane } from '@/lib/pane-surfaces';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { cn } from '@/lib/utils';
import { findRenameSource, useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { useWorktreeEventsStore } from '@/stores/worktree-events.store';

import { ContentArea } from '../workspaces/file-viewer/ContentArea';
import {
  COPY_AT_PATH_KEYBINDING,
  formatAtPathWithLine,
  getFlatFileKeys,
  getNextChangeAction,
  getPrevChangeAction,
  readMountedEditor,
  removeNonFunctionalActions,
} from '../workspaces/file-viewer/file-viewer-utils';
import { setHtmlViewMode } from '../workspaces/file-viewer/html-view-mode';
import { NoteEditor } from '../workspaces/file-viewer/notes/NoteEditor';
import {
  getFileDiskToken,
  isMissingFileError,
  usesFileMetadata,
  useFileViewerState,
} from '../workspaces/file-viewer/useFileViewerState';

import {
  getNextSeenWorktreeEventAt,
  shouldOfferDiffBrowserPreview,
  shouldRefreshBrowsePreviewOnReactivate,
} from './inline-file-preview-state';

import type { MarkdownEditorHandle } from '../workspaces/file-viewer/markdown/RichMarkdownEditor';
import type { editor as monacoEditor } from 'monaco-editor';

type InlineFilePreviewState = ReturnType<
  typeof useFileViewerStore.getState
>['inlineFilePreviewByWorkspace'][string];

// Shared so the store selector returns a stable value for workspaces that
// have never opened a preview.
const CLOSED_INLINE_FILE_PREVIEW: InlineFilePreviewState = {
  open: false,
  mode: 'browse',
  filePath: null,
  layout: 'full',
};

// The preview header and the file tree that opens files in it are rendered by
// TerminalTabs, outside this panel's DOM. They carry their workspace's id.
function isInlineFilePreviewTarget(
  target: EventTarget | null,
  panel: HTMLElement | null,
  workspaceId: string
) {
  if (!(target instanceof Element)) return false;
  if (panel?.contains(target)) return true;
  const scope = target.closest('[data-inline-file-preview-scope]');
  return scope?.getAttribute('data-inline-file-preview-scope') === workspaceId;
}

interface InlineFilePreviewPanelProps {
  workspaceId: string;
  workingDirectory: string;
  isGitWorkspace: boolean;
  isActive?: boolean;
  onCloseRef?: { current: (() => void) | null };
  changeNavRef?: { current: { goToNext: () => void; goToPrev: () => void } | null };
  onTotalChangesChange?: (totalChanges: number) => void;
}

export function InlineFilePreviewPanel({
  workspaceId,
  workingDirectory,
  isGitWorkspace,
  isActive = true,
  onCloseRef,
  changeNavRef,
  onTotalChangesChange,
}: InlineFilePreviewPanelProps) {
  const previewState = useFileViewerStore(
    (s) => s.inlineFilePreviewByWorkspace[workspaceId] ?? CLOSED_INLINE_FILE_PREVIEW
  );
  const pendingNav = useFileViewerStore(
    (s) => s.inlineFilePreviewPendingNavByWorkspace[workspaceId] ?? null
  );
  const pendingCloseFromStore = useFileViewerStore(
    (s) => !!s.inlineFilePreviewPendingCloseByWorkspace[workspaceId]
  );
  const pendingModeChange = useFileViewerStore(
    (s) => s.inlineFilePreviewPendingModeChangeByWorkspace[workspaceId] ?? null
  );
  const closeInlineFilePreview = useFileViewerStore((s) => s.closeInlineFilePreview);
  const requestFileViewerTransition = useFileViewerStore((s) => s.requestFileViewerTransition);
  const openInlineFilePreview = useFileViewerStore((s) => s.openInlineFilePreview);
  const requestInlineFilePreviewNav = useFileViewerStore((s) => s.requestInlineFilePreviewNav);
  const setInlineFileTreeMode = useFileViewerStore((s) => s.setInlineFileTreeMode);
  const setInlineFilePreviewMode = useFileViewerStore((s) => s.setInlineFilePreviewMode);
  const clearAllInlineFilePreviewPendingDiscardSlots = useFileViewerStore(
    (s) => s.clearAllInlineFilePreviewPendingDiscardSlots
  );
  const setInlineFilePreviewDirty = useFileViewerStore((s) => s.setInlineFilePreviewDirty);
  const lastWorktreeEventAt = useWorktreeEventsStore(
    (s) => s.lastEventByWorkspace[workspaceId] ?? 0
  );
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const isRemoteWorkspace = workspace?.backend?.kind === 'ssh';
  // A note isn't a workspace file; its editor reads and saves it.
  const noteName = previewState.open ? getNoteName(previewState.filePath) : null;

  const state = useFileViewerState(
    workingDirectory,
    previewState.open,
    isGitWorkspace ? previewState.mode : 'browse',
    workspaceId,
    isGitWorkspace,
    undefined,
    isActive,
    'inline'
  );
  const { mode, setMode, editor, diff } = state;
  const [isMonacoReady, setIsMonacoReady] = useState(false);
  const [monacoLoadError, setMonacoLoadError] = useState<string | null>(null);
  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const [totalChanges, setTotalChanges] = useState(0);
  const [currentChangeIndex, setCurrentChangeIndex] = useState(-1);
  const currentChangeIndexRef = useRef(-1);
  currentChangeIndexRef.current = currentChangeIndex;
  const pendingChangeTargetRef = useRef<'first' | 'last' | null>(null);
  const pendingLineJumpRef = useRef<number | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  // Editor refs for saving
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  // Set while a Markdown file shows as rich text, which then holds the buffer instead of Monaco.
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const diffEditorRef = useRef<monacoEditor.IStandaloneDiffEditor | null>(null);
  const justSavedRef = useRef(false);
  const saveFileRef = useRef<() => void | Promise<void>>(() => {});

  // Track baseline content for diff editor to distinguish user edits from file loads
  const diffBaselineRef = useRef<string | null>(null);
  const prevNewContentRef = useRef<string | null | undefined>(undefined);
  const currentNewContent = diff.fileContent?.newContent ?? null;
  if (currentNewContent !== prevNewContentRef.current) {
    prevNewContentRef.current = currentNewContent;
    diffBaselineRef.current = currentNewContent;
  }

  // Lazy-load Monaco only when inline preview is open AND the workspace is active.
  // Inactive workspaces preserve their open state but skip expensive initialization.
  useEffect(() => {
    if (!previewState.open || !isActive) {
      // Only reset Monaco state when preview is closed — not when merely inactive,
      // so re-activation can pick up where it left off without a flash.
      if (!previewState.open) {
        setIsMonacoReady(false);
        setMonacoLoadError(null);
      }
      return;
    }

    let cancelled = false;
    setMonacoLoadError(null);
    setIsMonacoReady(false);

    void ensureMonacoInitialized()
      .then(() => {
        if (!cancelled) setIsMonacoReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : 'Unknown Monaco initialization error';
        setMonacoLoadError(`Failed to initialize editor: ${message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [previewState.open, isActive]);

  // Keep internal mode aligned with store mode
  useEffect(() => {
    if (!previewState.open) return;
    if (!isGitWorkspace && previewState.mode === 'diff') {
      useFileViewerStore.getState().setInlineFilePreviewMode(workspaceId, 'browse');
      return;
    }
    if (mode !== previewState.mode) {
      setMode(previewState.mode);
    }
  }, [previewState.open, previewState.mode, mode, setMode, isGitWorkspace, workspaceId]);

  // Open the selected file in browse/diff mode.
  // Gated on isActive to avoid IPC/disk reads for inactive workspaces.
  // Dirty-check guarding lives in the file tree's click path (via the
  // store's requestInlineFilePreviewNav), so by the time previewState
  // points at a new filePath the navigation has already been confirmed.
  useEffect(() => {
    if (!previewState.open || !previewState.filePath || !isActive) return;
    if (noteName) {
      // Let go of the file the note replaced.
      if (editor.filePath) editor.reset();
      return;
    }
    // Wait for internal mode to sync with store mode to avoid opening
    // a file in the wrong mode (e.g., calling editor.openFile for a deleted
    // file when transitioning from browse to diff mode)
    if (mode !== previewState.mode) return;

    if (mode === 'browse') {
      if (editor.filePath !== previewState.filePath) {
        if (previewState.lineNumber) {
          pendingLineJumpRef.current = previewState.lineNumber;
          useFileViewerStore.getState().clearInlineFilePreviewLineNumber(workspaceId);
        }
        void editor.openFile(previewState.filePath);
      } else if (previewState.lineNumber && markdownEditorRef.current) {
        markdownEditorRef.current.revealLine(previewState.lineNumber);
        useFileViewerStore.getState().clearInlineFilePreviewLineNumber(workspaceId);
      } else if (previewState.lineNumber && editorRef.current) {
        editorRef.current.revealLineInCenter(previewState.lineNumber);
        editorRef.current.setPosition({ lineNumber: previewState.lineNumber, column: 1 });
        editorRef.current.focus();
        useFileViewerStore.getState().clearInlineFilePreviewLineNumber(workspaceId);
      }
      return;
    }

    const file = diff.grouped.files.find((f) => f.path === previewState.filePath);
    if (!file) return;

    const fileKey = file.path;
    if (diff.selectedFile !== fileKey) {
      void diff.selectFileByPath(fileKey);
    }
  }, [
    isActive,
    previewState.open,
    previewState.filePath,
    previewState.lineNumber,
    previewState.mode,
    mode,
    editor,
    editor.filePath,
    editor.isDirty,
    editor.openFile,
    diff,
    diff.diffData,
    diff.selectedFile,
    diff.selectFileByPath,
    workspaceId,
    noteName,
  ]);

  // Browse mode editor change handler. Comparing to diskContent avoids
  // false dirty state from spurious Monaco onChange events (EOL
  // normalization, programmatic value sync, vim-mode attach).
  const handleEditorChange = useCallback(
    (content: string) => {
      editor.setFileContent(content);
      editor.setIsDirty(content !== editor.diskContent);
    },
    [editor]
  );

  // Keep a ref to the current display path so Monaco actions always see the latest value
  const currentFilePath =
    mode === 'diff' && diff.selectedFile ? diff.selectedFile : editor.filePath;
  const currentFilePathRef = useRef(currentFilePath);
  currentFilePathRef.current = currentFilePath;
  // A file pane with unsaved edits to the file keeps this copy from editing it too.
  const editedInFilePane = usePaneSurfacesStore((s) =>
    hasUnsavedFilePane(s.surfaces, workspaceId, currentFilePath)
  );

  // Register "File History" context menu action – opens the full file viewer in history mode
  const registerFileHistoryAction = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor) => {
      if (!isGitWorkspace) return;
      ed.addAction({
        id: 'show-file-history',
        label: 'File History',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 2,
        keybindings: [],
        run: () => {
          const filePath = currentFilePathRef.current;
          if (filePath) {
            requestFileViewerTransition({
              kind: 'mode',
              workspaceId,
              mode: 'diff',
              diffSubMode: 'history',
              after: { kind: 'history-file', filePath },
            });
          }
        },
      });
    },
    [isGitWorkspace, requestFileViewerTransition, workspaceId]
  );

  const registerOpenWithBlameAction = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor) => {
      if (!isGitWorkspace || isRemoteWorkspace) return;
      ed.addAction({
        id: 'open-with-blame',
        label: 'Open with Blame',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 1,
        keybindings: [],
        run: () => {
          const filePath = currentFilePathRef.current;
          if (!filePath) return;
          requestFileViewerTransition({
            kind: 'mode',
            workspaceId,
            mode: 'browse',
            after: { kind: 'browse-file', filePath, enableBlame: true },
          });
        },
      });
    },
    [isGitWorkspace, isRemoteWorkspace, requestFileViewerTransition, workspaceId]
  );

  const registerRollbackAction = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor) => {
      if (!isGitWorkspace) return;
      ed.addAction({
        id: 'rollback-file',
        label: 'Rollback',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 3,
        keybindings: [],
        run: async () => {
          const filePath = currentFilePathRef.current;
          if (!filePath) return;
          const statuses = useFileListStore.getState().getFileStatuses(workingDirectory);
          const status = statuses?.statuses.get(filePath);
          if (!status) return;
          const actionLabel =
            status === 'deleted'
              ? 'restore'
              : status === 'untracked' || status === 'added'
                ? 'remove'
                : 'rollback';
          if (!window.confirm(`Are you sure you want to ${actionLabel} "${filePath}"?`)) return;
          const oldPath = findRenameSource(workingDirectory, filePath, workspaceId);
          try {
            if (isRemoteWorkspace) {
              await window.api.restoreWorkspaceFile(workspaceId, filePath, status, oldPath);
            } else {
              await window.api.restoreFile(workingDirectory, filePath, status, oldPath);
            }
            const successLabel =
              status === 'deleted'
                ? 'Restored'
                : status === 'untracked' || status === 'added'
                  ? 'Removed'
                  : 'Rolled back';
            useToastStore.getState().addToast(`${successLabel} ${filePath}`, 'success');
            const store = useFileListStore.getState();
            const refreshes: Promise<unknown>[] = [
              store.fetchDiff(workingDirectory, undefined, undefined, workspaceId),
              store.fetchFileList(workingDirectory, false, workspaceId),
            ];
            if (!isRemoteWorkspace) refreshes.push(store.fetchFileStatuses(workingDirectory));
            await Promise.all(refreshes);
          } catch (err) {
            useToastStore
              .getState()
              .addToast(
                `Failed to rollback: ${err instanceof Error ? err.message : 'Unknown error'}`,
                'error'
              );
          }
        },
      });
    },
    [isGitWorkspace, isRemoteWorkspace, workingDirectory, workspaceId]
  );

  const registerRevealInFinderAction = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor) => {
      if (isRemoteWorkspace) return;
      ed.addAction({
        id: 'reveal-in-finder',
        label: getRevealInFileManagerLabel(),
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 4,
        keybindings: [],
        run: () => {
          const filePath = currentFilePathRef.current;
          if (filePath) window.api.showItemInFolder(`${workingDirectory}/${filePath}`);
        },
      });
    },
    [isRemoteWorkspace, workingDirectory]
  );

  const registerAddToGitignoreAction = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor) => {
      if (!isGitWorkspace || isRemoteWorkspace) return;
      ed.addAction({
        id: 'add-to-gitignore',
        label: 'Add to .gitignore',
        contextMenuGroupId: 'z_blame',
        contextMenuOrder: 5,
        keybindings: [],
        run: async () => {
          const filePath = currentFilePathRef.current;
          if (!filePath) return;
          const pattern = filePath;
          try {
            let content = '';
            try {
              content = await window.api.readFile(workingDirectory, '.gitignore');
            } catch {
              // .gitignore doesn't exist yet
            }
            const lines = content.split('\n');
            if (lines.some((line) => line.trim() === pattern)) {
              useToastStore.getState().addToast(`"${pattern}" is already in .gitignore`, 'info');
              return;
            }
            const newContent =
              content.endsWith('\n') || content === ''
                ? `${content}${pattern}\n`
                : `${content}\n${pattern}\n`;
            await window.api.writeFile(workingDirectory, '.gitignore', newContent);
            useToastStore.getState().addToast(`Added "${pattern}" to .gitignore`, 'success');
            const store = useFileListStore.getState();
            store.fetchFileList(workingDirectory).catch(() => {});
            store.fetchFileStatuses(workingDirectory).catch(() => {});
          } catch (err) {
            useToastStore
              .getState()
              .addToast(
                `Failed to update .gitignore: ${err instanceof Error ? err.message : 'Unknown error'}`,
                'error'
              );
          }
        },
      });
    },
    [isGitWorkspace, isRemoteWorkspace, workingDirectory]
  );

  // Register "Copy @path" context menu action on a Monaco code editor
  const registerCopyAtPathAction = useCallback((ed: monacoEditor.IStandaloneCodeEditor) => {
    ed.addAction({
      id: 'copy-at-path',
      label: 'Copy @path',
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 3,
      keybindings: [COPY_AT_PATH_KEYBINDING],
      run: (e) => {
        const filePath = currentFilePathRef.current;
        if (!filePath) return;
        const atPath = formatAtPathWithLine(filePath, e);
        window.api.copyToClipboard(atPath);
        useToastStore.getState().addToast(`Copied ${atPath}`, 'success');
      },
    });
  }, []);

  // Register "Save" context menu action on a Monaco code editor
  const registerSaveAction = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor, keyRef: typeof isDirtyKeyRef) => {
      const key = ed.createContextKey<boolean>('komla.isDirty', false);
      keyRef.current = key;
      ed.addAction({
        id: 'save-file',
        label: 'Save',
        contextMenuGroupId: '1_modification',
        contextMenuOrder: 1,
        precondition: 'komla.isDirty',
        keybindings: [],
        run: () => {
          void saveFileRef.current();
        },
      });
    },
    []
  );

  const handleMarkdownEditorMount = useCallback((handle: MarkdownEditorHandle | null) => {
    markdownEditorRef.current = handle;
    if (handle && pendingLineJumpRef.current) {
      handle.revealLine(pendingLineJumpRef.current);
      pendingLineJumpRef.current = null;
    }
  }, []);

  // Store editor ref on mount
  const handleEditorMount = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor) => {
      editorRef.current = ed;
      removeNonFunctionalActions(ed);
      registerSaveAction(ed, isDirtyKeyRef);
      registerCopyAtPathAction(ed);
      registerOpenWithBlameAction(ed);
      registerFileHistoryAction(ed);
      registerRollbackAction(ed);
      registerRevealInFinderAction(ed);
      registerAddToGitignoreAction(ed);
      if (pendingLineJumpRef.current) {
        const line = pendingLineJumpRef.current;
        pendingLineJumpRef.current = null;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
      }
    },
    [
      registerSaveAction,
      registerCopyAtPathAction,
      registerOpenWithBlameAction,
      registerFileHistoryAction,
      registerRollbackAction,
      registerRevealInFinderAction,
      registerAddToGitignoreAction,
    ]
  );

  const registerGitEditorActions = useCallback(
    (ed: monacoEditor.IStandaloneCodeEditor) => {
      registerOpenWithBlameAction(ed);
      registerFileHistoryAction(ed);
      registerRollbackAction(ed);
      registerRevealInFinderAction(ed);
      registerAddToGitignoreAction(ed);
    },
    [
      registerOpenWithBlameAction,
      registerFileHistoryAction,
      registerRollbackAction,
      registerRevealInFinderAction,
      registerAddToGitignoreAction,
    ]
  );

  // Diff editor mount handler — store ref and track dirty state
  const handleDiffEditorMount = useCallback(
    (ed: monacoEditor.IStandaloneDiffEditor) => {
      diffEditorRef.current = ed;
      removeNonFunctionalActions(ed.getModifiedEditor());
      removeNonFunctionalActions(ed.getOriginalEditor());

      const modifiedEditor = ed.getModifiedEditor();
      registerSaveAction(modifiedEditor, isDirtyKeyDiffRef);
      registerCopyAtPathAction(modifiedEditor);
      registerCopyAtPathAction(ed.getOriginalEditor());
      registerGitEditorActions(modifiedEditor);
      registerGitEditorActions(ed.getOriginalEditor());
      diffBaselineRef.current = modifiedEditor.getValue();
      modifiedEditor.onDidChangeModelContent(() => {
        const currentContent = modifiedEditor.getValue();
        const isDirty = currentContent !== diffBaselineRef.current;
        editor.setIsDirty(isDirty);
      });

      // Track change count for navigation
      const updateChanges = () => {
        const changes = ed.getLineChanges();
        const count = changes?.length ?? 0;
        setTotalChanges(count);

        const target = pendingChangeTargetRef.current;
        if (target && changes && changes.length > 0) {
          pendingChangeTargetRef.current = null;
          const idx = target === 'first' ? 0 : changes.length - 1;
          currentChangeIndexRef.current = idx;
          setCurrentChangeIndex(idx);
          const change = changes[idx];
          const line = change.modifiedStartLineNumber;
          const modifiedEditor = ed.getModifiedEditor();
          modifiedEditor.revealLineInCenter(line);
          modifiedEditor.setPosition({ lineNumber: line, column: 1 });
        }
      };
      ed.onDidUpdateDiff(updateChanges);
      updateChanges();
    },
    [editor, registerSaveAction, registerCopyAtPathAction, registerGitEditorActions]
  );

  // Change navigation for diff mode
  const navigateToChange = useCallback((index: number) => {
    const ed = diffEditorRef.current;
    if (!ed) return;
    const changes = ed.getLineChanges();
    if (!changes || index < 0 || index >= changes.length) return;
    currentChangeIndexRef.current = index;
    setCurrentChangeIndex(index);
    const change = changes[index];
    const line = change.modifiedStartLineNumber;
    const modifiedEditor = ed.getModifiedEditor();
    modifiedEditor.revealLineInCenter(line);
    modifiedEditor.setPosition({ lineNumber: line, column: 1 });
  }, []);

  const selectDiffFile = useCallback(
    (fileKey: string) => {
      const path = fileKey;
      // Route through the store request so the dirty-edit guard kicks in for
      // cross-file change navigation. The previewState.filePath effect above
      // handles setViewMode + selectFileByPath once the request is applied.
      requestInlineFilePreviewNav(workspaceId, 'diff', path);
    },
    [requestInlineFilePreviewNav, workspaceId]
  );

  const goToNextChange = useCallback(() => {
    const ed = diffEditorRef.current;
    const count = ed?.getLineChanges()?.length ?? 0;
    const allFileKeys = mode === 'diff' ? getFlatFileKeys(diff.grouped) : [];

    const action = getNextChangeAction(
      currentChangeIndexRef.current,
      count,
      allFileKeys,
      diff.selectedFile
    );
    if (!action) return;
    if (action.type === 'navigate') {
      navigateToChange(action.index);
    } else {
      pendingChangeTargetRef.current = action.target;
      currentChangeIndexRef.current = -1;
      setCurrentChangeIndex(-1);
      selectDiffFile(action.fileKey);
    }
  }, [navigateToChange, mode, diff.grouped, diff.selectedFile, selectDiffFile]);

  const goToPreviousChange = useCallback(() => {
    const ed = diffEditorRef.current;
    const count = ed?.getLineChanges()?.length ?? 0;
    const allFileKeys = mode === 'diff' ? getFlatFileKeys(diff.grouped) : [];

    const action = getPrevChangeAction(
      currentChangeIndexRef.current,
      count,
      allFileKeys,
      diff.selectedFile
    );
    if (!action) return;
    if (action.type === 'navigate') {
      navigateToChange(action.index);
    } else {
      pendingChangeTargetRef.current = action.target;
      currentChangeIndexRef.current = -1;
      setCurrentChangeIndex(-1);
      selectDiffFile(action.fileKey);
    }
  }, [navigateToChange, mode, diff.grouped, diff.selectedFile, selectDiffFile]);

  // Expose change navigation to parent
  useEffect(() => {
    if (changeNavRef) {
      changeNavRef.current = { goToNext: goToNextChange, goToPrev: goToPreviousChange };
    }
    return () => {
      if (changeNavRef) changeNavRef.current = null;
    };
  }, [changeNavRef, goToNextChange, goToPreviousChange]);

  // Report total changes to parent
  useEffect(() => {
    onTotalChangesChange?.(totalChanges);
  }, [totalChanges, onTotalChangesChange]);

  // Reset change index when selected file changes
  useEffect(() => {
    currentChangeIndexRef.current = -1;
    setCurrentChangeIndex(-1);
  }, [diff.selectedFile]);

  // Save file
  const saveFile = useCallback(async () => {
    const filePath =
      mode === 'diff' ? (diff.selectedFile ? diff.selectedFile : null) : editor.filePath;
    if (!filePath || !editor.isDirty) return;

    const readBuffer = () =>
      mode === 'browse'
        ? (markdownEditorRef.current?.getMarkdown() ??
          readMountedEditor(editorRef.current) ??
          // An HTML file's preview replaces its source editor; every edit made there is kept here.
          editor.fileContent ??
          undefined)
        : diffEditorRef.current?.getModifiedEditor().getValue();
    const content = readBuffer();

    if (content === undefined) return;

    justSavedRef.current = true;
    try {
      if (isRemoteWorkspace) {
        await window.api.writeWorkspaceFile(workspaceId, filePath, content);
      } else {
        await window.api.writeFile(workingDirectory, filePath, content);
      }
      const fileName = filePath.split('/').pop() || filePath;
      useToastStore.getState().addToast(`Saved ${fileName}`, 'success');
      // Edits typed while the write was in flight are still unsaved.
      const latest = readBuffer();
      editor.setIsDirty(latest !== undefined && latest !== content);
      if (mode === 'diff') {
        diffBaselineRef.current = content;
        prevNewContentRef.current = content;
      } else {
        editor.setDiskContent(content);
        editor.setMissingOnDisk(false);
      }
      setTimeout(() => {
        justSavedRef.current = false;
      }, 1000);
    } catch (err) {
      justSavedRef.current = false;
      useToastStore
        .getState()
        .addToast(
          `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    }
  }, [editor, diff.selectedFile, isRemoteWorkspace, mode, workingDirectory, workspaceId]);

  saveFileRef.current = saveFile;

  // Keep a Monaco context key in sync with dirty state so the Save action is
  // only visible when there are unsaved changes.
  const isDirtyKeyRef = useRef<monacoEditor.IContextKey<boolean> | null>(null);
  const isDirtyKeyDiffRef = useRef<monacoEditor.IContextKey<boolean> | null>(null);

  useEffect(() => {
    isDirtyKeyRef.current?.set(editor.isDirty);
    isDirtyKeyDiffRef.current?.set(editor.isDirty);
  }, [editor.isDirty]);

  // Check for unsaved changes (accounts for diff editor baseline)
  const checkUnsaved = useCallback(() => {
    if (mode === 'diff' && diffEditorRef.current && diffBaselineRef.current !== null) {
      return diffEditorRef.current.getModifiedEditor().getValue() !== diffBaselineRef.current;
    }
    return editor.isDirty;
  }, [mode, editor.isDirty]);

  // Close with unsaved-changes guard
  const handleClose = useCallback(() => {
    if (checkUnsaved()) {
      setPendingClose(true);
      setUnsavedConfirmOpen(true);
      return;
    }
    editor.reset();
    closeInlineFilePreview(workspaceId);
  }, [checkUnsaved, editor, closeInlineFilePreview, workspaceId]);

  // Sync isDirty to store for tab bar display
  useEffect(() => {
    setInlineFilePreviewDirty(workspaceId, editor.isDirty);
  }, [workspaceId, editor.isDirty, setInlineFilePreviewDirty]);

  // Expose close handler for external callers (tab bar close button)
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;
  useEffect(() => {
    if (onCloseRef) onCloseRef.current = () => handleCloseRef.current();
    return () => {
      if (onCloseRef) onCloseRef.current = null;
    };
  }, [onCloseRef]);

  // When the file tree stages a navigation request that's blocked by
  // unsaved changes, surface it as the unsaved-changes dialog. The
  // request lives in the store (not local state) so the file tree's
  // dispatch and this dialog stay in sync without prop drilling.
  useEffect(() => {
    if (!pendingNav) return;
    setUnsavedConfirmOpen(true);
  }, [pendingNav]);

  // Same pattern for tree-driven close requests (re-clicking the open dirty
  // file). Mirror the store flag onto local pendingClose so confirmDiscard
  // takes the close branch.
  useEffect(() => {
    if (!pendingCloseFromStore) return;
    setPendingClose(true);
    setUnsavedConfirmOpen(true);
  }, [pendingCloseFromStore]);

  // Mode-change requests staged when toggling the file tree's diff/browse
  // tabs while the preview is dirty. confirmDiscard reads pendingModeChange
  // directly from the store, so we just surface the dialog here.
  useEffect(() => {
    if (!pendingModeChange) return;
    setUnsavedConfirmOpen(true);
  }, [pendingModeChange]);

  // Cancel: drop the staged nav request. previewState.filePath was never
  // changed, so the file tree highlight is already on the current file.
  const cancelUnsavedConfirm = useCallback(() => {
    setUnsavedConfirmOpen(false);
    setPendingClose(false);
    clearAllInlineFilePreviewPendingDiscardSlots(workspaceId);
  }, [clearAllInlineFilePreviewPendingDiscardSlots, workspaceId]);

  // Discard unsaved changes and proceed with the pending action. Snapshot
  // every pending slot, clear them all, then dispatch — sibling slots that
  // races set behind the open dialog must not survive the current decision.
  const confirmDiscard = useCallback(() => {
    const snapshotNav = pendingNav;
    const snapshotMode = pendingModeChange;
    const snapshotClose = pendingClose;

    setUnsavedConfirmOpen(false);
    setPendingClose(false);
    clearAllInlineFilePreviewPendingDiscardSlots(workspaceId);
    editor.setIsDirty(false);

    if (snapshotNav) {
      // The htmlPreviewIntent flag is set when the tree's "Open in Browser"
      // action staged the nav, browseTree when a link opened a file. We hold the
      // htmlViewMode + tree-mode flips until here so cancelling the prompt
      // leaves them untouched.
      if (snapshotNav.htmlPreviewIntent) setHtmlViewMode(workingDirectory, 'browser');
      if (snapshotNav.htmlPreviewIntent || snapshotNav.browseTree) {
        const store = useFileViewerStore.getState();
        if (store.inlineFileTreeByWorkspace[workspaceId]?.mode !== 'browse') {
          store.setInlineFileTreeMode(workspaceId, 'browse');
        }
      }
      openInlineFilePreview(
        workspaceId,
        snapshotNav.mode,
        snapshotNav.filePath,
        snapshotNav.lineNumber
      );
      return;
    }
    if (snapshotMode) {
      setInlineFileTreeMode(workspaceId, snapshotMode);
      setInlineFilePreviewMode(workspaceId, snapshotMode);
      return;
    }
    if (snapshotClose) {
      editor.reset();
      closeInlineFilePreview(workspaceId);
    }
  }, [
    editor,
    pendingNav,
    pendingModeChange,
    pendingClose,
    closeInlineFilePreview,
    openInlineFilePreview,
    setInlineFileTreeMode,
    setInlineFilePreviewMode,
    clearAllInlineFilePreviewPendingDiscardSlots,
    workspaceId,
    workingDirectory,
  ]);

  // Auto-refresh browse-mode editor on external file changes (e.g. AI edits).
  // Diff mode is handled by the global watcher's stale-cache mechanism, but
  // browse mode needs an explicit reload since it reads content from disk directly.
  const editorStateRef = useRef(editor);
  editorStateRef.current = editor;
  const wasActiveRef = useRef(isActive);
  const lastSeenWorktreeEventAtRef = useRef(lastWorktreeEventAt);

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;

    if (!isActive) return;

    const markSeen = () => {
      lastSeenWorktreeEventAtRef.current = getNextSeenWorktreeEventAt(
        lastSeenWorktreeEventAtRef.current,
        lastWorktreeEventAt
      );
    };

    const ed = editorStateRef.current;
    const filePath = ed.filePath;
    if (
      filePath === null ||
      !shouldRefreshBrowsePreviewOnReactivate({
        wasActive,
        isActive,
        lastWorktreeEventAt,
        lastSeenWorktreeEventAt: lastSeenWorktreeEventAtRef.current,
        isPreviewOpen: previewState.open,
        mode,
        filePath,
      })
    ) {
      markSeen();
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const currentDisk =
          usesFileMetadata(filePath, ed.isMedia) && !isRemoteWorkspace
            ? getFileDiskToken(await window.api.getFileMetadata(workingDirectory, filePath))
            : isRemoteWorkspace
              ? await window.api.readWorkspaceFile(workspaceId, filePath)
              : await window.api.readFile(workingDirectory, filePath);
        if (cancelled) return;

        ed.setMissingOnDisk(false);
        if (currentDisk !== ed.diskContent) {
          if (!ed.isDirty) {
            void ed.reloadFromDisk();
          } else {
            ed.setExternalChange(true);
          }
        }
      } catch (err) {
        if (!cancelled && isMissingFileError(err)) {
          ed.setMissingOnDisk(true);
        }
        if (!cancelled && ed.isDirty) {
          ed.setExternalChange(true);
        }
      } finally {
        if (!cancelled) {
          markSeen();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isActive,
    isRemoteWorkspace,
    lastWorktreeEventAt,
    mode,
    previewState.open,
    workingDirectory,
    workspaceId,
  ]);

  useEffect(() => {
    if (!isActive || !previewState.open || mode !== 'browse') return;
    const unsubscribe = window.api.onWorktreeChanged(
      async (changedWorkspaceId, _changeTypes, _activityAt, _fileStatus, _gitStatus, change) => {
        if (changedWorkspaceId !== workspaceId) return;

        const ed = editorStateRef.current;
        if (!ed.filePath) return;
        try {
          // An SSH read is a round trip, so skip files the Remote Companion says are unchanged.
          if (
            isRemoteWorkspace &&
            !useFileListStore
              .getState()
              .mayHaveChangedRemoteFile(workingDirectory, ed.filePath, change)
          ) {
            return;
          }
          const currentDisk =
            usesFileMetadata(ed.filePath, ed.isMedia) && !isRemoteWorkspace
              ? getFileDiskToken(await window.api.getFileMetadata(workingDirectory, ed.filePath))
              : isRemoteWorkspace
                ? await window.api.readWorkspaceFile(workspaceId, ed.filePath)
                : await window.api.readFile(workingDirectory, ed.filePath);
          ed.setMissingOnDisk(false);
          if (currentDisk !== ed.diskContent) {
            if (!ed.isDirty) {
              void ed.reloadFromDisk();
            } else {
              ed.setExternalChange(true);
            }
          }
        } catch (err) {
          if (isMissingFileError(err)) {
            ed.setMissingOnDisk(true);
          }
          if (ed.isDirty) {
            ed.setExternalChange(true);
          }
        } finally {
          const latestEventAt =
            useWorktreeEventsStore.getState().lastEventByWorkspace[workspaceId] ?? 0;
          lastSeenWorktreeEventAtRef.current = getNextSeenWorktreeEventAt(
            lastSeenWorktreeEventAtRef.current,
            latestEventAt
          );
        }
      }
    );
    return unsubscribe;
  }, [isActive, isRemoteWorkspace, mode, previewState.open, workspaceId, workingDirectory]);

  // Cmd+S and Escape keyboard shortcuts
  useEffect(() => {
    if (!isActive || !previewState.open) return;

    const handler = (e: KeyboardEvent) => {
      // A file pane that saved its own file claimed the key.
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.defaultPrevented) {
        e.preventDefault();
        void saveFile();
      }
      if (e.key === 'Escape') {
        // The unsaved-changes dialog manages its own dismiss path. Don't
        // re-fire handleClose here, otherwise Esc on the dialog would
        // immediately re-open it (via setPendingClose=true) and trap the
        // user.
        if (unsavedConfirmOpen) return;
        // Escape that ends an IME composition (a rename in the tree) belongs to the input.
        if (e.isComposing) return;
        // Only Escape aimed at the preview or the file tree closes it. Escape
        // that dismisses a menu, the terminal find bar, or the file-tree search
        // (or reaches an agent in the terminal) must leave the preview open.
        if (
          e.defaultPrevented ||
          !isInlineFilePreviewTarget(e.target, panelRef.current, workspaceId)
        ) {
          return;
        }
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive, previewState.open, saveFile, handleClose, unsavedConfirmOpen, workspaceId]);

  if (!previewState.open && !unsavedConfirmOpen) return null;

  // Diff-mode browser toggle: same gating as the full dialog — only
  // surface for directly renderable files whose working copy still exists.
  const diffBrowserPreviewFilePath = (() => {
    if (!diff.selectedFile) return null;
    const path = diff.selectedFile;
    const fileChange = diff.grouped.files.find((f) => f.path === path);
    if (
      !shouldOfferDiffBrowserPreview({
        mode,
        filePath: path,
        fileStatus: fileChange?.status,
      }) ||
      !fileChange
    ) {
      return null;
    }
    return path;
  })();

  return (
    <>
      {/* Focusable so a click on non-focusable preview content keeps Escape scoped here. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'flex h-full min-h-0 flex-col overflow-hidden outline-hidden',
          !previewState.open && 'hidden'
        )}
      >
        {noteName && workspace ? (
          <NoteEditor workspace={workspace} name={noteName} onClose={handleClose} />
        ) : (
          <ContentArea
            mode={mode}
            workingDirectory={workingDirectory}
            workspaceId={workspaceId}
            filePath={editor.filePath}
            fileContent={editor.fileContent}
            savedContent={editor.diskContent}
            loadingFile={
              editor.loadingFile ||
              (!editor.isBrowserPreviewable && !editor.isUnsupportedBinary && !isMonacoReady)
            }
            fileError={
              editor.isBrowserPreviewable || editor.isUnsupportedBinary
                ? editor.error
                : (monacoLoadError ?? editor.error)
            }
            missingOnDisk={editor.missingOnDisk && !editor.isDirty}
            readOnly={editedInFilePane && !editor.isDirty}
            onChange={handleEditorChange}
            onEditorMount={handleEditorMount}
            onMarkdownEditorMount={handleMarkdownEditorMount}
            onCloseMissing={handleClose}
            browserPreviewFilePath={editor.isBrowserPreviewable ? editor.filePath : null}
            browserPreviewVersion={editor.diskContent}
            isImage={editor.isImage}
            imageData={editor.imageData}
            imageMimeType={editor.imageMimeType}
            isMedia={editor.isMedia}
            mediaData={editor.mediaData}
            mediaMimeType={editor.mediaMimeType}
            mediaKind={editor.mediaKind}
            mediaSize={editor.mediaSize}
            mediaPreviewLoading={editor.mediaPreviewLoading}
            mediaPreviewError={editor.mediaPreviewError}
            onLoadMediaPreview={() => void editor.loadMediaPreview()}
            diffContent={diff.fileContent}
            viewMode={diff.viewMode}
            selectedFile={diff.selectedFile}
            diffLoading={diff.loading || !isMonacoReady}
            diffLoadingFile={diff.loadingFile}
            diffError={monacoLoadError ?? diff.fileError}
            forceLargeFile={diff.forceLargeFile}
            largeFileBlock={diff.largeFileBlock}
            hideUnchangedRegions={diff.hideUnchangedRegions}
            onRetry={diff.retryFile}
            onLoadLargeFile={diff.loadLargeFile}
            onRefreshMissingDiff={() => void diff.refresh()}
            onDiffEditorMount={handleDiffEditorMount}
            hasFiles={(diff.diffData?.files.length ?? 0) > 0}
            isDirty={editor.isDirty}
            diffBrowserPreviewFilePath={diffBrowserPreviewFilePath}
            diffBrowserPreviewVersion={diff.browserPreviewVersion}
          />
        )}
      </div>

      {/* Unsaved changes confirmation */}
      <Dialog
        open={unsavedConfirmOpen}
        onOpenChange={(open) => {
          if (!open) cancelUnsavedConfirm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Are you sure you want to{' '}
              {pendingModeChange ? 'switch view mode' : pendingNav ? 'switch files' : 'close'}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelUnsavedConfirm}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDiscard}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
