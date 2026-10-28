import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { actionService } from '../../services/action.service';
import {
  customizationService,
  ThemeConfig,
  TerminalConfig,
} from '../../services/customization.service';
import { shortcutsService, ShortcutsConfig } from '../../services/shortcuts.service';
import {
  customizationUpdateTerminalArgsSchema,
  customizationUpdateThemeArgsSchema,
  shortcutsUpdateArgsSchema,
  actionCreateArgsSchema,
  actionUpdateArgsSchema,
  actionReorderArgsSchema,
  actionDeleteArgsSchema,
  actionRecordUsageArgsSchema,
} from '../validation/config-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';

import type { Action } from '../../../shared/types';

export function registerCustomizationHandlers(): void {
  // Theme/terminal customization handlers
  ipcMain.handle(IPC.CUSTOMIZATION_GET_THEME, async (): Promise<ThemeConfig> => {
    return customizationService.getTheme();
  });

  ipcMain.handle(IPC.CUSTOMIZATION_GET_TERMINAL, async (): Promise<TerminalConfig> => {
    return customizationService.getTerminal();
  });

  ipcMain.handle(
    IPC.CUSTOMIZATION_UPDATE_THEME,
    handleValidated(
      IPC.CUSTOMIZATION_UPDATE_THEME,
      customizationUpdateThemeArgsSchema,
      async (_, [updates]): Promise<ThemeConfig> => {
        return customizationService.updateTheme(updates);
      }
    )
  );

  ipcMain.handle(
    IPC.CUSTOMIZATION_UPDATE_TERMINAL,
    handleValidated(
      IPC.CUSTOMIZATION_UPDATE_TERMINAL,
      customizationUpdateTerminalArgsSchema,
      async (_, [updates]): Promise<TerminalConfig> => {
        return customizationService.updateTerminal(updates);
      }
    )
  );

  ipcMain.handle(IPC.CUSTOMIZATION_RESET_THEME, async (): Promise<ThemeConfig> => {
    return customizationService.resetTheme();
  });

  // Shortcuts handlers
  ipcMain.handle(IPC.SHORTCUTS_GET, async (): Promise<ShortcutsConfig> => {
    return shortcutsService.getConfig();
  });

  ipcMain.handle(
    IPC.SHORTCUTS_UPDATE,
    handleValidated(
      IPC.SHORTCUTS_UPDATE,
      shortcutsUpdateArgsSchema,
      async (_, [updates]): Promise<ShortcutsConfig> => {
        return shortcutsService.updateConfig(updates);
      }
    )
  );

  ipcMain.handle(IPC.SHORTCUTS_RESET, async (): Promise<ShortcutsConfig> => {
    return shortcutsService.resetConfig();
  });

  // Action handlers
  ipcMain.handle(IPC.ACTION_LIST, async (): Promise<Action[]> => {
    return actionService.list();
  });

  ipcMain.handle(
    IPC.ACTION_CREATE,
    handleValidated(
      IPC.ACTION_CREATE,
      actionCreateArgsSchema,
      async (_, [params]): Promise<Action> => {
        return actionService.create(params);
      }
    )
  );

  ipcMain.handle(
    IPC.ACTION_UPDATE,
    handleValidated(
      IPC.ACTION_UPDATE,
      actionUpdateArgsSchema,
      async (_, [id, updates]): Promise<Action> => {
        return actionService.update(id, updates);
      }
    )
  );

  ipcMain.handle(
    IPC.ACTION_REORDER,
    handleValidated(
      IPC.ACTION_REORDER,
      actionReorderArgsSchema,
      async (_, [id, newOrder]): Promise<void> => {
        actionService.reorder(id, newOrder);
      }
    )
  );

  ipcMain.handle(
    IPC.ACTION_DELETE,
    handleValidated(IPC.ACTION_DELETE, actionDeleteArgsSchema, async (_, [id]): Promise<void> => {
      actionService.delete(id);
    })
  );

  ipcMain.handle(
    IPC.ACTION_RECORD_USAGE,
    handleValidated(
      IPC.ACTION_RECORD_USAGE,
      actionRecordUsageArgsSchema,
      async (_, [params]): Promise<Action> => {
        return actionService.recordUsage(params.id, params.userInput, params.pasted);
      }
    )
  );
}
