import { BrowserWindow } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { toastOverlayService } from '../../services/toast-overlay.service';
import { onIpc } from '../validation/ipc-validators';

export function registerToastOverlayHandlers(): void {
  onIpc(IPC.TOAST_OVERLAY_SHOW, (event, [state]) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return;
    toastOverlayService.show(owner, state);
  });

  onIpc(IPC.TOAST_OVERLAY_HIDE, (event) => {
    toastOverlayService.hide(event.sender.id);
  });

  // Sent by the overlay page itself; the service relays it to the window that owns the overlay.
  onIpc(IPC.TOAST_OVERLAY_EVENT, (event, [toastEvent]) => {
    toastOverlayService.forwardEvent(event.sender.id, toastEvent);
  });

  onIpc(IPC.TOAST_OVERLAY_POINTER_UP, (event) => {
    toastOverlayService.releaseFocus(event.sender.id);
  });
}
