import { IPC } from '../../constants/ipc-channels';
import {
  agentsMenuBarImageArgsSchema,
  agentsMenuBarThemeArgsSchema,
  agentsMenuBarStateRequestArgsSchema,
  agentsMenuBarResizeArgsSchema,
  agentsMenuBarOpenArgsSchema,
  agentsMenuBarCloseArgsSchema,
} from '../schemas/agents-menu-bar-ipc.schemas';

import { send } from './define';

export const agentsMenuBarContract = {
  [IPC.AGENTS_MENU_BAR_IMAGE]: send(agentsMenuBarImageArgsSchema),
  [IPC.AGENTS_MENU_BAR_THEME]: send(agentsMenuBarThemeArgsSchema),
  [IPC.AGENTS_MENU_BAR_STATE_REQUEST]: send(agentsMenuBarStateRequestArgsSchema),
  [IPC.AGENTS_MENU_BAR_RESIZE]: send(agentsMenuBarResizeArgsSchema),
  [IPC.AGENTS_MENU_BAR_OPEN]: send(agentsMenuBarOpenArgsSchema),
  [IPC.AGENTS_MENU_BAR_CLOSE]: send(agentsMenuBarCloseArgsSchema),
} as const;
