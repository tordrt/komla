import { IPC } from '../../constants/ipc-channels';
import {
  devPreviewSyncArgsSchema,
  devPreviewHideArgsSchema,
  devPreviewCloseArgsSchema,
  devPreviewReloadArgsSchema,
  devPreviewNavigateArgsSchema,
  devPreviewClearSiteDataArgsSchema,
  devPreviewCaptureArgsSchema,
  devPreviewDetectServicesArgsSchema,
  linkPreviewGetArgsSchema,
  linkPreviewImageArgsSchema,
  virtualDesktopOpenInVncAppArgsSchema,
  virtualDesktopForgetArgsSchema,
} from '../schemas/dev-preview-ipc.schemas';

import { invoke, send } from './define';

import type { DevPreviewServiceDetection, LinkPreview } from '../../types/dev-preview';

export const devPreviewContract = {
  [IPC.DEV_PREVIEW_SYNC]: send(devPreviewSyncArgsSchema),
  [IPC.DEV_PREVIEW_HIDE]: send(devPreviewHideArgsSchema),
  [IPC.DEV_PREVIEW_CLOSE]: send(devPreviewCloseArgsSchema),
  [IPC.DEV_PREVIEW_RELOAD]: invoke(devPreviewReloadArgsSchema).returns<boolean>(),
  [IPC.DEV_PREVIEW_NAVIGATE]: invoke(devPreviewNavigateArgsSchema).returns<boolean>(),
  [IPC.DEV_PREVIEW_CLEAR_SITE_DATA]: invoke(devPreviewClearSiteDataArgsSchema).returns<boolean>(),
  [IPC.DEV_PREVIEW_CAPTURE]: invoke(devPreviewCaptureArgsSchema).returns<string | null>(),
  [IPC.DEV_PREVIEW_DETECT_SERVICES]: invoke(
    devPreviewDetectServicesArgsSchema
  ).returns<DevPreviewServiceDetection>(),
  [IPC.LINK_PREVIEW_GET]: invoke(linkPreviewGetArgsSchema).returns<LinkPreview | null>(),
  [IPC.LINK_PREVIEW_IMAGE]: invoke(linkPreviewImageArgsSchema).returns<string | null>(),
  [IPC.VIRTUAL_DESKTOP_OPEN_IN_VNC_APP]: invoke(
    virtualDesktopOpenInVncAppArgsSchema
  ).returns<void>(),
  [IPC.VIRTUAL_DESKTOP_FORGET]: invoke(virtualDesktopForgetArgsSchema).returns<void>(),
} as const;
