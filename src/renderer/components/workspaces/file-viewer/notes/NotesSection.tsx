import {
  CaretDown,
  CaretRight,
  Copy,
  MagnifyingGlass,
  NotePencil,
  Trash,
} from '@phosphor-icons/react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { formatRelativeTime } from '@/lib/format-time';
import { getNoteName, UNTITLED_NOTE } from '@/lib/notes';
import { showNote } from '@/lib/pane-surfaces';
import { getRevealInFileManagerLabel } from '@/lib/platform-labels';
import { cn } from '@/lib/utils';
import { useFileViewerStore } from '@/stores/file-viewer.store';
import { useNotes, useNotesStore } from '@/stores/notes.store';
import { useToastStore } from '@/stores/toast.store';

import {
  FILE_PANEL_SECTION_CLASS,
  FILE_PANEL_SECTION_COUNT_CLASS,
  FILE_PANEL_SECTION_HEADER_CLASS,
  FILE_PANEL_SECTION_ICON_CLASS,
  FILE_PANEL_SECTION_ROW_CLASS,
} from '../file-panel-section';

import type { NoteSummary } from '../../../../../shared/types/notes';

interface NotesSectionProps {
  workspaceId: string;
  /** The path open in the file panel, which is a note's path while a note is open. */
  currentFile: string | null;
}

/** The workspace's notes, below the file tree; hidden until there is one. */
export function NotesSection({ workspaceId, currentFile }: NotesSectionProps) {
  const notes = useNotes(workspaceId);
  const collapsed = useFileViewerStore((s) => !!s.notesCollapsedByWorkspace[workspaceId]);
  const openName = getNoteName(currentFile);
  if (notes.length === 0) return null;

  return (
    <section
      aria-label="Notes"
      className={cn(FILE_PANEL_SECTION_CLASS, 'flex max-h-[35%] flex-col')}
    >
      <button
        type="button"
        onClick={() => useFileViewerStore.getState().setNotesCollapsed(workspaceId, !collapsed)}
        aria-expanded={!collapsed}
        aria-label="Notes"
        className={cn(
          FILE_PANEL_SECTION_HEADER_CLASS,
          'flex h-7 shrink-0 px-2 hover:text-foreground'
        )}
      >
        {collapsed ? (
          <CaretRight className="size-3 shrink-0" />
        ) : (
          <CaretDown className="size-3 shrink-0" />
        )}
        <span className="truncate">Notes</span>
        <span className={FILE_PANEL_SECTION_COUNT_CLASS}>{notes.length}</span>
      </button>
      {!collapsed && (
        <ul className="thin-scrollbar min-h-0 overflow-y-auto">
          {notes.map((note) => (
            <NoteRow
              key={note.name}
              note={note}
              isOpen={note.name === openName}
              workspaceId={workspaceId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteRow({
  note,
  isOpen,
  workspaceId,
}: {
  note: NoteSummary;
  isOpen: boolean;
  workspaceId: string;
}) {
  const title = note.title || UNTITLED_NOTE;

  const toggle = () => {
    // A second click closes the note, as it does a file.
    if (isOpen) useFileViewerStore.getState().requestInlineFilePreviewClose(workspaceId);
    else showNote(workspaceId, note.name);
  };

  const copyPath = () => {
    window.api.copyToClipboard(note.path);
    useToastStore.getState().addToast(`Copied ${note.path}`, 'success');
  };

  const trash = async () => {
    try {
      await useNotesStore.getState().trash(workspaceId, note.name);
    } catch (error) {
      useToastStore
        .getState()
        .addToast(
          `Couldn't delete the note: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'error'
        );
      return;
    }
    if (isOpen) useFileViewerStore.getState().closeInlineFilePreview(workspaceId);
    useToastStore.getState().addToast(`Moved “${title}” to the trash`, 'success');
  };

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-current={isOpen ? 'true' : undefined}
            className={cn(
              FILE_PANEL_SECTION_ROW_CLASS,
              'items-center transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
              isOpen
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
            onClick={toggle}
          >
            <NotePencil className={FILE_PANEL_SECTION_ICON_CLASS} />
            <span className={cn('min-w-0 flex-1 truncate', !note.title && 'italic')}>{title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground-70 tabular-nums">
              {formatRelativeTime(note.modifiedMs)}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={copyPath}>
            <Copy />
            Copy Path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => window.api.showItemInFolder(note.path)}>
            <MagnifyingGlass />
            {getRevealInFileManagerLabel()}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => void trash()}>
            <Trash />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
