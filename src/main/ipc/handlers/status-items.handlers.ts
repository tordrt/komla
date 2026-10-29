import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import {
  serveStatusPopoverPage,
  statusCommandsService,
} from '../../services/status-commands.service';
import { statusItemsService } from '../../services/status-items.service';
import { buildStatusPopoverPage } from '../../services/status-popover-page';
import { windowService } from '../../services/window.service';
import { handleValidated } from '../validation/ipc-validators';
import {
  statusButtonRunArgsSchema,
  statusCommandRunArgsSchema,
  statusCommandsListArgsSchema,
  statusItemPopoverPageArgsSchema,
  statusItemsListArgsSchema,
  statusPopoverRunArgsSchema,
} from '../validation/status-items-ipc.schemas';

import type {
  StatusButtonRunResult,
  StatusCommandList,
  StatusCommandResult,
  StatusPopoverResult,
  WindowStatusItem,
} from '../../../shared/types/status-items';

/**
 * The items as windows get them: an HTML popover's page, up to MAX_STATUS_POPOVER_HTML long, stays
 * here until a window opens it, and its popoverPageId stands in for it.
 */
function windowItems(): WindowStatusItem[] {
  return statusItemsService.list().map(({ popover: _page, ...item }) => item);
}

export function registerStatusItemsHandlers(): void {
  statusItemsService.onChange(() =>
    windowService.broadcastToAll(IPC.STATUS_ITEMS_CHANGED, windowItems())
  );
  statusCommandsService.onChange(() => windowService.broadcastToAll(IPC.STATUS_COMMANDS_CHANGED));
  statusCommandsService.onResult((result) =>
    windowService.broadcastToAll(IPC.STATUS_COMMAND_RESULT, result)
  );

  ipcMain.handle(
    IPC.STATUS_ITEMS_LIST,
    handleValidated(IPC.STATUS_ITEMS_LIST, statusItemsListArgsSchema, windowItems)
  );

  ipcMain.handle(
    IPC.STATUS_COMMANDS_LIST,
    handleValidated(
      IPC.STATUS_COMMANDS_LIST,
      statusCommandsListArgsSchema,
      (_, [workspaceId]): StatusCommandList => statusCommandsService.list(workspaceId)
    )
  );

  ipcMain.handle(
    IPC.STATUS_COMMAND_RUN,
    handleValidated(
      IPC.STATUS_COMMAND_RUN,
      statusCommandRunArgsSchema,
      (_, [workspaceId, id]): Promise<StatusCommandResult> =>
        statusCommandsService.run(workspaceId, id)
    )
  );

  ipcMain.handle(
    IPC.STATUS_POPOVER_RUN,
    handleValidated(
      IPC.STATUS_POPOVER_RUN,
      statusPopoverRunArgsSchema,
      (event, [workspaceId, id, theme]): Promise<StatusPopoverResult> =>
        statusCommandsService.runPopover(workspaceId, id, theme, String(event.sender.id))
    )
  );

  // An agent item's HTML popover, in the window's theme and the sandbox status-items.json pages
  // use. Each window gets a page of its own, so one opening it doesn't replace another's.
  ipcMain.handle(
    IPC.STATUS_ITEM_POPOVER_PAGE,
    handleValidated(
      IPC.STATUS_ITEM_POPOVER_PAGE,
      statusItemPopoverPageArgsSchema,
      async (event, [workspaceId, id, theme]): Promise<string | null> => {
        const html = statusItemsService.get(workspaceId, id)?.popover;
        if (!html) return null;
        return serveStatusPopoverPage(
          `status-item-popover:${event.sender.id}:${workspaceId}:${id}`,
          buildStatusPopoverPage(html, theme)
        );
      }
    )
  );

  ipcMain.handle(
    IPC.STATUS_BUTTON_RUN,
    handleValidated(
      IPC.STATUS_BUTTON_RUN,
      statusButtonRunArgsSchema,
      (_, [workspaceId, id, name]): Promise<StatusButtonRunResult> =>
        statusCommandsService.runButton(workspaceId, id, name)
    )
  );
}
