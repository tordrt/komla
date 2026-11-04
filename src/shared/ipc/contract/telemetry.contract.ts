import { IPC } from '../../constants/ipc-channels';
import {
  telemetryTrackAgentSelectedArgsSchema,
  telemetryTrackSshHostAddedArgsSchema,
} from '../schemas/telemetry-ipc.schemas';

import { invoke } from './define';

export const telemetryContract = {
  [IPC.TELEMETRY_TRACK_AGENT_SELECTED]: invoke(
    telemetryTrackAgentSelectedArgsSchema
  ).returns<void>(),
  [IPC.TELEMETRY_TRACK_SSH_HOST_ADDED]: invoke(
    telemetryTrackSshHostAddedArgsSchema
  ).returns<void>(),
} as const;
