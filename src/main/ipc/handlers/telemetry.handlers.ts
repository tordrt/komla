import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { createLogger } from '../../lib/logger';
import { telemetryService } from '../../services/telemetry.service';
import { handleValidated } from '../validation/ipc-validators';
import { telemetryTrackSshHostAddedArgsSchema } from '../validation/telemetry-ipc.schemas';

const logger = createLogger('TelemetryHandlers');

type MonetizationTelemetryEvent = 'free_limit_hit' | 'upgrade_clicked' | 'license_activated';

const MONETIZATION_EVENTS = new Set<MonetizationTelemetryEvent>([
  'free_limit_hit',
  'upgrade_clicked',
  'license_activated',
]);

export function registerTelemetryHandlers(): void {
  // Null unless the user opted in to usage analytics — the ID links checkout
  // to in-app activity, which is only done with consent.
  ipcMain.handle(IPC.TELEMETRY_GET_DISTINCT_ID, async (): Promise<string | null> => {
    return telemetryService.getDistinctId();
  });

  ipcMain.handle(
    IPC.TELEMETRY_TRACK_MONETIZATION,
    async (
      _,
      event: MonetizationTelemetryEvent,
      props?: {
        source?: 'create_workspace' | 'start_workspace' | 'free_limit_wall';
        limit?: number;
        runningCount?: number;
      }
    ): Promise<void> => {
      if (!MONETIZATION_EVENTS.has(event)) {
        logger.warn('Dropping unknown monetization event', { event });
        return;
      }
      telemetryService.sendMonetizationEvent(event, props);
    }
  );

  ipcMain.handle(IPC.TELEMETRY_TRACK_AGENT_SELECTED, async (_, agent: string): Promise<void> => {
    if (typeof agent !== 'string' || !agent.trim()) {
      logger.warn('Dropping agent-selected event with invalid agent name');
      return;
    }
    telemetryService.sendAgentSelected(agent.trim());
  });

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
