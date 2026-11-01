import { IPC } from '../../constants/ipc-channels';
import {
  statusCommandsListArgsSchema,
  statusCommandRunArgsSchema,
  statusPopoverRunArgsSchema,
  statusItemPopoverPageArgsSchema,
  statusButtonRunArgsSchema,
} from '../schemas/status-items-ipc.schemas';

import { invoke } from './define';

import type {
  StatusButtonRunResult,
  StatusCommandList,
  StatusCommandResult,
  StatusPopoverResult,
  WindowStatusItem,
} from '../../types/status-items';

export const statusItemsContract = {
  [IPC.STATUS_ITEMS_LIST]: invoke().returns<WindowStatusItem[]>(),
  [IPC.STATUS_COMMANDS_LIST]: invoke(statusCommandsListArgsSchema).returns<StatusCommandList>(),
  [IPC.STATUS_COMMAND_RUN]: invoke(statusCommandRunArgsSchema).returns<StatusCommandResult>(),
  [IPC.STATUS_POPOVER_RUN]: invoke(statusPopoverRunArgsSchema).returns<StatusPopoverResult>(),
  [IPC.STATUS_ITEM_POPOVER_PAGE]: invoke(statusItemPopoverPageArgsSchema).returns<string | null>(),
  [IPC.STATUS_BUTTON_RUN]: invoke(statusButtonRunArgsSchema).returns<StatusButtonRunResult>(),
} as const;
