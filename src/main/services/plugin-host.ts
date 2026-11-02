import { isSshWorkspace } from '../../shared/types/workspace';
import { onKomlaEvent } from '../lib/komla-events';

import { komlaCommandContext, KomlaOperationError } from './komla-operation/operation';
import { parseKomlaOperation } from './komla-operation/schema';
import { komlaOperationService } from './komla-operation.service';
import { forkPluginProcess, PluginHostService, type HostedPlugin } from './plugin-host.service';
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
  const env = { KOMLA_PLUGIN_DIR: plugin.source.dir };
  const options = { timeoutMs, maxOutput: MAX_EXEC_OUTPUT };
  if (!workspaceId) {
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
  // An SSH host doesn't have the plugin's folder.
  return runWorkspaceCommand(workspace, command, {
    ...options,
    ...(!isSshWorkspace(workspace) && { env }),
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
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

let stopFollowing: (() => void) | undefined;

/** Runs the code of the plugins that run, following changes to them. */
export function startPluginHost(): void {
  if (stopFollowing) return;
  const sync = () => pluginHostService.sync(pluginsService.hostedPlugins());
  stopFollowing = pluginsService.onChange(sync);
  sync();
}

export function stopPluginHost(): void {
  stopFollowing?.();
  stopFollowing = undefined;
  pluginHostService.stopAll();
}
