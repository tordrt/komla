import { IPC } from '../../constants/ipc-channels';
import {
  sidebarPanelButtonRunArgsSchema,
  sidebarPanelMessageArgsSchema,
  sidebarPanelDataArgsSchema,
  sidebarPanelOperationArgsSchema,
  sidebarPanelPageArgsSchema,
  sidebarPanelRunArgsSchema,
  sidebarPanelsListArgsSchema,
} from '../schemas/sidebar-panels-ipc.schemas';

import { invoke } from './define';

import type {
  SidebarPanelData,
  SidebarPanelList,
  SidebarPanelOperationResult,
  SidebarPanelResult,
  SidebarPanelState,
} from '../../types/sidebar-panels';
import type { StatusButtonRunResult } from '../../types/status-items';

export const sidebarPanelsContract = {
  [IPC.SIDEBAR_PANELS_LIST]: invoke(sidebarPanelsListArgsSchema).returns<SidebarPanelList>(),
  [IPC.SIDEBAR_PANEL_RUN]: invoke(sidebarPanelRunArgsSchema).returns<SidebarPanelResult>(),
  [IPC.SIDEBAR_PANEL_BUTTON_RUN]: invoke(
    sidebarPanelButtonRunArgsSchema
  ).returns<StatusButtonRunResult>(),
  [IPC.SIDEBAR_PANEL_PAGE]: invoke(sidebarPanelPageArgsSchema).returns<{
    url?: string;
    error?: string;
  }>(),
  [IPC.SIDEBAR_PANEL_DATA]: invoke(sidebarPanelDataArgsSchema).returns<SidebarPanelData>(),
  [IPC.SIDEBAR_PANEL_OPERATION]: invoke(
    sidebarPanelOperationArgsSchema
  ).returns<SidebarPanelOperationResult>(),
  [IPC.SIDEBAR_PANEL_STATES]: invoke().returns<SidebarPanelState[]>(),
  [IPC.SIDEBAR_PANEL_INSPECT]: invoke().returns<void>(),
  [IPC.SIDEBAR_PANEL_MESSAGE]: invoke(
    sidebarPanelMessageArgsSchema
  ).returns<SidebarPanelOperationResult>(),
} as const;
