import { IPC } from '../../constants/ipc-channels';
import { mcpGetStatusArgsSchema } from '../schemas/agent-settings-ipc.schemas';

import { invoke } from './define';

import type { KomlaSkillStatus } from '../../types/komla-skill';
import type { McpStatus } from '../../types/mcp-status';
import type { NotificationIntegrationUpdate } from '../../types/notification-integration';

export interface NotificationHookDetails {
  command: string;
  configJson: string;
  settingsPath: string;
  port: number;
  isConfigured: boolean;
  update?: NotificationIntegrationUpdate;
}

export interface CodexNotificationHookDetails extends NotificationHookDetails {
  hasConflict: boolean;
  canAutoConfigure: boolean;
  conflictMessage: string | null;
  isKomlaManaged?: boolean;
}

export interface McpCliResult {
  success: boolean;
  output?: string;
  error?: string;
}

export const agentSettingsContract = {
  [IPC.NOTIFICATIONS_ENABLE]: invoke().returns<void>(),
  [IPC.NOTIFICATIONS_DISABLE]: invoke().returns<void>(),
  [IPC.NOTIFICATIONS_GET_HOOK_DETAILS]: invoke().returns<NotificationHookDetails>(),
  [IPC.CODEX_NOTIFICATIONS_ENABLE]: invoke().returns<void>(),
  [IPC.CODEX_NOTIFICATIONS_DISABLE]: invoke().returns<void>(),
  [IPC.CODEX_NOTIFICATIONS_GET_HOOK_DETAILS]: invoke().returns<CodexNotificationHookDetails>(),
  [IPC.CODEX_NOTIFICATIONS_ENABLE_FORCE]: invoke().returns<{
    success: boolean;
    backupPath?: string;
    error?: string;
  }>(),
  [IPC.ANTIGRAVITY_NOTIFICATIONS_ENABLE]: invoke().returns<void>(),
  [IPC.ANTIGRAVITY_NOTIFICATIONS_DISABLE]: invoke().returns<void>(),
  [IPC.ANTIGRAVITY_NOTIFICATIONS_GET_HOOK_DETAILS]: invoke().returns<NotificationHookDetails>(),
  [IPC.OPENCODE_NOTIFICATIONS_ENABLE]: invoke().returns<void>(),
  [IPC.OPENCODE_NOTIFICATIONS_DISABLE]: invoke().returns<void>(),
  [IPC.OPENCODE_NOTIFICATIONS_GET_HOOK_DETAILS]: invoke().returns<{
    pluginContent: string;
    pluginPath: string;
    port: number;
    isConfigured: boolean;
    update?: NotificationIntegrationUpdate;
  }>(),
  [IPC.KOMLA_SKILL_GET_STATUS]: invoke().returns<KomlaSkillStatus>(),
  [IPC.KOMLA_SKILL_ENABLE]: invoke().returns<void>(),
  [IPC.KOMLA_SKILL_DISABLE]: invoke().returns<void>(),
  [IPC.MCP_GET_STATUS]: invoke(mcpGetStatusArgsSchema).returns<McpStatus>(),
  [IPC.MCP_ENABLE]: invoke().returns<{ success: boolean; error?: string }>(),
  [IPC.MCP_DISABLE]: invoke().returns<{ success: boolean; error?: string }>(),
  [IPC.MCP_RUN_CLI]: invoke().returns<McpCliResult>(),
  [IPC.MCP_RUN_REMOVE_CLI]: invoke().returns<McpCliResult>(),
  [IPC.MCP_RUN_CODEX_CLI]: invoke().returns<McpCliResult>(),
  [IPC.MCP_RUN_CODEX_REMOVE_CLI]: invoke().returns<McpCliResult>(),
  [IPC.MCP_RUN_ANTIGRAVITY_CLI]: invoke().returns<McpCliResult>(),
  [IPC.MCP_RUN_ANTIGRAVITY_REMOVE_CLI]: invoke().returns<McpCliResult>(),
  [IPC.SERVER_GET_PORT_CHANGE]: invoke().returns<{ oldPort: number; newPort: number } | null>(),
  [IPC.SERVER_GET_PORT]: invoke().returns<number>(),
  [IPC.MCP_RECONFIGURE_ALL]: invoke().returns<{
    success: boolean;
    results: { agent: string; success: boolean; error?: string }[];
  }>(),
} as const;
