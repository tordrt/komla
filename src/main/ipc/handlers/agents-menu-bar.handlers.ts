import { IPC } from '../../../shared/constants/ipc-channels';
import { agentsMenuBarService } from '../../services/agents-menu-bar.service';
import { windowService } from '../../services/window.service';
import { onIpc } from '../validation/ipc-validators';

import type { IpcMainEvent } from 'electron';

/** Sent by one of Komla's own windows, not the popover or a preview. */
function fromKomlaWindow(event: IpcMainEvent): boolean {
  return windowService.getWindowId(event.sender.id) !== undefined;
}

function fromPopover(event: IpcMainEvent): boolean {
  return agentsMenuBarService.isPopover(event.sender.id);
}

export function registerAgentsMenuBarHandlers(): void {
  onIpc(IPC.AGENTS_MENU_BAR_IMAGE, (event, [image]) => {
    if (fromKomlaWindow(event)) agentsMenuBarService.setImage(image);
  });

  onIpc(IPC.AGENTS_MENU_BAR_THEME, (event, [theme]) => {
    if (fromKomlaWindow(event)) agentsMenuBarService.setTheme(theme);
  });

  onIpc(IPC.AGENTS_MENU_BAR_STATE_REQUEST, (event) => {
    if (fromPopover(event)) agentsMenuBarService.sendState();
  });

  onIpc(IPC.AGENTS_MENU_BAR_RESIZE, (event, [width, height]) => {
    if (fromPopover(event)) agentsMenuBarService.resizePopover(width, height);
  });

  onIpc(IPC.AGENTS_MENU_BAR_OPEN, (event, [workspaceId, terminalId]) => {
    if (fromPopover(event)) agentsMenuBarService.open(workspaceId, terminalId);
  });

  onIpc(IPC.AGENTS_MENU_BAR_CLOSE, (event) => {
    if (fromPopover(event)) agentsMenuBarService.closePopover();
  });
}
