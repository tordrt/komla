import { IPC } from '../../constants/ipc-channels';
import { askpassResponseArgsSchema } from '../schemas/askpass-ipc.schemas';

import { send } from './define';

export const askpassContract = {
  [IPC.ASKPASS_RESPONSE]: send(askpassResponseArgsSchema),
} as const;
