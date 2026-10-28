import { FolderSimplePlus, NoteBlank } from '@phosphor-icons/react';
import React, { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { usePaneDragBar } from '@/components/terminal/PaneDragGrip';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { ensureMonacoInitialized } from '@/lib/monaco-loader';
import { getNoteFileName } from '@/lib/notes';
import { cn } from '@/lib/utils';
import { useFileListStore } from '@/stores/file-list.store';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useNotesStore } from '@/stores/notes.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';

import { getNoteTitle } from '../../../../../shared/lib/notes';
import { MarkdownContentArea } from '../markdown/MarkdownContentArea';
import { isMissingFileError } from '../useFileViewerState';

import { SaveNoteDialog } from './SaveNoteDialog';

import type { MarkdownEditorHandle } from '../markdown/RichMarkdownEditor';
import type { Workspace } from '@/types';

const EditorPane = React.lazy(() =>
  import('../EditorPane').then((m) => ({ default: m.EditorPane }))
);

/** Typing saves this long after the last keystroke. */
const SAVE_DELAY_MS = 400;
// The title is in the first lines; don't scan a long note on every keystroke.
const TITLE_SCAN_LENGTH = 4096;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** Checks a path typed for saving into the project; returns it cleaned up, or null. */
function cleanProjectPath(input: string): string | null {
  const path = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\0')) return null;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    ? path
    : null;
}

interface NoteEditorProps {
  workspace: Workspace;
  /** The note's file name. */
  name: string;
  onClose: () => void;
  /**
   * Whether unmounting closes the note, which deletes it if blank. A pane that
   * only moves remounts its note and keeps it. Closing by default.
   */
  isClosing?: () => boolean;
  /** Called once the note is saved into the project, which removes it from Notes. */
  onSavedToProject?: () => void;
  /** Buttons at the end of the toolbar, after the view toggle. */
  trailingActions?: React.ReactNode;
}

/**
 * A note in the file panel. It saves as you type, so it never has unsaved
 * changes; Cmd+S saves it into the project instead. Closing a note left blank
 * deletes it.
 */
export function NoteEditor(props: NoteEditorProps) {
  // A fresh editor per note, so one note's edits are saved before the next one loads.
  return <NoteEditorContent key={`${props.workspace.id}/${props.name}`} {...props} />;
}

function NoteEditorContent({
  workspace,
  name,
  onClose,
  isClosing,
  onSavedToProject,
  trailingActions,
}: NoteEditorProps) {
  const scopeId = workspace.id;
  const isRemoteWorkspace = workspace.backend?.kind === 'ssh';
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  // A new note takes focus, so typing can start straight away.
  const [startedBlank, setStartedBlank] = useState(false);
  const [monacoReady, setMonacoReady] = useState(false);
  const [saveDialog, setSaveDialog] = useState<{ key: number; open: boolean }>({
    key: 0,
    open: false,
  });

  // The text in the editor, and the text the file has as far as this editor knows.
  // Both stay null until the note loads, so nothing is written over a note never read.
  const latestRef = useRef<string | null>(null);
  const savedRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Writes run one at a time, in order; null until the first.
  const writeChainRef = useRef<Promise<void> | null>(null);
  // Counts writes, so a read that raced one doesn't replace newer text.
  const writeCountRef = useRef(0);
  // Set once the note is saved into the project; later edits have nowhere to go.
  const movedRef = useRef(false);
  // The rich editor reports typing in batches; getMarkdown() reports the last batch now.
  const richEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const setRichEditor = useCallback((handle: MarkdownEditorHandle | null) => {
    richEditorRef.current = handle;
  }, []);

  const flush = useCallback((): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const text = latestRef.current;
    if (movedRef.current || text === null || text === savedRef.current) {
      return writeChainRef.current ?? Promise.resolve();
    }
    savedRef.current = text;
    writeCountRef.current += 1;
    writeChainRef.current = (writeChainRef.current ?? Promise.resolve())
      .then(() => window.api.writeNote(scopeId, name, text))
      .catch((error: unknown) => {
        // Unknown now, so the next edit or flush writes again.
        if (savedRef.current === text) savedRef.current = null;
        useToastStore
          .getState()
          .addToast(`Couldn't save the note: ${errorMessage(error)}`, 'error');
      });
    return writeChainRef.current;
  }, [name, scopeId]);

  const showText = useCallback(
    (text: string) => {
      latestRef.current = text;
      setContent(text);
      useNotesStore
        .getState()
        .setTitle(scopeId, name, getNoteTitle(text.slice(0, TITLE_SCAN_LENGTH)));
    },
    [name, scopeId]
  );

  useEffect(() => {
    let cancelled = false;
    window.api.readNote(scopeId, name).then(
      (text) => {
        if (cancelled) return;
        savedRef.current = text;
        setStartedBlank(text.trim() === '');
        showText(text);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (isMissingFileError(error)) setDeleted(true);
        else setLoadError(`Couldn't open the note: ${errorMessage(error)}`);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [name, scopeId, showText]);

  // Text an agent or another window wrote shows here, unless there are edits not yet saved.
  useEffect(() => {
    return window.api.onNotesChanged((changedScopeId) => {
      if (changedScopeId !== scopeId || latestRef.current === null || movedRef.current) return;
      const writeCount = writeCountRef.current;
      void (writeChainRef.current ?? Promise.resolve())
        .then(() => window.api.readNote(scopeId, name))
        .then(
          (text) => {
            if (writeCount !== writeCountRef.current) return;
            if (text === savedRef.current || latestRef.current !== savedRef.current) return;
            savedRef.current = text;
            showText(text);
          },
          (error: unknown) => {
            if (isMissingFileError(error) && latestRef.current === savedRef.current) {
              setDeleted(true);
            }
          }
        );
    });
  }, [name, scopeId, showText]);

  // Source mode's editor needs Monaco set up first.
  useEffect(() => {
    let cancelled = false;
    void ensureMonacoInitialized().then(
      () => !cancelled && setMonacoReady(true),
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The rich editor's handle is gone by the time the effect below cleans up.
  useLayoutEffect(() => () => void richEditorRef.current?.getMarkdown(), []);

  const isClosingRef = useRef(isClosing);
  useLayoutEffect(() => {
    isClosingRef.current = isClosing;
  });

  // Save what's typed before the window goes away, and when the note closes.
  useEffect(() => {
    const handleUnload = () => {
      richEditorRef.current?.getMarkdown();
      void flush();
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      const text = latestRef.current;
      const closing = isClosingRef.current?.() ?? true;
      void flush()
        .then(() => {
          if (closing && text !== null && !movedRef.current && text.trim() === '') {
            return window.api.deleteNote(scopeId, name, true);
          }
        })
        .catch(() => {});
    };
  }, [flush, name, scopeId]);

  const handleChange = useCallback(
    (text: string) => {
      if (latestRef.current === null || text === latestRef.current) return;
      showText(text);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush, showText]
  );

  const openSaveDialog = () => {
    if (latestRef.current === null) return;
    richEditorRef.current?.getMarkdown();
    void flush();
    setSaveDialog((dialog) => ({ key: dialog.key + 1, open: true }));
  };

  const saveToProject = async (input: string): Promise<string | null> => {
    const path = cleanProjectPath(input);
    if (!path) return 'Enter a path inside the project, like docs/plan.md.';
    const text = latestRef.current ?? '';
    try {
      const exists = isRemoteWorkspace
        ? await window.api.readWorkspaceFile(workspace.id, path).then(
            () => true,
            (error: unknown) => {
              // A file it couldn't read for another reason (too large, connection) may be there.
              if (isMissingFileError(error)) return false;
              throw error;
            }
          )
        : await window.api.fileExists(workspace.workingDirectory, path);
      if (exists) return `${path} already exists.`;
      if (isRemoteWorkspace) await window.api.writeWorkspaceFile(workspace.id, path, text);
      else await window.api.writeFile(workspace.workingDirectory, path, text);
    } catch (error) {
      return `Couldn't save: ${errorMessage(error)}`;
    }

    movedRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await writeChainRef.current;
    // The project has the text now; keep the note only if deleting it fails.
    await window.api.deleteNote(scopeId, name, false).catch(() => {});
    void useNotesStore
      .getState()
      .load(scopeId)
      .catch(() => {});
    const fileLists = useFileListStore.getState();
    fileLists.fetchFileList(workspace.workingDirectory, false, workspace.id).catch(() => {});
    if (!isRemoteWorkspace) fileLists.fetchFileStatuses(workspace.workingDirectory).catch(() => {});
    useToastStore.getState().addToast(`Saved ${path}`, 'success');
    setSaveDialog((dialog) => ({ ...dialog, open: false }));
    // Show the saved file where the note was.
    useFileViewerStore.getState().requestInlineFilePreviewNav(workspace.id, 'browse', path);
    onSavedToProject?.();
    return null;
  };
  // While loading, the toolbar row drags the pane as the editor's toolbar will.
  const dragBar = usePaneDragBar();

  if (deleted || loadError) {
    return (
      <EmptyState
        icon={<NoteBlank weight="duotone" />}
        title={deleted ? 'This note was deleted' : "Couldn't open this note"}
        description={loadError ?? undefined}
        action={
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        }
        className="flex-1"
      />
    );
  }

  if (content === null) {
    return (
      <>
        {/* Keeps the toolbar's end buttons, such as a pane's close button, while it loads. */}
        {trailingActions && (
          <div
            className={cn(
              'flex h-8 shrink-0 items-center justify-end border-b border-border px-2',
              dragBar && 'cursor-grab active:cursor-grabbing'
            )}
            {...dragBar}
          >
            {trailingActions}
          </div>
        )}
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Spinner size="lg" className="size-5" />
        </div>
      </>
    );
  }

  const saveShortcut = formatShortcutForDisplay('Cmd+S', window.api?.platform);
  const title = getNoteTitle(content.slice(0, TITLE_SCAN_LENGTH));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onBlur={() => void flush()}
      onKeyDown={(event) => {
        // The save dialog's keys reach here through its portal.
        if (
          !saveDialog.open &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault();
          openSaveDialog();
        }
      }}
    >
      <MarkdownContentArea
        filePath={name}
        fileContent={content}
        loadingFile={false}
        fileError={null}
        readOnly={false}
        sourceOnly={false}
        autoFocus={startedBlank}
        onChange={handleChange}
        onMarkdownEditorMount={setRichEditor}
        // Relative image paths resolve against the project, as if the note were at its root.
        readImage={(path) => window.api.readWorkspaceImageFile(workspace.id, path)}
        actions={
          <IconButton
            label="Save to project"
            shortcut={saveShortcut}
            size="xs"
            tooltipSide="bottom"
            onClick={openSaveDialog}
          >
            <FolderSimplePlus className="size-3.5" />
          </IconButton>
        }
        trailingActions={trailingActions}
        sourceEditor={
          <ErrorBoundary key={`note-source:${name}`}>
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                  <Spinner size="lg" className="size-5" />
                </div>
              }
            >
              <EditorPane
                filePath={name}
                fileContent={content}
                loading={!monacoReady}
                error={null}
                onChange={handleChange}
              />
            </Suspense>
          </ErrorBoundary>
        }
      />
      <SaveNoteDialog
        key={saveDialog.key}
        open={saveDialog.open}
        defaultPath={getNoteFileName(title)}
        onCancel={() => setSaveDialog((dialog) => ({ ...dialog, open: false }))}
        onSave={saveToProject}
      />
    </div>
  );
}
