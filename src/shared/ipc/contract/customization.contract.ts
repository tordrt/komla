import { IPC } from '../../constants/ipc-channels';
import {
  customizationUpdateThemeArgsSchema,
  customizationUpdateTerminalArgsSchema,
  shortcutsUpdateArgsSchema,
  actionCreateArgsSchema,
  actionUpdateArgsSchema,
  actionDeleteArgsSchema,
  actionRecordUsageArgsSchema,
} from '../schemas/config-ipc.schemas';

import { invoke } from './define';

import type { ShortcutsConfig } from '../../../renderer/types';
import type { Action } from '../../types/action';
import type { TerminalConfig, ThemeConfig } from '../../types/customization';

export const customizationContract = {
  [IPC.CUSTOMIZATION_GET_THEME]: invoke().returns<ThemeConfig>(),
  [IPC.CUSTOMIZATION_GET_TERMINAL]: invoke().returns<TerminalConfig>(),
  [IPC.CUSTOMIZATION_UPDATE_THEME]: invoke(
    customizationUpdateThemeArgsSchema
  ).returns<ThemeConfig>(),
  [IPC.CUSTOMIZATION_UPDATE_TERMINAL]: invoke(
    customizationUpdateTerminalArgsSchema
  ).returns<TerminalConfig>(),
  [IPC.CUSTOMIZATION_RESET_THEME]: invoke().returns<ThemeConfig>(),
  [IPC.SHORTCUTS_GET]: invoke().returns<ShortcutsConfig>(),
  [IPC.SHORTCUTS_UPDATE]: invoke(shortcutsUpdateArgsSchema).returns<ShortcutsConfig>(),
  [IPC.SHORTCUTS_RESET]: invoke().returns<ShortcutsConfig>(),
  [IPC.ACTION_LIST]: invoke().returns<Action[]>(),
  [IPC.ACTION_CREATE]: invoke(actionCreateArgsSchema).returns<Action>(),
  [IPC.ACTION_UPDATE]: invoke(actionUpdateArgsSchema).returns<Action>(),
  [IPC.ACTION_DELETE]: invoke(actionDeleteArgsSchema).returns<void>(),
  [IPC.ACTION_RECORD_USAGE]: invoke(actionRecordUsageArgsSchema).returns<Action>(),
} as const;
