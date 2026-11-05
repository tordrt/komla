import { IPC } from '../../../shared/constants/ipc-channels';
import { notesService } from '../../services/notes.service';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

import type { NoteSummary } from '../../../shared/types/notes';

function watchNotes(): void {
  notesService.watch((scopeId) => windowService.broadcastToAll(IPC.NOTES_CHANGED, scopeId));
}

export function registerNotesHandlers(): void {
  handleIpc(IPC.NOTES_LIST, (_, [scopeId]): Promise<NoteSummary[]> => {
    // Watch from the first listing, so notes nobody opens cost nothing.
    watchNotes();
    return notesService.list(scopeId);
  });

  handleIpc(IPC.NOTES_CREATE, (_, [scopeId, content]): Promise<NoteSummary> => {
    watchNotes();
    return notesService.create(scopeId, content);
  });

  handleIpc(IPC.NOTES_READ, (_, [scopeId, name]): Promise<string> =>
    notesService.read(scopeId, name)
  );

  handleIpc(IPC.NOTES_WRITE, (_, [scopeId, name, content]): Promise<void> =>
    notesService.write(scopeId, name, content)
  );

  handleIpc(IPC.NOTES_TRASH, (_, [scopeId, name]): Promise<void> =>
    notesService.trash(scopeId, name)
  );

  handleIpc(IPC.NOTES_DELETE, (_, [scopeId, name, onlyIfBlank]): Promise<boolean> =>
    notesService.delete(scopeId, name, { onlyIfBlank })
  );
}
