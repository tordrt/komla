import { IPC } from '../../constants/ipc-channels';
import {
  configUpdateArgsSchema,
  sshListConfigHostsArgsSchema,
  sshCheckHostArgsSchema,
  sshSaveHostArgsSchema,
  configSaveOpenRouterApiKeyArgsSchema,
  configClearOpenRouterApiKeyArgsSchema,
  configGetOpenRouterKeyStatusArgsSchema,
  configTestCustomEndpointArgsSchema,
  configVerifySshHostArgsSchema,
  sshDeleteHostArgsSchema,
  sshGetIntegrationStatusArgsSchema,
  sshGetCachedIntegrationUpdatesArgsSchema,
  sshGetPortForwardStatusArgsSchema,
  sshListForwardedPortsArgsSchema,
  sshStopDesktopForwardArgsSchema,
  sshEnableIntegrationArgsSchema,
  sshDisableIntegrationArgsSchema,
  sshSetKomlaSkillArgsSchema,
  categoryCreateArgsSchema,
  categoryUpdateArgsSchema,
  categoryDeleteArgsSchema,
} from '../schemas/config-ipc.schemas';

import { invoke } from './define';

import type { AppConfig, Category } from '../../../renderer/types';
import type {
  SshConfigHost,
  SshForwardedPort,
  SshHost,
  SshHostSetupResult,
  SshHostStatus,
  SshIntegrationStatus,
  SshIntegrationUpdates,
  SshPortForwardStatus,
} from '../../types/ssh';
import type {
  CustomEndpointTestResult,
  UtilityOpenRouterKeyStatus,
} from '../../types/utility-inference';

export const configContract = {
  [IPC.CONFIG_GET]: invoke().returns<AppConfig>(),
  [IPC.CONFIG_UPDATE]: invoke(configUpdateArgsSchema).returns<AppConfig>(),
  [IPC.SSH_LIST_HOSTS]: invoke().returns<SshHost[]>(),
  [IPC.SSH_LIST_CONFIG_HOSTS]: invoke(sshListConfigHostsArgsSchema).returns<SshConfigHost[]>(),
  [IPC.SSH_HOST_STATUSES_GET]: invoke().returns<SshHostStatus[]>(),
  [IPC.SSH_HOST_CHECK]: invoke(sshCheckHostArgsSchema).returns<SshHostStatus | undefined>(),
  [IPC.SSH_SAVE_HOST]: invoke(sshSaveHostArgsSchema).returns<SshHost>(),
  [IPC.CONFIG_SAVE_OPENROUTER_API_KEY]: invoke(
    configSaveOpenRouterApiKeyArgsSchema
  ).returns<void>(),
  [IPC.CONFIG_CLEAR_OPENROUTER_API_KEY]: invoke(
    configClearOpenRouterApiKeyArgsSchema
  ).returns<void>(),
  [IPC.CONFIG_GET_OPENROUTER_KEY_STATUS]: invoke(
    configGetOpenRouterKeyStatusArgsSchema
  ).returns<UtilityOpenRouterKeyStatus>(),
  [IPC.CONFIG_TEST_CUSTOM_ENDPOINT]: invoke(
    configTestCustomEndpointArgsSchema
  ).returns<CustomEndpointTestResult>(),
  [IPC.CONFIG_VERIFY_SSH_HOST]: invoke(configVerifySshHostArgsSchema).returns<SshHostSetupResult>(),
  [IPC.SSH_DELETE_HOST]: invoke(sshDeleteHostArgsSchema).returns<{
    deletedWorkspaceIds: string[];
  }>(),
  [IPC.SSH_GET_INTEGRATION_STATUS]: invoke(
    sshGetIntegrationStatusArgsSchema
  ).returns<SshIntegrationStatus>(),
  [IPC.SSH_GET_CACHED_INTEGRATION_UPDATES]: invoke(
    sshGetCachedIntegrationUpdatesArgsSchema
  ).returns<Record<string, SshIntegrationUpdates>>(),
  [IPC.SSH_GET_PORT_FORWARD_STATUS]: invoke(
    sshGetPortForwardStatusArgsSchema
  ).returns<SshPortForwardStatus>(),
  [IPC.SSH_LIST_FORWARDED_PORTS]: invoke(sshListForwardedPortsArgsSchema).returns<
    SshForwardedPort[]
  >(),
  [IPC.SSH_STOP_DESKTOP_FORWARD]: invoke(sshStopDesktopForwardArgsSchema).returns<void>(),
  [IPC.SSH_ENABLE_INTEGRATION]: invoke(sshEnableIntegrationArgsSchema).returns<void>(),
  [IPC.SSH_DISABLE_INTEGRATION]: invoke(sshDisableIntegrationArgsSchema).returns<void>(),
  [IPC.SSH_SET_KOMLA_SKILL]: invoke(sshSetKomlaSkillArgsSchema).returns<void>(),
  [IPC.CATEGORY_LIST]: invoke().returns<Category[]>(),
  [IPC.CATEGORY_CREATE]: invoke(categoryCreateArgsSchema).returns<Category>(),
  [IPC.CATEGORY_UPDATE]: invoke(categoryUpdateArgsSchema).returns<Category>(),
  [IPC.CATEGORY_DELETE]: invoke(categoryDeleteArgsSchema).returns<void>(),
  [IPC.CATEGORY_GET_SETTINGS_PATH]: invoke().returns<string>(),
} as const;
