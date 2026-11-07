import { IPC } from '../../../shared/constants/ipc-channels';
import {
  describeSetupStepsUsingAction,
  setupStepsUsingAction,
} from '../../../shared/lib/action-references';
import { actionService } from '../../services/action.service';
import {
  customizationService,
  ThemeConfig,
  TerminalConfig,
} from '../../services/customization.service';
import { projectService } from '../../services/project.service';
import { shortcutsService, ShortcutsConfig } from '../../services/shortcuts.service';
import { handleIpc } from '../validation/ipc-validators';

import type { Action } from '../../../shared/types';

export function registerCustomizationHandlers(): void {
  // Theme/terminal customization handlers
  handleIpc(IPC.CUSTOMIZATION_GET_THEME, async (): Promise<ThemeConfig> => {
    return customizationService.getTheme();
  });

  handleIpc(IPC.CUSTOMIZATION_GET_TERMINAL, async (): Promise<TerminalConfig> => {
    return customizationService.getTerminal();
  });

  handleIpc(IPC.CUSTOMIZATION_UPDATE_THEME, async (_, [updates]): Promise<ThemeConfig> => {
    return customizationService.updateTheme(updates);
  });

  handleIpc(IPC.CUSTOMIZATION_UPDATE_TERMINAL, async (_, [updates]): Promise<TerminalConfig> => {
    return customizationService.updateTerminal(updates);
  });

  handleIpc(IPC.CUSTOMIZATION_RESET_THEME, async (): Promise<ThemeConfig> => {
    return customizationService.resetTheme();
  });

  // Shortcuts handlers
  handleIpc(IPC.SHORTCUTS_GET, async (): Promise<ShortcutsConfig> => {
    return shortcutsService.getConfig();
  });

  handleIpc(IPC.SHORTCUTS_UPDATE, async (_, [updates]): Promise<ShortcutsConfig> => {
    return shortcutsService.updateConfig(updates);
  });

  handleIpc(IPC.SHORTCUTS_RESET, async (): Promise<ShortcutsConfig> => {
    return shortcutsService.resetConfig();
  });

  // Action handlers
  handleIpc(IPC.ACTION_LIST, async (): Promise<Action[]> => {
    return actionService.list();
  });

  handleIpc(IPC.ACTION_CREATE, async (_, [params]): Promise<Action> => {
    return actionService.create(params);
  });

  handleIpc(IPC.ACTION_UPDATE, async (_, [id, updates]): Promise<Action> => {
    return actionService.update(id, updates);
  });

  handleIpc(IPC.ACTION_DELETE, async (_, [id]): Promise<void> => {
    const usages = setupStepsUsingAction(projectService.list(), id);
    if (usages.length) {
      throw new Error(
        `Workspace Setup runs this quick command: ${describeSetupStepsUsingAction(usages)}`
      );
    }
    actionService.delete(id);
  });

  handleIpc(IPC.ACTION_RECORD_USAGE, async (_, [params]): Promise<Action> => {
    return actionService.recordUsage(params.id, params.userInput, params.pasted);
  });
}
