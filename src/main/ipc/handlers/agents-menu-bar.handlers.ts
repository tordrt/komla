import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { agentsMenuBarService } from '../../services/agents-menu-bar.service';
import { windowService } from '../../services/window.service';
import {
  agentsMenuBarCloseArgsSchema,
  agentsMenuBarImageArgsSchema,
  agentsMenuBarOpenArgsSchema,
  agentsMenuBarResizeArgsSchema,
  agentsMenuBarStateRequestArgsSchema,
  agentsMenuBarThemeArgsSchema,
} from '../validation/agents-menu-bar-ipc.schemas';
import { onValidated } from '../validation/ipc-validators';

import type { IpcMainEvent } from 'electron';

/** Sent by one of Komla's own windows, not the popover or a preview. */
function fromKomlaWindow(event: IpcMainEvent): boolean {
  return windowService.getWindowId(event.sender.id) !== undefined;
}

function fromPopover(event: IpcMainEvent): boolean {
  return agentsMenuBarService.isPopover(event.sender.id);
}

export function registerAgentsMenuBarHandlers(): void {
  ipcMain.on(
    IPC.AGENTS_MENU_BAR_IMAGE,
    onValidated(IPC.AGENTS_MENU_BAR_IMAGE, agentsMenuBarImageArgsSchema, (event, [image]) => {
      if (fromKomlaWindow(event)) agentsMenuBarService.setImage(image);
    })
  );

  ipcMain.on(
    IPC.AGENTS_MENU_BAR_THEME,
    onValidated(IPC.AGENTS_MENU_BAR_THEME, agentsMenuBarThemeArgsSchema, (event, [theme]) => {
      if (fromKomlaWindow(event)) agentsMenuBarService.setTheme(theme);
    })
  );

  ipcMain.on(
    IPC.AGENTS_MENU_BAR_STATE_REQUEST,
    onValidated(IPC.AGENTS_MENU_BAR_STATE_REQUEST, agentsMenuBarStateRequestArgsSchema, (event) => {
      if (fromPopover(event)) agentsMenuBarService.sendState();
    })
  );

  ipcMain.on(
    IPC.AGENTS_MENU_BAR_RESIZE,
    onValidated(
      IPC.AGENTS_MENU_BAR_RESIZE,
      agentsMenuBarResizeArgsSchema,
      (event, [width, height]) => {
        if (fromPopover(event)) agentsMenuBarService.resizePopover(width, height);
      }
    )
  );

  ipcMain.on(
    IPC.AGENTS_MENU_BAR_OPEN,
    onValidated(
      IPC.AGENTS_MENU_BAR_OPEN,
      agentsMenuBarOpenArgsSchema,
      (event, [workspaceId, terminalId]) => {
        if (fromPopover(event)) agentsMenuBarService.open(workspaceId, terminalId);
      }
    )
  );

  ipcMain.on(
    IPC.AGENTS_MENU_BAR_CLOSE,
    onValidated(IPC.AGENTS_MENU_BAR_CLOSE, agentsMenuBarCloseArgsSchema, (event) => {
      if (fromPopover(event)) agentsMenuBarService.closePopover();
    })
  );
}
