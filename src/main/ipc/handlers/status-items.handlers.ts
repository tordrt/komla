import { ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { statusCommandsService } from '../../services/status-commands.service';
import { statusItemsService } from '../../services/status-items.service';
import { windowService } from '../../services/window.service';
import { handleValidated } from '../validation/ipc-validators';
import {
  statusButtonRunArgsSchema,
  statusCommandRunArgsSchema,
  statusCommandsListArgsSchema,
  statusItemsListArgsSchema,
  statusPopoverRunArgsSchema,
} from '../validation/status-items-ipc.schemas';

import type {
  AgentStatusItem,
  StatusButtonRunResult,
  StatusCommandList,
  StatusCommandResult,
  StatusPopoverResult,
} from '../../../shared/types/status-items';

export function registerStatusItemsHandlers(): void {
  statusItemsService.onChange(() =>
    windowService.broadcastToAll(IPC.STATUS_ITEMS_CHANGED, statusItemsService.list())
  );
  statusCommandsService.onChange(() => windowService.broadcastToAll(IPC.STATUS_COMMANDS_CHANGED));
  statusCommandsService.onResult((result) =>
    windowService.broadcastToAll(IPC.STATUS_COMMAND_RESULT, result)
  );

  ipcMain.handle(
    IPC.STATUS_ITEMS_LIST,
    handleValidated(IPC.STATUS_ITEMS_LIST, statusItemsListArgsSchema, (): AgentStatusItem[] =>
      statusItemsService.list()
    )
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
