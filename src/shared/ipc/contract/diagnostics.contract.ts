import { IPC } from '../../constants/ipc-channels';
import { diagnosticsRendererStatsArgsSchema } from '../schemas/diagnostics-ipc.schemas';

import { send } from './define';

export const diagnosticsContract = {
  [IPC.DIAGNOSTICS_RENDERER_STATS]: send(diagnosticsRendererStatsArgsSchema),
} as const;
