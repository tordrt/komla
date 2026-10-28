import { BrowserWindow, ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { toastOverlayService } from '../../services/toast-overlay.service';
import { onValidated } from '../validation/ipc-validators';
import {
  toastOverlayEventArgsSchema,
  toastOverlayHideArgsSchema,
  toastOverlayPointerUpArgsSchema,
  toastOverlayShowArgsSchema,
} from '../validation/toast-overlay-ipc.schemas';

export function registerToastOverlayHandlers(): void {
  ipcMain.on(
    IPC.TOAST_OVERLAY_SHOW,
    onValidated(IPC.TOAST_OVERLAY_SHOW, toastOverlayShowArgsSchema, (event, [state]) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) return;
      toastOverlayService.show(owner, state);
    })
  );

  ipcMain.on(
    IPC.TOAST_OVERLAY_HIDE,
    onValidated(IPC.TOAST_OVERLAY_HIDE, toastOverlayHideArgsSchema, (event) => {
      toastOverlayService.hide(event.sender.id);
    })
  );

  // Sent by the overlay page itself; the service relays it to the window that owns the overlay.
  ipcMain.on(
    IPC.TOAST_OVERLAY_EVENT,
    onValidated(IPC.TOAST_OVERLAY_EVENT, toastOverlayEventArgsSchema, (event, [toastEvent]) => {
      toastOverlayService.forwardEvent(event.sender.id, toastEvent);
    })
  );

  ipcMain.on(
    IPC.TOAST_OVERLAY_POINTER_UP,
    onValidated(IPC.TOAST_OVERLAY_POINTER_UP, toastOverlayPointerUpArgsSchema, (event) => {
      toastOverlayService.releaseFocus(event.sender.id);
    })
  );
}
