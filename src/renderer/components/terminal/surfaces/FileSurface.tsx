import { ArrowSquareOut, FloppyDisk, LockSimple } from '@phosphor-icons/react';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ContentArea } from '@/components/workspaces/file-viewer/ContentArea';
import { getFileIcon } from '@/components/workspaces/file-viewer/file-icon-utils';
import {
  COPY_AT_PATH_KEYBINDING,
  formatAtPathWithLine,
  readMountedEditor,
  removeNonFunctionalActions,
} from '@/components/workspaces/file-viewer/file-viewer-utils';
import {
  useFileEditorState,
  type FileEditorState,
} from '@/components/workspaces/file-viewer/useFileViewerState';
import {
  reconcileEditorWithDisk,
  useFileWatcherSync,
} from '@/components/workspaces/file-viewer/useFileWatcherSync';
import { ensureMonacoInitialized } from '@/lib/monaco-loader';
import {
  getFilePaneDraft,
  hasUnsavedFilePane,
  setFilePaneDraft,
  takeFilePaneOpening,
} from '@/lib/pane-surfaces';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { usePaneSurfacesStore } from '@/stores/pane-surfaces.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorktreeEventsStore } from '@/stores/worktree-events.store';

import { useConfirmDialog } from '../useConfirmDialog';

import type { SurfaceBodyProps } from './surface-props';
import type { MarkdownEditorHandle } from '@/components/workspaces/file-viewer/markdown/RichMarkdownEditor';
import type { editor as monacoEditor } from 'monaco-editor';

const READ_ONLY_REASON = 'Read-only while another pane has unsaved changes to this file';

function noop() {}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * A workspace file in a pane, shown as the file panel shows it. Its unsaved text
 * outlives the editor, which remounts whenever the layout around it changes.
 */
export function FileSurface({
  surfaceId,
  workspace,
  isTabActive,
  header,
  onClose,
  path,
}: SurfaceBodyProps & { path: string }) {
  const { workingDirectory } = workspace;
  const isRemoteWorkspace = workspace.backend?.kind === 'ssh';
  const editor = useFileEditorState(workingDirectory, workspace.id);
  const { openFile, setFileContent, setIsDirty } = editor;
  const [isMonacoReady, setIsMonacoReady] = useState(false);
  const [monacoLoadError, setMonacoLoadError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirmDialog();
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  // Shows Monaco's Save menu item only while there is something to save.
  const dirtyKeyRef = useRef<monacoEditor.IContextKey<boolean> | null>(null);
  // The rich editor reports typing in batches; getMarkdown() reports the last batch now.
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  // How a pane opened just now shows its file: focused, at its line. A remount gets none.
  const [opening] = useState(() => takeFilePaneOpening(surfaceId));
  const openingRef = useRef(opening);
  const editorStateRef = useRef(editor);
  const pathRef = useRef(path);
  useLayoutEffect(() => {
    editorStateRef.current = editor;
    pathRef.current = path;
  });

  // Another copy of the file with unsaved edits keeps this one from editing it too.
  const editedInAnotherPane = usePaneSurfacesStore((s) =>
    hasUnsavedFilePane(s.surfaces, workspace.id, path, surfaceId)
  );
  const editedInFilePanel = useFileViewerStore((s) => {
    const preview = s.inlineFilePreviewByWorkspace[workspace.id];
    return !!preview?.open && !!preview.isDirty && preview.filePath === path;
  });
  const readOnly = !editor.isDirty && (editedInAnotherPane || editedInFilePanel);

  // A new pane takes focus, which its editor takes over once it shows.
  useEffect(() => {
    if (opening) contentRef.current?.focus();
  }, [opening]);

  useEffect(() => {
    let cancelled = false;
    void openFile(path).then(() => {
      // Edits made before the pane remounted.
      const draft = getFilePaneDraft(surfaceId);
      if (cancelled || draft === undefined) return;
      setFileContent(draft);
      setIsDirty(true);
    });
    return () => {
      cancelled = true;
    };
  }, [openFile, path, setFileContent, setIsDirty, surfaceId]);

  useEffect(() => {
    let cancelled = false;
    void ensureMonacoInitialized().then(
      () => !cancelled && setIsMonacoReady(true),
      (error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Unknown error';
        setMonacoLoadError(`Failed to initialize editor: ${message}`);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useShownFileDiskSync(editor, editorStateRef, {
    isTabActive,
    workspaceId: workspace.id,
    workingDirectory,
    isRemoteWorkspace,
  });

  useEffect(() => {
    dirtyKeyRef.current?.set(editor.isDirty);
  }, [editor.isDirty]);

  // The rich editor's handle is gone by the time a remount would look for its last batch.
  useLayoutEffect(() => () => void markdownEditorRef.current?.getMarkdown(), []);

  const handleChange = useCallback(
    (content: string) => {
      setFileContent(content);
      const dirty = content !== editorStateRef.current.diskContent;
      setIsDirty(dirty);
      setFilePaneDraft(surfaceId, dirty ? content : null);
    },
    [setFileContent, setIsDirty, surfaceId]
  );

  const save = async () => {
    if (!editorStateRef.current.isDirty) return;
    const fileName = getFileName(path);
    // Saving would lose what changed on disk since the edits began.
    if (
      editorStateRef.current.hasExternalChange &&
      !(await confirm({
        title: 'File Changed on Disk',
        description: `${fileName} changed on disk while you were editing. Overwrite it with your changes?`,
        confirmLabel: 'Overwrite',
      }))
    ) {
      return;
    }
    const readBuffer = () =>
      markdownEditorRef.current?.getMarkdown() ??
      readMountedEditor(editorRef.current) ??
      // An HTML file's preview replaces its source editor; every edit made there is kept here.
      editorStateRef.current.fileContent ??
      undefined;
    const content = readBuffer();
    if (content === undefined) return;
    try {
      if (isRemoteWorkspace) await window.api.writeWorkspaceFile(workspace.id, path, content);
      else await window.api.writeFile(workingDirectory, path, content);
    } catch (error) {
      useToastStore
        .getState()
        .addToast(
          `Failed to save: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'error'
        );
      return;
    }
    useToastStore.getState().addToast(`Saved ${fileName}`, 'success');
    // Edits typed while the write was in flight are still unsaved.
    const latest = readBuffer();
    const stillDirty = latest !== undefined && latest !== content;
    editor.setDiskContent(content);
    editor.setMissingOnDisk(false);
    editor.setExternalChange(false);
    editor.setIsDirty(stillDirty);
    setFilePaneDraft(surfaceId, stillDirty ? latest : null);
  };
  const saveRef = useRef(save);
  useLayoutEffect(() => {
    saveRef.current = save;
  });

  const reloadFromDisk = () => {
    setFilePaneDraft(surfaceId, null);
    void editor.reloadFromDisk();
  };

  const handleEditorMount = (ed: monacoEditor.IStandaloneCodeEditor) => {
    editorRef.current = ed;
    dirtyKeyRef.current = addFilePaneActions(ed, {
      isDirty: editorStateRef.current.isDirty,
      save: () => void saveRef.current(),
      getPath: () => pathRef.current,
    });
    const opening = openingRef.current;
    if (!opening) return;
    openingRef.current = undefined;
    if (opening.lineNumber) {
      ed.revealLineInCenter(opening.lineNumber);
      ed.setPosition({ lineNumber: opening.lineNumber, column: 1 });
    }
    ed.focus();
  };

  // Without a line to show, the rich editor focuses itself through autoFocus.
  const handleMarkdownEditorMount = (handle: MarkdownEditorHandle | null) => {
    markdownEditorRef.current = handle;
    const lineNumber = openingRef.current?.lineNumber;
    if (!handle || !lineNumber) return;
    openingRef.current = undefined;
    handle.revealLine(lineNumber);
  };

  const { icon: FileIcon, colorClass } = getFileIcon(path);

  return (
    <>
      {header(
        <>
          {editor.isDirty && (
            <span
              role="img"
              aria-label="Unsaved changes"
              className="inline-block size-2 shrink-0 rounded-full bg-warning"
              title="Unsaved changes"
            />
          )}
          <span className="truncate">{getFileName(path)}</span>
        </>,
        {
          icon: <FileIcon className={colorClass} />,
          titleTooltip: path,
          actions: (
            <FilePaneActions
              readOnly={readOnly}
              isDirty={editor.isDirty}
              onSave={() => void save()}
              onOpenInFileViewer={() =>
                useFileViewerStore.getState().requestFileViewerTransition({
                  kind: 'mode',
                  workspaceId: workspace.id,
                  mode: 'browse',
                  after: { kind: 'browse-file', filePath: path },
                })
              }
            />
          ),
        }
      )}
      {editor.hasExternalChange && editor.isDirty && (
        <ChangedOnDiskBar
          deleted={editor.missingOnDisk}
          onKeep={() => editor.setExternalChange(false)}
          onReload={reloadFromDisk}
        />
      )}
      <div
        ref={contentRef}
        role="group"
        aria-label={getFileName(path)}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-hidden"
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            event.key.toLowerCase() === 's'
          ) {
            // Claimed, so the file panel doesn't save its own file too.
            event.preventDefault();
            void save();
          }
        }}
      >
        <ContentArea
          mode="browse"
          workingDirectory={workingDirectory}
          workspaceId={workspace.id}
          filePath={editor.filePath}
          fileContent={editor.fileContent}
          savedContent={editor.diskContent}
          {...getLoadState(editor, isMonacoReady, monacoLoadError)}
          missingOnDisk={editor.missingOnDisk && !editor.isDirty}
          readOnly={readOnly}
          autoFocus={!!opening && !opening.lineNumber}
          onChange={handleChange}
          onEditorMount={handleEditorMount}
          onMarkdownEditorMount={handleMarkdownEditorMount}
          onCloseMissing={onClose}
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
          diffContent={null}
          viewMode="split"
          selectedFile={null}
          diffLoading={false}
          diffLoadingFile={false}
          diffError={null}
          forceLargeFile={false}
          largeFileBlock={null}
          hideUnchangedRegions={false}
          onRetry={noop}
          onLoadLargeFile={noop}
        />
      </div>
      {confirmDialog}
    </>
  );
}

/**
 * Keeps a pane's file in step with the disk: an agent's edit shows unless there are
 * unsaved edits. Only a shown pane watches; one shown again rereads its file if the
 * workspace changed meanwhile.
 */
function useShownFileDiskSync(
  editor: FileEditorState,
  editorStateRef: React.RefObject<FileEditorState>,
  target: {
    isTabActive: boolean;
    workspaceId: string;
    workingDirectory: string;
    isRemoteWorkspace: boolean;
  }
): void {
  const { isTabActive, workspaceId, workingDirectory, isRemoteWorkspace } = target;
  useFileWatcherSync({
    open: isTabActive,
    workspaceId,
    workingDirectory,
    isRemoteWorkspace,
    editor,
  });
  const seenWorktreeEventAtRef = useRef<number | null>(null);
  useEffect(() => {
    const lastEventAt = () =>
      useWorktreeEventsStore.getState().lastEventByWorkspace[workspaceId] ?? 0;
    if (!isTabActive) {
      seenWorktreeEventAtRef.current = lastEventAt();
      return;
    }
    const seen = seenWorktreeEventAtRef.current;
    seenWorktreeEventAtRef.current = null;
    if (seen === null || lastEventAt() <= seen) return;
    void reconcileEditorWithDisk(editorStateRef.current, {
      workspaceId,
      workingDirectory,
      isRemoteWorkspace,
    });
  }, [editorStateRef, isTabActive, isRemoteWorkspace, workingDirectory, workspaceId]);
}

/**
 * The file panel's Save and Copy @path for a pane's code editor, without the menu
 * items that do nothing there. Returns the key that shows Save while there are edits.
 */
function addFilePaneActions(
  ed: monacoEditor.IStandaloneCodeEditor,
  { isDirty, save, getPath }: { isDirty: boolean; save: () => void; getPath: () => string }
): monacoEditor.IContextKey<boolean> {
  removeNonFunctionalActions(ed);
  const dirtyKey = ed.createContextKey<boolean>('komla.isDirty', isDirty);
  ed.addAction({
    id: 'save-file',
    label: 'Save',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    precondition: 'komla.isDirty',
    run: save,
  });
  ed.addAction({
    id: 'copy-at-path',
    label: 'Copy @path',
    contextMenuGroupId: '9_cutcopypaste',
    contextMenuOrder: 3,
    keybindings: [COPY_AT_PATH_KEYBINDING],
    run: (e) => {
      const atPath = formatAtPathWithLine(getPath(), e);
      window.api.copyToClipboard(atPath);
      useToastStore.getState().addToast(`Copied ${atPath}`, 'success');
    },
  });
  return dirtyKey;
}

/** Whether the file is still loading, and why it can't show: Monaco matters only to text. */
function getLoadState(
  editor: FileEditorState,
  isMonacoReady: boolean,
  monacoLoadError: string | null
): { loadingFile: boolean; fileError: string | null } {
  const needsMonaco = !editor.isBrowserPreviewable && !editor.isUnsupportedBinary;
  return {
    loadingFile: editor.loadingFile || (needsMonaco && !isMonacoReady),
    fileError: needsMonaco ? (monacoLoadError ?? editor.error) : editor.error,
  };
}

/** The pane header's Save button while there are edits, or why the file can't be edited. */
function FilePaneActions({
  readOnly,
  isDirty,
  onSave,
  onOpenInFileViewer,
}: {
  readOnly: boolean;
  isDirty: boolean;
  onSave: () => void;
  onOpenInFileViewer: () => void;
}) {
  return (
    <>
      {readOnly ? (
        <span
          className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground"
          title={READ_ONLY_REASON}
        >
          <LockSimple className="size-3.5" />
          Read-only
        </span>
      ) : (
        isDirty && (
          <IconButton
            label="Save"
            shortcut={formatShortcutForDisplay('Cmd+S', window.api?.platform)}
            size="xs"
            tooltipSide="bottom"
            onClick={onSave}
          >
            <FloppyDisk className="size-3.5" />
          </IconButton>
        )
      )}
      <IconButton
        label="Open full screen"
        size="xs"
        tooltipSide="bottom"
        onClick={onOpenInFileViewer}
      >
        <ArrowSquareOut className="size-3.5" />
      </IconButton>
    </>
  );
}

/** Says the file changed on disk while the pane has unsaved edits to it. */
function ChangedOnDiskBar({
  deleted,
  onKeep,
  onReload,
}: {
  deleted: boolean;
  onKeep: () => void;
  onReload: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {deleted ? 'Deleted' : 'Changed'} on disk while you were editing
      </span>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onKeep}>
        Keep My Changes
      </Button>
      <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onReload}>
        Reload from Disk
      </Button>
    </div>
  );
}
