import { IPC } from '../../constants/ipc-channels';
import { soundsGetDataUrlArgsSchema } from '../schemas/sounds-ipc.schemas';

import { invoke } from './define';

export const soundsContract = {
  [IPC.SOUNDS_LIST_CUSTOM]: invoke().returns<string[]>(),
  [IPC.SOUNDS_GET_DATA_URL]: invoke(soundsGetDataUrlArgsSchema).returns<string | null>(),
  [IPC.SOUNDS_OPEN_DIRECTORY]: invoke().returns<void>(),
} as const;
