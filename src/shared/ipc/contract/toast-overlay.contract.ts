import { IPC } from '../../constants/ipc-channels';
import {
  toastOverlayShowArgsSchema,
  toastOverlayEventArgsSchema,
} from '../schemas/toast-overlay-ipc.schemas';

import { send } from './define';

export const toastOverlayContract = {
  [IPC.TOAST_OVERLAY_SHOW]: send(toastOverlayShowArgsSchema),
  [IPC.TOAST_OVERLAY_HIDE]: send(),
  [IPC.TOAST_OVERLAY_EVENT]: send(toastOverlayEventArgsSchema),
  [IPC.TOAST_OVERLAY_POINTER_UP]: send(),
} as const;
