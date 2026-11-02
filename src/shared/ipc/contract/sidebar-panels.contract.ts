import { IPC } from '../../constants/ipc-channels';
import {
  sidebarPanelButtonRunArgsSchema,
  sidebarPanelRunArgsSchema,
  sidebarPanelsListArgsSchema,
} from '../schemas/sidebar-panels-ipc.schemas';

import { invoke } from './define';

import type { SidebarPanelList, SidebarPanelResult } from '../../types/sidebar-panels';
import type { StatusButtonRunResult } from '../../types/status-items';

export const sidebarPanelsContract = {
  [IPC.SIDEBAR_PANELS_LIST]: invoke(sidebarPanelsListArgsSchema).returns<SidebarPanelList>(),
  [IPC.SIDEBAR_PANEL_RUN]: invoke(sidebarPanelRunArgsSchema).returns<SidebarPanelResult>(),
  [IPC.SIDEBAR_PANEL_BUTTON_RUN]: invoke(
    sidebarPanelButtonRunArgsSchema
  ).returns<StatusButtonRunResult>(),
} as const;
