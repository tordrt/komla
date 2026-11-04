import { IPC } from '../../../shared/constants/ipc-channels';
import { telemetryService } from '../../services/telemetry.service';
import { handleIpc } from '../validation/ipc-validators';

export function registerTelemetryHandlers(): void {
  handleIpc(IPC.TELEMETRY_TRACK_AGENT_SELECTED, (_, [agent]): void => {
    telemetryService.sendAgentSelected(agent);
  });

  handleIpc(IPC.TELEMETRY_TRACK_SSH_HOST_ADDED, (_, [source]): void => {
    telemetryService.sendSshHostAdded(source);
  });
}
