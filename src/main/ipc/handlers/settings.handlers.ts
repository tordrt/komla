import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import {
  settingsApprovalRequestPendingArgsSchema,
  settingsApprovalResolveArgsSchema,
  settingsHistoryListArgsSchema,
  settingsHistoryRevertArgsSchema,
} from '../../../shared/ipc/schemas/settings-ipc.schemas';
import { settingsApprovalService } from '../../services/settings-approval.service';
import { settingsHistoryService } from '../../services/settings-history.service';
import { windowService } from '../../services/window.service';
import { handleValidated } from '../validation/ipc-validators';

import type { SettingsHistoryEntry } from '../../../shared/types/settings-history';

export function registerSettingsHandlers(): void {
  ipcMain.handle(
    IPC.SETTINGS_APPROVAL_REQUEST_PENDING,
    handleValidated(
      IPC.SETTINGS_APPROVAL_REQUEST_PENDING,
      settingsApprovalRequestPendingArgsSchema,
      async (event): Promise<boolean> => {
        return settingsApprovalService.requestPending(event.sender.id);
      }
    )
  );

  ipcMain.handle(
    IPC.SETTINGS_APPROVAL_RESOLVE,
    handleValidated(
      IPC.SETTINGS_APPROVAL_RESOLVE,
      settingsApprovalResolveArgsSchema,
      async (event, [id, decision]): Promise<boolean> => {
        return settingsApprovalService.resolve(id, decision, event.sender.id);
      }
    )
  );

  settingsHistoryService.onChange(() => windowService.broadcastToAll(IPC.SETTINGS_HISTORY_CHANGED));

  ipcMain.handle(
    IPC.SETTINGS_HISTORY_LIST,
    handleValidated(
      IPC.SETTINGS_HISTORY_LIST,
      settingsHistoryListArgsSchema,
      (): SettingsHistoryEntry[] => settingsHistoryService.list()
    )
  );

  ipcMain.handle(
    IPC.SETTINGS_HISTORY_REVERT,
    handleValidated(
      IPC.SETTINGS_HISTORY_REVERT,
      settingsHistoryRevertArgsSchema,
      (_, [id]): SettingsHistoryEntry => settingsHistoryService.revert(id)
    )
  );
}
