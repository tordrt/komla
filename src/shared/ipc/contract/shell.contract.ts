import { IPC } from '../../constants/ipc-channels';
import {
  shellOpenExternalArgsSchema,
  shellPathArgsSchema,
  shellOpenInEditorArgsSchema,
} from '../schemas/config-ipc.schemas';

import { invoke } from './define';

export const shellContract = {
  [IPC.SHELL_OPEN_EXTERNAL]: invoke(shellOpenExternalArgsSchema).returns<void>(),
  [IPC.SHELL_SHOW_ITEM_IN_FOLDER]: invoke(shellPathArgsSchema).returns<void>(),
  [IPC.SHELL_OPEN_PATH]: invoke(shellPathArgsSchema).returns<void>(),
  [IPC.SHELL_GET_AVAILABLE_EDITORS]: invoke().returns<{ id: string; name: string }[]>(),
  [IPC.SHELL_OPEN_IN_EDITOR]: invoke(shellOpenInEditorArgsSchema).returns<void>(),
  [IPC.SHELL_GET_WSL_DISTROS]: invoke().returns<string[]>(),
} as const;
