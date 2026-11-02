import { IPC } from '../../../shared/constants/ipc-channels';
import { sidebarPanelsService } from '../../services/sidebar-panels.service';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

import type { SidebarPanelList, SidebarPanelResult } from '../../../shared/types/sidebar-panels';
import type { StatusButtonRunResult } from '../../../shared/types/status-items';

export function registerSidebarPanelsHandlers(): void {
  sidebarPanelsService.onChange(() => windowService.broadcastToAll(IPC.SIDEBAR_PANELS_CHANGED));

  handleIpc(IPC.SIDEBAR_PANELS_LIST, (_, [workspaceId]): Promise<SidebarPanelList> =>
    sidebarPanelsService.list(workspaceId)
  );

  // Each window gets pages of its own, so one showing a panel doesn't replace another's.
  handleIpc(IPC.SIDEBAR_PANEL_RUN, (event, [workspaceId, id, theme]): Promise<SidebarPanelResult> =>
    sidebarPanelsService.run(workspaceId, id, theme, String(event.sender.id))
  );

  handleIpc(
    IPC.SIDEBAR_PANEL_BUTTON_RUN,
    (_, [workspaceId, id, name]): Promise<StatusButtonRunResult> =>
      sidebarPanelsService.runButton(workspaceId, id, name)
  );
}
