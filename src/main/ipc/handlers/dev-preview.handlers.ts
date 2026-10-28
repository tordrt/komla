import { BrowserWindow, ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { createLogger } from '../../lib/logger';
import { devPreviewServiceDetector } from '../../services/dev-preview-services';
import { devPreviewService } from '../../services/dev-preview.service';
import { linkPreviewService } from '../../services/link-preview';
import { projectService } from '../../services/project.service';
import {
  forgetVirtualDesktops,
  openSavedDesktopInVncApp,
} from '../../services/virtual-desktop.service';
import { workspaceService } from '../../services/workspace.service';
import {
  devPreviewCaptureArgsSchema,
  devPreviewClearSiteDataArgsSchema,
  devPreviewCloseArgsSchema,
  devPreviewDetectServicesArgsSchema,
  devPreviewHideArgsSchema,
  devPreviewNavigateArgsSchema,
  devPreviewReloadArgsSchema,
  devPreviewSyncArgsSchema,
  linkPreviewGetArgsSchema,
  linkPreviewImageArgsSchema,
  virtualDesktopForgetArgsSchema,
  virtualDesktopOpenInVncAppArgsSchema,
} from '../validation/dev-preview-ipc.schemas';
import { handleValidated, onValidated } from '../validation/ipc-validators';

import type { DevPreviewServiceDetection, LinkPreview } from '../../../shared/types';

const logger = createLogger('DevPreviewHandlers');

export function registerDevPreviewHandlers(): void {
  // Only a project on this machine, whose deletion clears its session: a workspace
  // synced from another device can name one that isn't.
  devPreviewService.setProjectLookup((workspaceId) => {
    const projectId = workspaceService.get(workspaceId)?.projectId;
    return projectId && projectService.get(projectId) ? projectId : undefined;
  });
  void devPreviewService.removeSharedSessionData().catch((error) => {
    logger.warn('Could not remove the shared preview session', { error });
  });
  ipcMain.on(
    IPC.DEV_PREVIEW_SYNC,
    onValidated(
      IPC.DEV_PREVIEW_SYNC,
      devPreviewSyncArgsSchema,
      (event, [workspaceId, tabId, url, bounds]) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) return;
        devPreviewService.sync(owner, workspaceId, tabId, url, bounds);
      }
    )
  );

  ipcMain.on(
    IPC.DEV_PREVIEW_HIDE,
    onValidated(IPC.DEV_PREVIEW_HIDE, devPreviewHideArgsSchema, (event, [workspaceId, tabId]) => {
      devPreviewService.hide(event.sender.id, workspaceId, tabId);
    })
  );

  ipcMain.on(
    IPC.DEV_PREVIEW_CLOSE,
    onValidated(IPC.DEV_PREVIEW_CLOSE, devPreviewCloseArgsSchema, (event, [workspaceId, tabId]) => {
      devPreviewService.close(event.sender.id, workspaceId, tabId);
    })
  );

  ipcMain.handle(
    IPC.DEV_PREVIEW_RELOAD,
    handleValidated(
      IPC.DEV_PREVIEW_RELOAD,
      devPreviewReloadArgsSchema,
      async (event, [workspaceId, tabId, ignoreCache]): Promise<boolean> =>
        devPreviewService.reload(event.sender.id, workspaceId, tabId, ignoreCache)
    )
  );

  ipcMain.handle(
    IPC.DEV_PREVIEW_NAVIGATE,
    handleValidated(
      IPC.DEV_PREVIEW_NAVIGATE,
      devPreviewNavigateArgsSchema,
      async (event, [workspaceId, tabId, direction]): Promise<boolean> =>
        devPreviewService.navigate(event.sender.id, workspaceId, tabId, direction)
    )
  );

  ipcMain.handle(
    IPC.DEV_PREVIEW_CLEAR_SITE_DATA,
    handleValidated(
      IPC.DEV_PREVIEW_CLEAR_SITE_DATA,
      devPreviewClearSiteDataArgsSchema,
      async (event, [workspaceId, tabId]): Promise<boolean> =>
        devPreviewService.clearSiteData(event.sender.id, workspaceId, tabId)
    )
  );

  ipcMain.handle(
    IPC.DEV_PREVIEW_CAPTURE,
    handleValidated(
      IPC.DEV_PREVIEW_CAPTURE,
      devPreviewCaptureArgsSchema,
      async (event, [workspaceId, tabId]): Promise<string | null> =>
        devPreviewService.capture(event.sender.id, workspaceId, tabId)
    )
  );

  ipcMain.handle(
    IPC.DEV_PREVIEW_DETECT_SERVICES,
    handleValidated(
      IPC.DEV_PREVIEW_DETECT_SERVICES,
      devPreviewDetectServicesArgsSchema,
      async (
        _event,
        [workspaceId, ports, remotePorts, ownPorts]
      ): Promise<DevPreviewServiceDetection> =>
        devPreviewServiceDetector.detect(workspaceId, ports, remotePorts, ownPorts)
    )
  );

  ipcMain.handle(
    IPC.LINK_PREVIEW_GET,
    handleValidated(
      IPC.LINK_PREVIEW_GET,
      linkPreviewGetArgsSchema,
      async (_event, [request]): Promise<LinkPreview | null> =>
        linkPreviewService.getPreview(request)
    )
  );

  ipcMain.handle(
    IPC.LINK_PREVIEW_IMAGE,
    handleValidated(
      IPC.LINK_PREVIEW_IMAGE,
      linkPreviewImageArgsSchema,
      async (_event, [url]): Promise<string | null> => linkPreviewService.getImage(url)
    )
  );

  ipcMain.handle(
    IPC.VIRTUAL_DESKTOP_OPEN_IN_VNC_APP,
    handleValidated(
      IPC.VIRTUAL_DESKTOP_OPEN_IN_VNC_APP,
      virtualDesktopOpenInVncAppArgsSchema,
      async (_event, [workspaceId, vncPort]): Promise<void> =>
        openSavedDesktopInVncApp(workspaceId, vncPort)
    )
  );

  ipcMain.handle(
    IPC.VIRTUAL_DESKTOP_FORGET,
    handleValidated(
      IPC.VIRTUAL_DESKTOP_FORGET,
      virtualDesktopForgetArgsSchema,
      async (_event, [workspaceId, vncPorts, checkedAt]): Promise<void> =>
        forgetVirtualDesktops(workspaceId, vncPorts, checkedAt)
    )
  );
}
