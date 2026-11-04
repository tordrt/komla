import { BrowserWindow, dialog } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { pageEvent } from '../../../shared/types/komla-events';
import { onKomlaEvent } from '../../lib/komla-events';
import { htmlPreviewService } from '../../services/html-preview.service';
import { komlaOperationCapability } from '../../services/komla-operation/capabilities';
import { parseKomlaOperation } from '../../services/komla-operation/schema';
import { komlaOperationService } from '../../services/komla-operation.service';
import { pluginHostService } from '../../services/plugin-host';
import {
  runSidebarPanelOperation,
  type PanelOperationQuestion,
} from '../../services/sidebar-panel-operations';
import { sidebarPanelStates } from '../../services/sidebar-panel-states';
import { sidebarPanelsService } from '../../services/sidebar-panels.service';
import { windowService } from '../../services/window.service';
import { handleIpc } from '../validation/ipc-validators';

import type {
  SidebarPanelData,
  SidebarPanelList,
  SidebarPanelOperationResult,
  SidebarPanelResult,
  SidebarPanelState,
} from '../../../shared/types/sidebar-panels';
import type { StatusButtonRunResult } from '../../../shared/types/status-items';
import type { WebContents } from 'electron';

/** Asks in the window the page is in, as its own dialog, so nothing in the page can answer. */
async function confirmInWindow(
  sender: WebContents,
  { panel, action, detail }: PanelOperationQuestion
): Promise<boolean> {
  const options = {
    type: 'question' as const,
    buttons: ['Cancel', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    message: `Let the sidebar panel ${panel} ${action}?`,
    detail,
    noLink: true,
  };
  const window = BrowserWindow.fromWebContents(sender);
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

const followedWindows = new WeakSet<WebContents>();

/** A panel's page stays served while its window is open, and no longer. */
function releasePagesWithWindow(sender: WebContents): void {
  if (followedWindows.has(sender)) return;
  followedWindows.add(sender);
  const id = sender.id;
  sender.once('destroyed', () => htmlPreviewService.releaseKeys(`sidebar-panel-page:${id}:`));
}

/** The most a page may send its plugin's code at once, as JSON. */
const MAX_PANEL_MESSAGE_BYTES = 256 * 1024;

export function registerSidebarPanelsHandlers(): void {
  sidebarPanelsService.onChange(() => windowService.broadcastToAll(IPC.SIDEBAR_PANELS_CHANGED));
  sidebarPanelStates.onChange((state) =>
    windowService.broadcastToAll(IPC.SIDEBAR_PANEL_STATE_CHANGED, state)
  );
  // Windows never get what an agent said: they refresh on events and pass them to pages.
  onKomlaEvent((event) => windowService.broadcastToAll(IPC.KOMLA_EVENT, pageEvent(event)));

  handleIpc(IPC.SIDEBAR_PANEL_STATES, (): SidebarPanelState[] => sidebarPanelStates.all());

  handleIpc(
    IPC.SIDEBAR_PANEL_MESSAGE,
    async (_, [workspaceId, id, message, { activated }]): Promise<SidebarPanelOperationResult> => {
      const plugin = sidebarPanelsService.find(workspaceId, id)?.plugin;
      if (!plugin || !pluginHostService.hosts(plugin.id)) {
        return {
          ok: false,
          error: {
            code: 'NO_PLUGIN_CODE',
            message:
              "komla.send reaches a plugin's code, and this panel's plugin has none running.",
          },
        };
      }
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(message ?? null));
      } catch {
        size = Infinity;
      }
      if (size > MAX_PANEL_MESSAGE_BYTES) {
        return {
          ok: false,
          error: {
            code: 'INVALID_MESSAGE',
            message: `A message is JSON of up to ${MAX_PANEL_MESSAGE_BYTES} bytes.`,
          },
        };
      }
      return pluginHostService.sendPanelMessage(
        plugin.id,
        id.slice(plugin.id.length + 1),
        workspaceId,
        message,
        activated
      );
    }
  );

  handleIpc(IPC.SIDEBAR_PANEL_INSPECT, (event): void => {
    event.sender.openDevTools({ mode: 'detach' });
  });

  handleIpc(IPC.SIDEBAR_PANELS_LIST, (_, [workspaceId]): Promise<SidebarPanelList> =>
    sidebarPanelsService.list(workspaceId)
  );

  // Each window gets pages of its own, so one showing a panel doesn't replace another's.
  handleIpc(IPC.SIDEBAR_PANEL_RUN, (event, [workspaceId, id, theme]): Promise<SidebarPanelResult> =>
    sidebarPanelsService.run(workspaceId, id, theme, String(event.sender.id))
  );

  handleIpc(
    IPC.SIDEBAR_PANEL_PAGE,
    async (event, [workspaceId, id, theme]): Promise<{ url?: string; error?: string }> => {
      releasePagesWithWindow(event.sender);
      const page = await sidebarPanelsService.pageUrl(
        workspaceId,
        id,
        theme,
        String(event.sender.id)
      );
      // A window that closed while its page was made releases it now.
      if (event.sender.isDestroyed()) {
        htmlPreviewService.releaseKeys(`sidebar-panel-page:${event.sender.id}:`);
        return {};
      }
      const plugin = sidebarPanelsService.find(workspaceId, id)?.plugin;
      if (page.url && plugin) {
        pluginHostService.panelOpened(plugin.id, id.slice(plugin.id.length + 1), workspaceId);
      }
      return page;
    }
  );

  handleIpc(IPC.SIDEBAR_PANEL_DATA, (_, [workspaceId, id]): Promise<SidebarPanelData> =>
    sidebarPanelsService.runData(workspaceId, id)
  );

  handleIpc(
    IPC.SIDEBAR_PANEL_OPERATION,
    (event, [workspaceId, panelId, request, options]): Promise<SidebarPanelOperationResult> =>
      runSidebarPanelOperation(
        {
          findPanel: (workspace, id) => sidebarPanelsService.find(workspace, id),
          parse: parseKomlaOperation,
          capabilityOf: komlaOperationCapability,
          execute: (context, operation) => komlaOperationService.execute(context, operation),
          confirm: (question) => confirmInWindow(event.sender, question),
        },
        {
          workspaceId,
          panelId,
          request,
          activated: options.activated,
          ...(options.workspace && { targetWorkspaceId: options.workspace }),
        }
      )
  );

  handleIpc(
    IPC.SIDEBAR_PANEL_BUTTON_RUN,
    (_, [workspaceId, id, name]): Promise<StatusButtonRunResult> =>
      sidebarPanelsService.runButton(workspaceId, id, name)
  );
}
