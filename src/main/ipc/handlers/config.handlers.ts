import { isDeepStrictEqual } from 'node:util';

import { BrowserWindow, ipcMain, type WebContents } from 'electron';

import { turnedOffQueuedCommands } from '../../../shared/constants/agent-capabilities';
import { IPC } from '../../../shared/constants/ipc-channels';
import {
  CustomEndpointTestResult,
  SshConfigHost,
  SshHost,
  SshHostSetupResult,
  SshHostStatus,
  SshIntegrationStatus,
  SshIntegrationUpdates,
  SshForwardedPort,
  SshPortForwardStatus,
  UtilityOpenRouterKeyStatus,
} from '../../../shared/types';
import { agentsMenuBarService } from '../../services/agents-menu-bar.service';
import { categoryService, Category } from '../../services/category.service';
import { configService, AppConfig } from '../../services/config.service';
import { keepAwakeService } from '../../services/keep-awake.service';
import { metricsCollectorService } from '../../services/metrics-collector.service';
import { remoteControlHostAccessService } from '../../services/remote-control-host-access.service';
import { remoteControlKeepAwakeService } from '../../services/remote-control-keep-awake.service';
import { publishRemoteWorkspaceChange } from '../../services/remote-workspace-events';
import { remoteWorkspaceObservationService } from '../../services/remote-workspace-observation.service';
import { listSshConfigHosts } from '../../services/ssh-config-hosts';
import { sshConnectionService } from '../../services/ssh-connection.service';
import { sshHostStatusService } from '../../services/ssh-host-status.service';
import { sshHostService } from '../../services/ssh-host.service';
import { sshPortForwardService } from '../../services/ssh-port-forward.service';
import { sshWorkspaceService } from '../../services/ssh-workspace.service';
import { utilityInferenceService } from '../../services/utility-inference.service';
import { utilitySecretService } from '../../services/utility-secret.service';
import { windowService } from '../../services/window.service';
import { workspaceService } from '../../services/workspace.service';
import {
  categoryCreateArgsSchema,
  categoryDeleteArgsSchema,
  categoryUpdateArgsSchema,
  configClearOpenRouterApiKeyArgsSchema,
  configGetOpenRouterKeyStatusArgsSchema,
  configSaveOpenRouterApiKeyArgsSchema,
  configTestCustomEndpointArgsSchema,
  configVerifySshHostArgsSchema,
  sshDeleteHostArgsSchema,
  configUpdateArgsSchema,
  sshCheckHostArgsSchema,
  sshDisableIntegrationArgsSchema,
  sshSetKomlaSkillArgsSchema,
  sshEnableIntegrationArgsSchema,
  sshGetCachedIntegrationUpdatesArgsSchema,
  sshGetIntegrationStatusArgsSchema,
  sshGetPortForwardStatusArgsSchema,
  sshListConfigHostsArgsSchema,
  sshListForwardedPortsArgsSchema,
  sshSaveHostArgsSchema,
  sshStopDesktopForwardArgsSchema,
} from '../validation/config-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';

// The saving window gets the config as its reply; the others would keep a stale copy.
function broadcastConfigChanged(config: AppConfig, sender: WebContents): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents !== sender) {
      window.webContents.send(IPC.CONFIG_CHANGED, config);
    }
  }
}

function broadcastSshHostsChanged(): void {
  const hosts = sshHostService.list();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.SSH_HOSTS_CHANGED, hosts);
    }
  }
}

function broadcastSshIntegrationUpdates(updates: Record<string, SshIntegrationUpdates>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.SSH_INTEGRATION_UPDATES_CHANGED, updates);
    }
  }
}

export function registerConfigHandlers(): void {
  sshWorkspaceService.onIntegrationUpdatesChanged(broadcastSshIntegrationUpdates);

  // Config handlers
  ipcMain.handle(IPC.CONFIG_GET, async (): Promise<AppConfig> => {
    return configService.get();
  });

  ipcMain.handle(
    IPC.CONFIG_UPDATE,
    handleValidated(
      IPC.CONFIG_UPDATE,
      configUpdateArgsSchema,
      async (event, [updates]): Promise<AppConfig> => {
        const turnedOffBefore =
          updates.agentDisabledCapabilities === undefined
            ? undefined
            : turnedOffQueuedCommands(configService.get());
        const config = configService.update(
          updates.usageTelemetryEnabled === undefined
            ? updates
            : { ...updates, usageTelemetryConsentAnswered: true }
        );
        broadcastConfigChanged(config, event.sender);
        if (updates.usageTelemetryEnabled === false) {
          metricsCollectorService.discard();
        }
        // Apply zoom level to all windows when it changes
        if (updates.zoomLevel !== undefined) {
          windowService.setZoomLevelAll(updates.zoomLevel);
        }
        if (
          updates.directRemoteEnabled !== undefined ||
          updates.directRemoteKeepAwake !== undefined
        ) {
          await syncRemoteControlKeepAwake(config);
        }
        // SSH hosts' companions tell the CLI what is off while Komla is away (ADR 0006).
        if (
          turnedOffBefore &&
          !isDeepStrictEqual(turnedOffQueuedCommands(config), turnedOffBefore)
        ) {
          void remoteWorkspaceObservationService.reconcile();
        }
        if (updates.keepAwakeMode !== undefined) {
          keepAwakeService.setMode(config.keepAwakeMode);
        }
        if (updates.showAgentsInMenuBar !== undefined) {
          agentsMenuBarService.setEnabled(config.showAgentsInMenuBar);
        }
        if (updates.agentsMenuBarInBackgroundOnly !== undefined) {
          agentsMenuBarService.setInBackgroundOnly(config.agentsMenuBarInBackgroundOnly);
        }
        if (updates.agentsDoneClearedAt !== undefined) {
          agentsMenuBarService.setDoneClearedAt(config.agentsDoneClearedAt);
        }
        if (updates.directRemoteLocalAccess !== undefined) {
          // A connected device gets a new list and lets go of what it may no longer open.
          publishRemoteWorkspaceChange();
        }
        if (updates.directRemotePasskeyWindowMinutes !== undefined) {
          remoteControlHostAccessService.passkeyWindowChanged();
        }
        return config;
      }
    )
  );

  ipcMain.handle(IPC.SSH_LIST_HOSTS, async (): Promise<SshHost[]> => {
    return sshHostService.list();
  });

  ipcMain.handle(
    IPC.SSH_LIST_CONFIG_HOSTS,
    handleValidated(
      IPC.SSH_LIST_CONFIG_HOSTS,
      sshListConfigHostsArgsSchema,
      (): Promise<SshConfigHost[]> => listSshConfigHosts()
    )
  );

  ipcMain.handle(IPC.SSH_HOST_STATUSES_GET, (): SshHostStatus[] => sshHostStatusService.list());
  ipcMain.handle(
    IPC.SSH_HOST_CHECK,
    handleValidated(
      IPC.SSH_HOST_CHECK,
      sshCheckHostArgsSchema,
      (_, [hostId]): Promise<SshHostStatus | undefined> =>
        sshConnectionService.checkHost(sshWorkspaceService.getHost(hostId))
    )
  );
  sshHostStatusService.onChange((statuses) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.SSH_HOST_STATUSES_CHANGED, statuses);
    }
  });

  ipcMain.handle(
    IPC.SSH_SAVE_HOST,
    handleValidated(
      IPC.SSH_SAVE_HOST,
      sshSaveHostArgsSchema,
      async (_, [host]): Promise<SshHost> => {
        workspaceService.assertSshHostConnectionUpdateAllowed(host);
        const saved = sshHostService.save(host);
        sshWorkspaceService.forgetHost(saved.id);
        void sshPortForwardService.reconcileHostPortForwards(saved);
        broadcastSshHostsChanged();
        // A host added on this device brings along the workspaces other devices started there.
        if (!saved.setupPending) void workspaceService.sshSync.syncSoon(saved.id, { now: true });
        return saved;
      }
    )
  );

  ipcMain.handle(
    IPC.CONFIG_SAVE_OPENROUTER_API_KEY,
    handleValidated(
      IPC.CONFIG_SAVE_OPENROUTER_API_KEY,
      configSaveOpenRouterApiKeyArgsSchema,
      async (_, [apiKey]): Promise<void> => {
        await utilitySecretService.setOpenRouterApiKey(apiKey);
      }
    )
  );

  ipcMain.handle(
    IPC.CONFIG_CLEAR_OPENROUTER_API_KEY,
    handleValidated(
      IPC.CONFIG_CLEAR_OPENROUTER_API_KEY,
      configClearOpenRouterApiKeyArgsSchema,
      async (): Promise<void> => {
        await utilitySecretService.clearOpenRouterApiKey();
      }
    )
  );

  ipcMain.handle(
    IPC.CONFIG_GET_OPENROUTER_KEY_STATUS,
    handleValidated(
      IPC.CONFIG_GET_OPENROUTER_KEY_STATUS,
      configGetOpenRouterKeyStatusArgsSchema,
      async (): Promise<UtilityOpenRouterKeyStatus> => {
        const status = await utilitySecretService.getStatus();
        return {
          hasOpenRouterKey: status.hasKey,
          isUsingFallbackStorage: status.storage === 'file',
        };
      }
    )
  );

  ipcMain.handle(
    IPC.CONFIG_TEST_CUSTOM_ENDPOINT,
    handleValidated(
      IPC.CONFIG_TEST_CUSTOM_ENDPOINT,
      configTestCustomEndpointArgsSchema,
      async (): Promise<CustomEndpointTestResult> => {
        return utilityInferenceService.testCustomEndpoint();
      }
    )
  );

  ipcMain.handle(
    IPC.CONFIG_VERIFY_SSH_HOST,
    handleValidated(
      IPC.CONFIG_VERIFY_SSH_HOST,
      configVerifySshHostArgsSchema,
      async (_, [host, options]): Promise<SshHostSetupResult> => {
        return options?.prepare
          ? sshWorkspaceService.verifyAndPrepareHost(host)
          : sshWorkspaceService.checkHostCapabilities(host);
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_DELETE_HOST,
    handleValidated(
      IPC.SSH_DELETE_HOST,
      sshDeleteHostArgsSchema,
      async (_, [hostId, options]): Promise<{ deletedWorkspaceIds: string[] }> => {
        const result = await workspaceService.deleteSshHost(hostId, options);
        await sshPortForwardService.stopHostPortForwards(hostId);
        broadcastSshHostsChanged();
        return result;
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_GET_INTEGRATION_STATUS,
    handleValidated(
      IPC.SSH_GET_INTEGRATION_STATUS,
      sshGetIntegrationStatusArgsSchema,
      async (_, [hostId]): Promise<SshIntegrationStatus> => {
        return sshWorkspaceService.getIntegrationStatus(hostId);
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_GET_CACHED_INTEGRATION_UPDATES,
    handleValidated(
      IPC.SSH_GET_CACHED_INTEGRATION_UPDATES,
      sshGetCachedIntegrationUpdatesArgsSchema,
      async (): Promise<Record<string, SshIntegrationUpdates>> => {
        return sshWorkspaceService.getCachedIntegrationUpdates();
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_GET_PORT_FORWARD_STATUS,
    handleValidated(
      IPC.SSH_GET_PORT_FORWARD_STATUS,
      sshGetPortForwardStatusArgsSchema,
      async (_, [hostId]): Promise<SshPortForwardStatus> => {
        return sshPortForwardService.getHostPortForwardStatus(hostId);
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_LIST_FORWARDED_PORTS,
    handleValidated(
      IPC.SSH_LIST_FORWARDED_PORTS,
      sshListForwardedPortsArgsSchema,
      (): SshForwardedPort[] => sshPortForwardService.listForwardedPorts()
    )
  );

  ipcMain.handle(
    IPC.SSH_STOP_DESKTOP_FORWARD,
    handleValidated(
      IPC.SSH_STOP_DESKTOP_FORWARD,
      sshStopDesktopForwardArgsSchema,
      async (_, [hostId, remotePort]): Promise<void> => {
        await sshPortForwardService.stopDesktopForward(hostId, remotePort);
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_ENABLE_INTEGRATION,
    handleValidated(
      IPC.SSH_ENABLE_INTEGRATION,
      sshEnableIntegrationArgsSchema,
      async (_, [hostId, agent, type]): Promise<void> => {
        return sshWorkspaceService.enableIntegration(hostId, agent, type);
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_DISABLE_INTEGRATION,
    handleValidated(
      IPC.SSH_DISABLE_INTEGRATION,
      sshDisableIntegrationArgsSchema,
      async (_, [hostId, agent, type]): Promise<void> => {
        return sshWorkspaceService.disableIntegration(hostId, agent, type);
      }
    )
  );

  ipcMain.handle(
    IPC.SSH_SET_KOMLA_SKILL,
    handleValidated(
      IPC.SSH_SET_KOMLA_SKILL,
      sshSetKomlaSkillArgsSchema,
      async (_, [hostId, enabled]): Promise<void> => {
        return sshWorkspaceService.setKomlaSkill(hostId, enabled);
      }
    )
  );

  // Category handlers
  ipcMain.handle(IPC.CATEGORY_LIST, async (): Promise<Category[]> => {
    return categoryService.list();
  });

  ipcMain.handle(
    IPC.CATEGORY_CREATE,
    handleValidated(
      IPC.CATEGORY_CREATE,
      categoryCreateArgsSchema,
      async (_, [name, parentId]): Promise<Category> => {
        return categoryService.create(name, parentId);
      }
    )
  );

  ipcMain.handle(
    IPC.CATEGORY_UPDATE,
    handleValidated(
      IPC.CATEGORY_UPDATE,
      categoryUpdateArgsSchema,
      async (_, [id, updates]): Promise<Category> => {
        return categoryService.update(id, updates);
      }
    )
  );

  ipcMain.handle(
    IPC.CATEGORY_DELETE,
    handleValidated(
      IPC.CATEGORY_DELETE,
      categoryDeleteArgsSchema,
      async (_, [id]): Promise<void> => {
        return categoryService.delete(id);
      }
    )
  );

  ipcMain.handle(IPC.CATEGORY_GET_SETTINGS_PATH, async (): Promise<string> => {
    return categoryService.getSettingsPath();
  });
}

async function syncRemoteControlKeepAwake(config: AppConfig): Promise<void> {
  remoteControlKeepAwakeService.sync(config.directRemoteEnabled, config.directRemoteKeepAwake);
}
