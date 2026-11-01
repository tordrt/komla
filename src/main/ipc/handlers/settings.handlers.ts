import { IPC } from '../../../shared/constants/ipc-channels';
import { settingsApprovalService } from '../../services/settings-approval.service';
import { settingsHistoryService } from '../../services/settings-history.service';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

import type { SettingsHistoryEntry } from '../../../shared/types/settings-history';

export function registerSettingsHandlers(): void {
  handleIpc(IPC.SETTINGS_APPROVAL_REQUEST_PENDING, async (event): Promise<boolean> => {
    return settingsApprovalService.requestPending(event.sender.id);
  });

  handleIpc(IPC.SETTINGS_APPROVAL_RESOLVE, async (event, [id, decision]): Promise<boolean> => {
    return settingsApprovalService.resolve(id, decision, event.sender.id);
  });

  settingsHistoryService.onChange(() => windowService.broadcastToAll(IPC.SETTINGS_HISTORY_CHANGED));

  handleIpc(IPC.SETTINGS_HISTORY_LIST, (): SettingsHistoryEntry[] => settingsHistoryService.list());

  handleIpc(IPC.SETTINGS_HISTORY_REVERT, (_, [id]): SettingsHistoryEntry =>
    settingsHistoryService.revert(id)
  );
}
