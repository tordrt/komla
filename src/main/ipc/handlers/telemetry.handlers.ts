import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import {
  telemetryTrackAgentSelectedArgsSchema,
  telemetryTrackMonetizationArgsSchema,
  telemetryTrackSshHostAddedArgsSchema,
} from '../../../shared/ipc/schemas/telemetry-ipc.schemas';
import { telemetryService } from '../../services/telemetry.service';
import { handleValidated } from '../validation/ipc-validators';

export function registerTelemetryHandlers(): void {
  // Null unless the user opted in to usage analytics — the ID links checkout
  // to in-app activity, which is only done with consent.
  ipcMain.handle(IPC.TELEMETRY_GET_DISTINCT_ID, async (): Promise<string | null> => {
    return telemetryService.getDistinctId();
  });

  ipcMain.handle(
    IPC.TELEMETRY_TRACK_MONETIZATION,
    handleValidated(
      IPC.TELEMETRY_TRACK_MONETIZATION,
      telemetryTrackMonetizationArgsSchema,
      (_, [event, props]): void => {
        telemetryService.sendMonetizationEvent(event, props);
      }
    )
  );

  ipcMain.handle(
    IPC.TELEMETRY_TRACK_AGENT_SELECTED,
    handleValidated(
      IPC.TELEMETRY_TRACK_AGENT_SELECTED,
      telemetryTrackAgentSelectedArgsSchema,
      (_, [agent]): void => {
        telemetryService.sendAgentSelected(agent);
      }
    )
  );

  ipcMain.handle(
    IPC.TELEMETRY_TRACK_SSH_HOST_ADDED,
    handleValidated(
      IPC.TELEMETRY_TRACK_SSH_HOST_ADDED,
      telemetryTrackSshHostAddedArgsSchema,
      (_, [source]): void => {
        telemetryService.sendSshHostAdded(source);
      }
    )
  );
}
