import { IPC } from '../../constants/ipc-channels';
import {
  telemetryTrackMonetizationArgsSchema,
  telemetryTrackAgentSelectedArgsSchema,
  telemetryTrackSshHostAddedArgsSchema,
} from '../schemas/telemetry-ipc.schemas';

import { invoke } from './define';

export const telemetryContract = {
  [IPC.TELEMETRY_GET_DISTINCT_ID]: invoke().returns<string | null>(),
  [IPC.TELEMETRY_TRACK_MONETIZATION]: invoke(telemetryTrackMonetizationArgsSchema).returns<void>(),
  [IPC.TELEMETRY_TRACK_AGENT_SELECTED]: invoke(
    telemetryTrackAgentSelectedArgsSchema
  ).returns<void>(),
  [IPC.TELEMETRY_TRACK_SSH_HOST_ADDED]: invoke(
    telemetryTrackSshHostAddedArgsSchema
  ).returns<void>(),
} as const;
