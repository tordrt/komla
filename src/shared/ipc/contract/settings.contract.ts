import { IPC } from '../../constants/ipc-channels';
import {
  settingsApprovalRequestPendingArgsSchema,
  settingsApprovalResolveArgsSchema,
  settingsHistoryListArgsSchema,
  settingsHistoryRevertArgsSchema,
} from '../schemas/settings-ipc.schemas';

import { invoke } from './define';

import type { SettingsHistoryEntry } from '../../types/settings-history';

export const settingsContract = {
  [IPC.SETTINGS_APPROVAL_REQUEST_PENDING]: invoke(
    settingsApprovalRequestPendingArgsSchema
  ).returns<boolean>(),
  [IPC.SETTINGS_APPROVAL_RESOLVE]: invoke(settingsApprovalResolveArgsSchema).returns<boolean>(),
  [IPC.SETTINGS_HISTORY_LIST]: invoke(settingsHistoryListArgsSchema).returns<
    SettingsHistoryEntry[]
  >(),
  [IPC.SETTINGS_HISTORY_REVERT]: invoke(
    settingsHistoryRevertArgsSchema
  ).returns<SettingsHistoryEntry>(),
} as const;
