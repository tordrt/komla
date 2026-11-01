import { IPC } from '../../constants/ipc-channels';
import {
  resourceUsageArgsSchema,
  agentUsageRefreshArgsSchema,
  announcementsDismissArgsSchema,
  clipboardWriteTextArgsSchema,
  clipboardImportImageArgsSchema,
  clipboardRunCommandArgsSchema,
} from '../schemas/app-ipc.schemas';
import { feedbackSendArgsSchema, errorReportArgsSchema } from '../schemas/config-ipc.schemas';

import { invoke } from './define';

import type { FeedbackResult } from '../../../renderer/types';
import type { AgentUsage } from '../../types/agent-usage';
import type { MachineResourceUsage } from '../../types/resource-usage';

export const appContract = {
  [IPC.APP_GET_SYSTEM_METRICS]: invoke().returns<{ cpuPercent: number; memoryMB: number }>(),
  [IPC.RESOURCE_USAGE_GET]: invoke(resourceUsageArgsSchema).returns<MachineResourceUsage>(),
  [IPC.AGENT_USAGE_GET]: invoke().returns<AgentUsage>(),
  [IPC.AGENT_USAGE_REFRESH]: invoke(agentUsageRefreshArgsSchema).returns<AgentUsage>(),
  [IPC.APP_GET_HOST_RESOURCES]: invoke().returns<{ cpuCount: number; totalMemoryGB: number }>(),
  [IPC.ANNOUNCEMENTS_GET]: invoke().returns<
    {
      id: string;
      type: 'info' | 'tip' | 'whats-new' | 'warning';
      title: string;
      body: string;
      date: string;
      dismissible?: boolean;
      displayMode: 'banner' | 'dialog' | 'both';
      action?: { label: string; url: string };
    }[]
  >(),
  [IPC.ANNOUNCEMENTS_DISMISS]: invoke(announcementsDismissArgsSchema).returns<void>(),
  [IPC.APP_GET_VERSION]: invoke().returns<string>(),
  [IPC.APP_GET_BASE_PATH]: invoke().returns<string>(),
  [IPC.APP_INSTALL_UPDATE]: invoke().returns<void>(),
  [IPC.APP_CHECK_UPDATES]: invoke().returns<void>(),
  [IPC.APP_DOWNLOAD_UPDATE]: invoke().returns<void>(),
  [IPC.FEEDBACK_SELECT_SCREENSHOTS]: invoke().returns<string[]>(),
  [IPC.FEEDBACK_SEND]: invoke(feedbackSendArgsSchema).returns<FeedbackResult>(),
  [IPC.ERROR_REPORT]: invoke(errorReportArgsSchema).returns<void>(),
  [IPC.DATA_DELETE_ALL_WORKSPACES]: invoke().returns<void>(),
  [IPC.DATA_CLEAR_LOGS]: invoke().returns<void>(),
  [IPC.DATA_RESET_APP]: invoke().returns<void>(),
  [IPC.CLIPBOARD_WRITE_TEXT]: invoke(clipboardWriteTextArgsSchema).returns<void>(),
  [IPC.CLIPBOARD_READ_TEXT]: invoke().returns<string>(),
  [IPC.CLIPBOARD_RUN_COMMAND]: invoke(clipboardRunCommandArgsSchema).returns<void>(),
  [IPC.CLIPBOARD_IMPORT_IMAGE]: invoke(clipboardImportImageArgsSchema).returns<string | null>(),
  [IPC.CLIPBOARD_STAGE_IMAGE]: invoke().returns<string | null>(),
} as const;
