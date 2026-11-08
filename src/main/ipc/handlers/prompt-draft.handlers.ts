import { IPC } from '../../../shared/constants/ipc-channels';
import { promptDraftWindowService } from '../../services/prompt-draft-window.service';
import { windowService } from '../../services/window.service';
import { handleIpc, onIpc } from '../validation/ipc-validators';

import type { IpcMainEvent } from 'electron';

/** The Komla window that sent it; undefined from the draft's page or a preview. */
function senderWindowId(event: { sender: { id: number } }): string | undefined {
  return windowService.getWindowId(event.sender.id);
}

function fromPage(event: IpcMainEvent): boolean {
  return promptDraftWindowService.isPage(event.sender.id);
}

export function registerPromptDraftHandlers(): void {
  onIpc(IPC.PROMPT_DRAFT_POP_OUT, (event, [draft, rect]) => {
    const windowId = senderWindowId(event);
    if (windowId) promptDraftWindowService.popOut(windowId, draft, rect);
  });

  onIpc(IPC.PROMPT_DRAFT_SHOW, (event) => {
    if (senderWindowId(event)) promptDraftWindowService.show();
  });

  onIpc(IPC.PROMPT_DRAFT_HIDE, (event) => {
    if (senderWindowId(event)) promptDraftWindowService.hide();
  });

  handleIpc(IPC.PROMPT_DRAFT_STATUS_REQUEST, () => promptDraftWindowService.getStatus());

  onIpc(IPC.PROMPT_DRAFT_CONTEXT, (event, [context]) => {
    const windowId = senderWindowId(event);
    if (windowId) promptDraftWindowService.setContext(windowId, context);
  });

  onIpc(IPC.PROMPT_DRAFT_REFERENCE, (event, [reference]) => {
    const windowId = senderWindowId(event);
    if (windowId) promptDraftWindowService.receiveReference(windowId, reference);
  });

  onIpc(IPC.PROMPT_DRAFT_NOTE_SAVED, (event, [saved]) => {
    const windowId = senderWindowId(event);
    if (windowId) promptDraftWindowService.receiveNoteSaved(windowId, saved);
  });

  onIpc(IPC.PROMPT_DRAFT_WINDOW_STATE_REQUEST, (event) => {
    if (fromPage(event)) promptDraftWindowService.sendState();
  });

  onIpc(IPC.PROMPT_DRAFT_WINDOW_READY, (event) => {
    if (fromPage(event)) promptDraftWindowService.pageReady();
  });

  onIpc(IPC.PROMPT_DRAFT_WINDOW_TEXT, (event, [draft]) => {
    if (fromPage(event)) promptDraftWindowService.setText(draft);
  });

  onIpc(IPC.PROMPT_DRAFT_WINDOW_REQUEST_REFERENCE, (event) => {
    if (fromPage(event)) promptDraftWindowService.requestReference();
  });

  onIpc(IPC.PROMPT_DRAFT_WINDOW_SAVE_AS_NOTE, (event, [text]) => {
    if (fromPage(event)) promptDraftWindowService.saveAsNote(text);
  });

  onIpc(IPC.PROMPT_DRAFT_WINDOW_CLOSE, (event, [options]) => {
    if (fromPage(event)) promptDraftWindowService.close(options);
  });

  onIpc(IPC.PROMPT_DRAFT_WINDOW_POP_IN, (event, [draft]) => {
    if (fromPage(event)) promptDraftWindowService.popIn(draft);
  });
}
