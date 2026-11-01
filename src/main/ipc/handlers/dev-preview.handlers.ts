import { BrowserWindow } from 'electron';

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
import { handleIpc, onIpc } from '../validation/ipc-validators';

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
  onIpc(IPC.DEV_PREVIEW_SYNC, (event, [workspaceId, tabId, url, bounds]) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return;
    devPreviewService.sync(owner, workspaceId, tabId, url, bounds);
  });

  onIpc(IPC.DEV_PREVIEW_HIDE, (event, [workspaceId, tabId]) => {
    devPreviewService.hide(event.sender.id, workspaceId, tabId);
  });

  onIpc(IPC.DEV_PREVIEW_CLOSE, (event, [workspaceId, tabId]) => {
    devPreviewService.close(event.sender.id, workspaceId, tabId);
  });

  handleIpc(
    IPC.DEV_PREVIEW_RELOAD,
    async (event, [workspaceId, tabId, ignoreCache]): Promise<boolean> =>
      devPreviewService.reload(event.sender.id, workspaceId, tabId, ignoreCache)
  );

  handleIpc(
    IPC.DEV_PREVIEW_NAVIGATE,
    async (event, [workspaceId, tabId, direction]): Promise<boolean> =>
      devPreviewService.navigate(event.sender.id, workspaceId, tabId, direction)
  );

  handleIpc(
    IPC.DEV_PREVIEW_CLEAR_SITE_DATA,
    async (event, [workspaceId, tabId]): Promise<boolean> =>
      devPreviewService.clearSiteData(event.sender.id, workspaceId, tabId)
  );

  handleIpc(IPC.DEV_PREVIEW_CAPTURE, async (event, [workspaceId, tabId]): Promise<string | null> =>
    devPreviewService.capture(event.sender.id, workspaceId, tabId)
  );

  handleIpc(
    IPC.DEV_PREVIEW_DETECT_SERVICES,
    async (
      _event,
      [workspaceId, ports, remotePorts, ownPorts]
    ): Promise<DevPreviewServiceDetection> =>
      devPreviewServiceDetector.detect(workspaceId, ports, remotePorts, ownPorts)
  );

  handleIpc(IPC.LINK_PREVIEW_GET, async (_event, [request]): Promise<LinkPreview | null> =>
    linkPreviewService.getPreview(request)
  );

  handleIpc(IPC.LINK_PREVIEW_IMAGE, async (_event, [url]): Promise<string | null> =>
    linkPreviewService.getImage(url)
  );

  handleIpc(
    IPC.VIRTUAL_DESKTOP_OPEN_IN_VNC_APP,
    async (_event, [workspaceId, vncPort]): Promise<void> =>
      openSavedDesktopInVncApp(workspaceId, vncPort)
  );

  handleIpc(
    IPC.VIRTUAL_DESKTOP_FORGET,
    async (_event, [workspaceId, vncPorts, checkedAt]): Promise<void> =>
      forgetVirtualDesktops(workspaceId, vncPorts, checkedAt)
  );
}
