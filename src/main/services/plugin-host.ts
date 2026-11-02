import { isSshWorkspace } from '../../shared/types/workspace';
import { onKomlaEvent } from '../lib/komla-events';

import { komlaCommandContext, KomlaOperationError } from './komla-operation/operation';
import { parseKomlaOperation } from './komla-operation/schema';
import { komlaOperationService } from './komla-operation.service';
import { pluginEnvironment } from './plugin-environment';
import { forkPluginProcess, PluginHostService, type HostedPlugin } from './plugin-host.service';
import { pluginSettingsStore } from './plugin-settings-store';
import { pluginsService } from './plugins.service';
import { sidebarPanelStates } from './sidebar-panel-states';
import { sidebarPanelsService } from './sidebar-panels.service';
import {
  canRunWorkspaceCommands,
  runLocalCommand,
  runWorkspaceCommand,
  WorkspaceCommandError,
} from './workspace-command';
import { workspaceService } from './workspace.service';

/** The most a plugin's command may print for its code. */
const MAX_EXEC_OUTPUT = 1024 * 1024;

/** Why a plugin's command failed, as its code gets it. */
function commandFailure(error: unknown): KomlaOperationError {
  const message = error instanceof Error ? error.message : String(error);
  return new KomlaOperationError('COMMAND_FAILED', message, 500, {
    ...(error instanceof WorkspaceCommandError && error.timedOut && { timedOut: true }),
  });
}

function execPluginCommand(
  plugin: HostedPlugin,
  command: string,
  workspaceId: string | undefined,
  timeoutMs: number
): Promise<string> | undefined {
  const options = { timeoutMs, maxOutput: MAX_EXEC_OUTPUT };
  if (!workspaceId) {
    const env = pluginEnvironment(plugin.source, true);
    return runLocalCommand(plugin.source.dir, command, { ...options, env }).catch((error) => {
      throw commandFailure(error);
    });
  }
  const workspace = workspaceService.get(workspaceId);
  if (!workspace) {
    return Promise.reject(
      new KomlaOperationError('WORKSPACE_NOT_FOUND', `Komla has no workspace ${workspaceId}.`, 404)
    );
  }
  if (!canRunWorkspaceCommands(workspace)) return undefined;
  // An SSH host doesn't have the plugin's folder or its secrets.
  return runWorkspaceCommand(workspace, command, {
    ...options,
    env: pluginEnvironment(plugin.source, !isSshWorkspace(workspace)),
  }).catch((error) => {
    throw commandFailure(error);
  });
}

export const pluginHostService = new PluginHostService({
  fork: forkPluginProcess,
  // A workspace the code names is one to act on, as `--workspace` names it, not where it runs.
  execute: (request, workspaceId) =>
    komlaOperationService.execute(
      komlaCommandContext(workspaceId ? { targetWorkspaceId: workspaceId } : {}),
      parseKomlaOperation(request)
    ),
  exec: execPluginCommand,
  states: sidebarPanelStates,
  panelScope: (panelId, workspaceId) => sidebarPanelsService.scope(panelId, workspaceId),
  onEvent: onKomlaEvent,
  settings: (pluginId) =>
    pluginSettingsStore.values(pluginId, pluginsService.settingFields(pluginId)),
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

let stopFollowing: (() => void) | undefined;
let stopped = false;

/**
 * Runs the code of the plugins that run, following changes to them; not once stopped, as when
 * the keychain answers after the user quit.
 */
export function startPluginHost(): void {
  if (stopFollowing || stopped) return;
  const sync = () => pluginHostService.sync(pluginsService.hostedPlugins());
  // Every plugin's only once they load, which the host waits for before it starts.
  const stopSettings = pluginSettingsStore.onChange((pluginId) => {
    if (pluginId) pluginHostService.settingsChanged(pluginId);
  });
  const stopPlugins = pluginsService.onChange(sync);
  stopFollowing = () => {
    stopPlugins();
    stopSettings();
  };
  sync();
}

export function stopPluginHost(): void {
  stopped = true;
  stopFollowing?.();
  stopFollowing = undefined;
  pluginHostService.stopAll();
}
