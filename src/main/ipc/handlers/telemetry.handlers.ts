import { IPC } from '../../../shared/constants/ipc-channels';
import { telemetryService } from '../../services/telemetry.service';
import { handleIpc } from '../validation/ipc-validators';

export function registerTelemetryHandlers(): void {
  // Null unless the user opted in to usage analytics — the ID links checkout
  // to in-app activity, which is only done with consent.
  handleIpc(IPC.TELEMETRY_GET_DISTINCT_ID, async (): Promise<string | null> => {
    return telemetryService.getDistinctId();
  });

  handleIpc(IPC.TELEMETRY_TRACK_MONETIZATION, (_, [event, props]): void => {
    telemetryService.sendMonetizationEvent(event, props);
  });

  handleIpc(IPC.TELEMETRY_TRACK_AGENT_SELECTED, (_, [agent]): void => {
    telemetryService.sendAgentSelected(agent);
  });

  handleIpc(IPC.TELEMETRY_TRACK_SSH_HOST_ADDED, (_, [source]): void => {
    telemetryService.sendSshHostAdded(source);
  });
}
