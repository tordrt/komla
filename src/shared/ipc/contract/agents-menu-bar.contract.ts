import { IPC } from '../../constants/ipc-channels';
import {
  agentsMenuBarImageArgsSchema,
  agentsMenuBarThemeArgsSchema,
  agentsMenuBarResizeArgsSchema,
  agentsMenuBarPassThroughArgsSchema,
  agentsMenuBarOpenArgsSchema,
} from '../schemas/agents-menu-bar-ipc.schemas';

import { send } from './define';

export const agentsMenuBarContract = {
  [IPC.AGENTS_MENU_BAR_IMAGE]: send(agentsMenuBarImageArgsSchema),
  [IPC.AGENTS_MENU_BAR_THEME]: send(agentsMenuBarThemeArgsSchema),
  [IPC.AGENTS_MENU_BAR_STATE_REQUEST]: send(),
  [IPC.AGENTS_MENU_BAR_RESIZE]: send(agentsMenuBarResizeArgsSchema),
  [IPC.AGENTS_MENU_BAR_PASS_THROUGH]: send(agentsMenuBarPassThroughArgsSchema),
  [IPC.AGENTS_MENU_BAR_OPEN]: send(agentsMenuBarOpenArgsSchema),
  [IPC.AGENTS_MENU_BAR_CLOSE]: send(),
} as const;
