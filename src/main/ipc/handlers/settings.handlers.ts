import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { httpServerService } from '../../services/http-server.service';
import { settingsHistoryService } from '../../services/settings-history.service';
import { windowService } from '../../services/window.service';
import { handleValidated } from '../validation/ipc-validators';
import {
  settingsApprovalRequestPendingArgsSchema,
  settingsApprovalResolveArgsSchema,
  settingsHistoryListArgsSchema,
  settingsHistoryRevertArgsSchema,
} from '../validation/settings-ipc.schemas';

import type { SettingsHistoryEntry } from '../../../shared/types/settings-history';

export function registerSettingsHandlers(): void {
  ipcMain.handle(
    IPC.SETTINGS_APPROVAL_REQUEST_PENDING,
    handleValidated(
      IPC.SETTINGS_APPROVAL_REQUEST_PENDING,
      settingsApprovalRequestPendingArgsSchema,
      async (event): Promise<boolean> => {
        return httpServerService.requestPendingSettingsApproval(event.sender.id);
      }
    )
  );

  ipcMain.handle(
    IPC.SETTINGS_APPROVAL_RESOLVE,
    handleValidated(
      IPC.SETTINGS_APPROVAL_RESOLVE,
      settingsApprovalResolveArgsSchema,
      async (event, [id, decision]): Promise<boolean> => {
        return httpServerService.resolveSettingsApproval(id, decision, event.sender.id);
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
