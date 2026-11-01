import { IPC } from '../../constants/ipc-channels';
import {
  toastOverlayShowArgsSchema,
  toastOverlayHideArgsSchema,
  toastOverlayEventArgsSchema,
  toastOverlayPointerUpArgsSchema,
} from '../schemas/toast-overlay-ipc.schemas';

import { send } from './define';

export const toastOverlayContract = {
  [IPC.TOAST_OVERLAY_SHOW]: send(toastOverlayShowArgsSchema),
  [IPC.TOAST_OVERLAY_HIDE]: send(toastOverlayHideArgsSchema),
  [IPC.TOAST_OVERLAY_EVENT]: send(toastOverlayEventArgsSchema),
  [IPC.TOAST_OVERLAY_POINTER_UP]: send(toastOverlayPointerUpArgsSchema),
} as const;
