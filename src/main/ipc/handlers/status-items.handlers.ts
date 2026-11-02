import { IPC } from '../../../shared/constants/ipc-channels';
import { serveCommandPage } from '../../services/command-items';
import { statusCommandsService } from '../../services/status-commands.service';
import { statusItemsService } from '../../services/status-items.service';
import { buildStatusPopoverPage } from '../../services/status-popover-page';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

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

  handleIpc(IPC.STATUS_ITEMS_LIST, windowItems);

  handleIpc(IPC.STATUS_COMMANDS_LIST, (_, [workspaceId]): StatusCommandList =>
    statusCommandsService.list(workspaceId)
  );

  handleIpc(IPC.STATUS_COMMAND_RUN, (_, [workspaceId, id]): Promise<StatusCommandResult> =>
    statusCommandsService.run(workspaceId, id)
  );

  handleIpc(
    IPC.STATUS_POPOVER_RUN,
    (event, [workspaceId, id, theme]): Promise<StatusPopoverResult> =>
      statusCommandsService.runPopover(workspaceId, id, theme, String(event.sender.id))
  );

  // An agent item's HTML popover, in the window's theme and the sandbox status-items.json pages
  // use. Each window gets a page of its own, so one opening it doesn't replace another's.
  handleIpc(
    IPC.STATUS_ITEM_POPOVER_PAGE,
    async (event, [workspaceId, id, theme]): Promise<string | null> => {
      const html = statusItemsService.get(workspaceId, id)?.popover;
      if (!html) return null;
      return serveCommandPage(
        `status-item-popover:${event.sender.id}:${workspaceId}:${id}`,
        buildStatusPopoverPage(html, theme)
      );
    }
  );

  handleIpc(IPC.STATUS_BUTTON_RUN, (_, [workspaceId, id, name]): Promise<StatusButtonRunResult> =>
    statusCommandsService.runButton(workspaceId, id, name)
  );
}
