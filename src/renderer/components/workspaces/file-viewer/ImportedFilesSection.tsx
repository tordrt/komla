import {
  AppWindow,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Clipboard,
  Copy,
  Globe,
  MagnifyingGlass,
  Paperclip,
  PencilSimple,
  Scissors,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { joinAbsPath } from '@/lib/fs-path';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { claimShortcutEvent } from '@/lib/shortcut-claims';
import { AT_PATH_MIME, setTreeDragActive } from '@/lib/tree-drag-token';
import { cn } from '@/lib/utils';
import { isImportedFilePath, KOMLA_FILES_DIR } from '@/lib/workspace-file-paths';
import { useFileViewerStore, type FileTreeReveal } from '@/stores/file-viewer.store';
import { useToastStore } from '@/stores/toast.store';

import { isBrowserPreviewableFile } from '../../../../shared/image-utils';

import {
  FILE_PANEL_SECTION_CLASS,
  FILE_PANEL_SECTION_COUNT_CLASS,
  FILE_PANEL_SECTION_HEADER_CLASS,
  FILE_PANEL_SECTION_ICON_CLASS,
  FILE_PANEL_SECTION_ROW_CLASS,
} from './file-panel-section';

import type { PaneSurfacePlacement } from '@/lib/pane-surfaces';

interface ImportedFilesSectionProps {
  workspaceId: string;
  workingDirectory: string;
  /** Workspace-relative paths to list, narrowed to the matches while searching. */
  files: readonly string[];
  isSearching: boolean;
  currentFile: string | null;
  isRemoteWorkspace: boolean;
  reveal?: FileTreeReveal | null;
  onFileSelect: (path: string) => void;
  onDeleteFile?: (path: string, isDirectory?: boolean) => void;
  onRenameComplete?: (src: string, dest: string, isFolder: boolean) => Promise<boolean>;
  onCopyNode?: (path: string, isDirectory: boolean) => void;
  onCutNode?: (path: string, isDirectory: boolean) => void;
  onOpenInPane?: (path: string, placement: PaneSurfacePlacement) => void;
  onOpenHtmlInBrowser?: (path: string) => void;
}

type RowActions = Omit<
  ImportedFilesSectionProps,
  'workspaceId' | 'files' | 'isSearching' | 'currentFile' | 'reveal'
>;

const PATH_ATTRIBUTE = 'data-imported-path';

/**
 * The files Komla imported into this workspace, below its file tree: they aren't project content,
 * so they stay out of the tree and out of git. Hidden until there is one.
 */
export function ImportedFilesSection({
  workspaceId,
  files,
  isSearching,
  currentFile,
  reveal,
  ...actions
}: ImportedFilesSectionProps) {
  const collapsed = useFileViewerStore((s) => !!s.importedFilesCollapsedByWorkspace[workspaceId]);
  const listRef = useRef<HTMLUListElement>(null);
  // Where a rename ended by a key is moving a file, for its new row to take focus once listed.
  const focusOnMountPathRef = useRef<string | null>(null);
  // Matches show even in a collapsed section, or searching would seem to find nothing here.
  const showRows = !collapsed || isSearching;

  const revealPath = reveal && isImportedFilePath(reveal.path) ? reveal.path : null;
  const revealExpiresAt = reveal?.expiresAt ?? 0;
  const revealRow =
    revealPath === null
      ? undefined
      : files.find((file) => file === revealPath || file.startsWith(`${revealPath}/`));
  useEffect(() => {
    if (!revealPath || !revealRow) return;
    const fileViewer = useFileViewerStore.getState();
    // Too late to act on: the row may only now exist, and the user has moved on.
    if (Date.now() > revealExpiresAt) {
      fileViewer.clearFileTreeReveal(workspaceId, revealPath);
      return;
    }
    if (!showRows) {
      fileViewer.setImportedFilesCollapsed(workspaceId, false);
      return;
    }
    const rows = listRef.current?.querySelectorAll<HTMLElement>(`[${PATH_ATTRIBUTE}]`) ?? [];
    const row = [...rows].find((element) => element.getAttribute(PATH_ATTRIBUTE) === revealRow);
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
    fileViewer.clearFileTreeReveal(workspaceId, revealPath);
  }, [revealPath, revealExpiresAt, revealRow, showRows, workspaceId]);

  if (files.length === 0) return null;
  return (
    <section
      aria-label="Imported files"
      // A container, so a narrow panel (150px at least) gets the shorter label.
      className={cn(FILE_PANEL_SECTION_CLASS, '@container flex max-h-[35%] flex-col')}
    >
      <button
        type="button"
        onClick={() =>
          useFileViewerStore.getState().setImportedFilesCollapsed(workspaceId, !collapsed)
        }
        aria-expanded={showRows}
        aria-label="Imported files"
        // Matches show either way, so it would only change what shows after the search.
        disabled={isSearching}
        className={cn(
          FILE_PANEL_SECTION_HEADER_CLASS,
          'flex h-7 shrink-0 px-2 enabled:hover:text-foreground'
        )}
      >
        {showRows ? (
          <CaretDown className="size-3 shrink-0" />
        ) : (
          <CaretRight className="size-3 shrink-0" />
        )}
        <span className="truncate">
          Imported<span className="@max-[219px]:hidden"> files</span>
        </span>
        <span className={FILE_PANEL_SECTION_COUNT_CLASS}>{files.length}</span>
      </button>
      {showRows && (
        <ul ref={listRef} className="thin-scrollbar min-h-0 overflow-y-auto">
          {files.map((path) => (
            <ImportedFileRow
              key={path}
              path={path}
              isOpen={path === currentFile}
              focusOnMountPathRef={focusOnMountPathRef}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ImportedFileRow({
  path,
  isOpen,
  focusOnMountPathRef,
  actions,
}: {
  path: string;
  isOpen: boolean;
  focusOnMountPathRef: React.MutableRefObject<string | null>;
  actions: RowActions;
}) {
  const {
    workingDirectory,
    isRemoteWorkspace,
    onFileSelect,
    onDeleteFile,
    onRenameComplete,
    onCopyNode,
    onCutNode,
    onOpenInPane,
    onOpenHtmlInBrowser,
  } = actions;
  const label = path.slice(KOMLA_FILES_DIR.length + 1);
  const [renaming, setRenaming] = useState(false);
  // Set by the menu's Rename: the input can't take focus until the closing menu lets it go.
  const renameOnMenuCloseRef = useRef(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  // Set when a key ended the rename: the input takes focus with it, leaving it nowhere.
  const refocusAfterRenameRef = useRef(false);

  // A file opened from elsewhere, such as a terminal link, may be scrolled out of the list.
  useEffect(() => {
    if (isOpen) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isOpen]);

  useEffect(() => {
    if (focusOnMountPathRef.current !== path) return;
    focusOnMountPathRef.current = null;
    // Unless the user has moved on, as into a terminal, while the list caught up.
    if (document.activeElement === document.body) rowRef.current?.focus();
  }, [focusOnMountPathRef, path]);

  useEffect(() => {
    if (renaming || !refocusAfterRenameRef.current) return;
    refocusAfterRenameRef.current = false;
    rowRef.current?.focus();
  }, [renaming]);

  const fullPath = joinAbsPath(workingDirectory, path);
  const copyAtPath = () => {
    // Trailing space, as the tree's Copy @path, so the reference is ready for more text.
    window.api.copyToClipboard(`@${path} `);
    useToastStore.getState().addToast(`Copied @${path}`, 'success');
  };
  const openInDefaultApp = () => {
    void window.api.openPath(fullPath).catch((error: unknown) => {
      useToastStore
        .getState()
        .addToast(`Couldn't open ${label}: ${(error as Error).message}`, 'error');
    });
  };

  // As on a row in the tree, whose own handler ignores keys from outside it.
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    // A key held through the end of a rename repeats here, where Enter would open the file.
    if (event.repeat && (event.key === 'Enter' || event.key === 'Escape')) {
      event.preventDefault();
      claimShortcutEvent(event.nativeEvent);
      return;
    }
    const cmd = event.metaKey || event.ctrlKey;
    const isDelete =
      (event.key === 'Delete' || event.key === 'Backspace') &&
      !event.altKey &&
      (!cmd || (event.key === 'Backspace' && event.metaKey && !event.ctrlKey));
    const action = isDelete
      ? onDeleteFile && (() => onDeleteFile(path))
      : isRemoteWorkspace
        ? undefined
        : cmd && event.key === 'c'
          ? onCopyNode && (() => onCopyNode(path, false))
          : cmd && !event.shiftKey && event.key === 'x'
            ? onCutNode && (() => onCutNode(path, false))
            : undefined;
    if (!action) return;
    event.preventDefault();
    claimShortcutEvent(event.nativeEvent);
    action();
  };

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={renaming}>
          {renaming ? (
            <RenameInput
              path={path}
              onDone={(destination, endedByKey) => {
                // A renamed file's row goes away, so focus waits for the row of its new name.
                refocusAfterRenameRef.current = endedByKey && !destination;
                setRenaming(false);
                if (!destination) return;
                if (endedByKey) focusOnMountPathRef.current = destination;
                const stayedPut = () => {
                  if (focusOnMountPathRef.current !== destination) return;
                  focusOnMountPathRef.current = null;
                  rowRef.current?.focus();
                };
                void onRenameComplete?.(path, destination, false).then(
                  (renamed) => {
                    if (!renamed) stayedPut();
                  },
                  (error: unknown) => {
                    stayedPut();
                    useToastStore
                      .getState()
                      .addToast(`Failed to rename: ${(error as Error).message}`, 'error');
                  }
                );
              }}
            />
          ) : (
            <button
              ref={rowRef}
              type="button"
              {...{ [PATH_ATTRIBUTE]: path }}
              aria-current={isOpen ? 'true' : undefined}
              title={label}
              draggable
              onClick={() => onFileSelect(path)}
              onKeyDown={handleRowKeyDown}
              onDragStart={(event) => {
                // As a file dragged from the tree: a terminal pastes `@<path> `.
                event.dataTransfer.setData(AT_PATH_MIME, `@${path} `);
                event.dataTransfer.setData('text/plain', path);
                setTreeDragActive(true);
              }}
              onDragEnd={() => setTreeDragActive(false)}
              className={cn(
                FILE_PANEL_SECTION_ROW_CLASS,
                'items-center focus-visible:bg-muted/60 focus-visible:outline-hidden',
                isOpen
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <Paperclip className={FILE_PANEL_SECTION_ICON_CLASS} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            if (!renameOnMenuCloseRef.current) return;
            renameOnMenuCloseRef.current = false;
            event.preventDefault();
            setRenaming(true);
          }}
        >
          {onOpenInPane && (
            <>
              <ContextMenuItem onSelect={() => onOpenInPane(path, { kind: 'tab' })}>
                <AppWindow />
                Open in New Tab
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onOpenInPane(path, { kind: 'split', direction: 'vertical' })}
              >
                <SquareSplitHorizontal />
                Open in Split Right
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onOpenInPane(path, { kind: 'split', direction: 'horizontal' })}
              >
                <SquareSplitVertical />
                Open in Split Down
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={copyAtPath}>
            <Copy />
            Copy @path
          </ContextMenuItem>
          {!isRemoteWorkspace && onCopyNode && (
            <ContextMenuItem onSelect={() => onCopyNode(path, false)}>
              <Clipboard />
              Copy
            </ContextMenuItem>
          )}
          {!isRemoteWorkspace && onCutNode && (
            <ContextMenuItem onSelect={() => onCutNode(path, false)}>
              <Scissors />
              Cut
            </ContextMenuItem>
          )}
          {!isRemoteWorkspace && onRenameComplete && (
            <ContextMenuItem
              onSelect={() => {
                renameOnMenuCloseRef.current = true;
              }}
            >
              <PencilSimple />
              Rename
            </ContextMenuItem>
          )}
          {!isRemoteWorkspace && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => window.api.showItemInFolder(fullPath)}>
                <MagnifyingGlass />
                {getRevealInFileManagerLabel()}
              </ContextMenuItem>
              <ContextMenuItem onSelect={openInDefaultApp}>
                <ArrowSquareOut />
                Open in Default App
              </ContextMenuItem>
              {onOpenHtmlInBrowser && isBrowserPreviewableFile(path) && (
                <ContextMenuItem onSelect={() => onOpenHtmlInBrowser(path)}>
                  <Globe />
                  Open Browser Preview
                </ContextMenuItem>
              )}
            </>
          )}
          {onDeleteFile && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => onDeleteFile(path)}>
                <Trash />
                Delete File
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/** Edits the file's name in its folder, and reports where it should move: null for nowhere. */
function RenameInput({
  path,
  onDone,
}: {
  path: string;
  onDone: (destination: string | null, endedByKey: boolean) => void;
}) {
  const separator = path.lastIndexOf('/');
  const folder = path.slice(0, separator);
  const name = path.slice(separator + 1);
  const inputRef = useRef<HTMLInputElement>(null);
  // Removing the input blurs it, which mustn't commit a second time.
  const doneRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // The name without its extension, as a file manager selects it.
    const dot = name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);

  const commit = (endedByKey: boolean) => {
    const finish = (destination: string | null) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone(destination, endedByKey);
    };
    const next = inputRef.current?.value.trim() ?? '';
    if (!next || next === name) {
      finish(null);
      return;
    }
    // This renames in the folder; moving a file elsewhere is what Cut and Paste are for.
    if (next === '.' || next === '..' || /[\\/]/.test(next)) {
      useToastStore.getState().addToast(`"${next}" isn't a valid file name`, 'error');
      finish(null);
      return;
    }
    finish(`${folder}/${next}`);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={`Rename ${name}`}
      defaultValue={name}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        // A held key may be the one that chose Rename in the menu, not an answer to the input.
        if (event.repeat && (event.key === 'Enter' || event.key === 'Escape')) {
          event.preventDefault();
          claimShortcutEvent(event.nativeEvent);
          return;
        }
        // The input owns these keys, or Escape would also close the file preview beside the tree.
        if (event.key === 'Enter') {
          event.preventDefault();
          claimShortcutEvent(event.nativeEvent);
          commit(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          claimShortcutEvent(event.nativeEvent);
          doneRef.current = true;
          onDone(null, true);
        }
      }}
      className="mx-1 w-[calc(100%-8px)] rounded-md border border-input bg-card px-1.5 py-0.5 text-[13px] text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
    />
  );
}
