import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { notesService } from '../../services/notes.service';
import { windowService } from '../../services/window.service';
import { handleValidated } from '../validation/ipc-validators';
import {
  noteArgsSchema,
  noteDeleteArgsSchema,
  noteWriteArgsSchema,
  notesScopeArgsSchema,
} from '../validation/notes-ipc.schemas';

import type { NoteSummary } from '../../../shared/types/notes';

function watchNotes(): void {
  notesService.watch((scopeId) => windowService.broadcastToAll(IPC.NOTES_CHANGED, scopeId));
}

export function registerNotesHandlers(): void {
  ipcMain.handle(
    IPC.NOTES_LIST,
    handleValidated(
      IPC.NOTES_LIST,
      notesScopeArgsSchema,
      (_, [scopeId]): Promise<NoteSummary[]> => {
        // Watch from the first listing, so notes nobody opens cost nothing.
        watchNotes();
        return notesService.list(scopeId);
      }
    )
  );

  ipcMain.handle(
    IPC.NOTES_CREATE,
    handleValidated(
      IPC.NOTES_CREATE,
      notesScopeArgsSchema,
      (_, [scopeId]): Promise<NoteSummary> => {
        watchNotes();
        return notesService.create(scopeId);
      }
    )
  );

  ipcMain.handle(
    IPC.NOTES_READ,
    handleValidated(IPC.NOTES_READ, noteArgsSchema, (_, [scopeId, name]): Promise<string> =>
      notesService.read(scopeId, name)
    )
  );

  ipcMain.handle(
    IPC.NOTES_WRITE,
    handleValidated(
      IPC.NOTES_WRITE,
      noteWriteArgsSchema,
      (_, [scopeId, name, content]): Promise<void> => notesService.write(scopeId, name, content)
    )
  );

  ipcMain.handle(
    IPC.NOTES_TRASH,
    handleValidated(IPC.NOTES_TRASH, noteArgsSchema, (_, [scopeId, name]): Promise<void> =>
      notesService.trash(scopeId, name)
    )
  );

  ipcMain.handle(
    IPC.NOTES_DELETE,
    handleValidated(
      IPC.NOTES_DELETE,
      noteDeleteArgsSchema,
      (_, [scopeId, name, onlyIfBlank]): Promise<boolean> =>
        notesService.delete(scopeId, name, { onlyIfBlank })
    )
  );
}
