import { NotePencil, Plus } from '@phosphor-icons/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatRelativeTime } from '@/lib/format-time';
import { createNote, openNote, UNTITLED_NOTE } from '@/lib/notes';
import { cn } from '@/lib/utils';
import { useNotes } from '@/stores/notes.store';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { StatusBarButton } from './StatusBarButton';
import { workspaceLabel } from './StatusBarWorkspaceRow';

/** Starts a note in the open workspace, and lists the workspace's notes. */
export function NotesStatusSegment() {
  const workspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
  );
  const notes = useNotes(workspace?.id ?? null);
  const newNoteShortcut = useShortcutsStore((s) => s.getDisplayShortcut('note.new'));
  if (!workspace) return null;
  const count = notes.length === 1 ? '1 note' : `${notes.length} notes`;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <StatusBarButton
          aria-label={notes.length > 0 ? `Notes, ${count}` : 'Notes'}
          tooltip="Notes for this workspace"
        >
          <NotePencil aria-hidden="true" className="size-3.5" />
          {notes.length > 0 && <span className="tabular-nums">{notes.length}</span>}
        </StatusBarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuLabel className="truncate">
          Notes in {workspaceLabel(workspace)}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void createNote(workspace.id)}>
          <Plus />
          New note
          {newNoteShortcut && <DropdownMenuShortcut>{newNoteShortcut}</DropdownMenuShortcut>}
        </DropdownMenuItem>
        {notes.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup className="thin-scrollbar max-h-80 overflow-y-auto">
              {notes.map((note) => (
                <DropdownMenuItem
                  key={note.name}
                  onSelect={() => openNote(workspace.id, note.name)}
                >
                  <NotePencil />
                  <span className={cn('min-w-0 flex-1 truncate', !note.title && 'italic')}>
                    {note.title || UNTITLED_NOTE}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                    {formatRelativeTime(note.modifiedMs)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : (
          <p className="px-2 py-1 text-2xs text-muted-foreground">
            Markdown for drafting prompts and taking notes, kept outside the repository. Deleting
            the workspace moves its notes to the trash.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
