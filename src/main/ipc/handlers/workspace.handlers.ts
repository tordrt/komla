import { execFile } from 'child_process';
import { realpath } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { promisify } from 'util';

import { BrowserWindow, ipcMain } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import {
  WORKSPACE_LIMIT_ERROR_PREFIX,
  DUPLICATE_WORKSPACE_ERROR_PREFIX,
  SshProjectNeedsRemoteError,
  isSshWorkspace,
  type WorkspaceCreateBatchResult,
  type WorkspaceCreateError,
  type WorkspaceCreateResult,
  type WorkspaceRestartResult,
} from '../../../shared/types/workspace';
import { createLogger } from '../../lib/logger';
import { removePath } from '../../lib/remove-path';
import { buildTerminalEnv } from '../../lib/shell';
import { getConfiguredShellCommand } from '../../lib/shell-command';
import { configService } from '../../services/config.service';
import { localMirrorService } from '../../services/local-mirror.service';
import { projectService } from '../../services/project.service';
import { sshPortForwardService } from '../../services/ssh-port-forward.service';
import { sshWorkspaceService } from '../../services/ssh-workspace.service';
import {
  workspaceLinksService,
  type WorkspaceLinkPath,
} from '../../services/workspace-links.service';
import { workspaceService, Workspace, Terminal } from '../../services/workspace.service';
import { worktreeWatcherService } from '../../services/worktree-watcher.service';
import { handleValidated } from '../validation/ipc-validators';
import {
  clearAttentionArgsSchema,
  clearTerminalAttentionArgsSchema,
  generateBranchNameArgsSchema,
  regenerateWorkspaceNameArgsSchema,
  terminalAttentionSeenArgsSchema,
  workspaceAddAgentTabArgsSchema,
  workspaceAddTerminalArgsSchema,
  workspaceCreateBatchArgsSchema,
  workspaceCreateArgsSchema,
  workspaceDeleteArgsSchema,
  workspaceGetArgsSchema,
  workspaceLinkArgsSchema,
  workspaceRemoveTerminalArgsSchema,
  workspaceReconnectSshTerminalArgsSchema,
  workspaceFindInSshTerminalArgsSchema,
  workspaceRecoverSshSessionsArgsSchema,
  workspaceListRemoteSshArgsSchema,
  workspaceAdoptRemoteSshArgsSchema,
  workspaceLinkPathsArgsSchema,
  workspaceLinkSshProjectArgsSchema,
  workspaceRemoveMissingSshArgsSchema,
  workspaceSyncSshHostArgsSchema,
  workspaceRetryLocalMirrorSyncArgsSchema,
  workspaceRetrySetupStepArgsSchema,
  workspaceDismissSetupActivityArgsSchema,
  workspaceRunBackgroundActionArgsSchema,
  workspaceStopBackgroundActionRunArgsSchema,
  workspaceReorderArgsSchema,
  workspaceRestartArgsSchema,
  workspaceRestartTerminalArgsSchema,
  workspaceSetManualSpinnerArgsSchema,
  workspaceStartSshLinkForwardArgsSchema,
  workspaceStartSshPreviewForwardArgsSchema,
  workspaceStopArgsSchema,
  workspaceStopSshLinkForwardArgsSchema,
  workspaceStopSshPreviewForwardArgsSchema,
  workspaceStopTerminalArgsSchema,
  workspaceUnlinkArgsSchema,
  workspaceUpdateArgsSchema,
  workspaceUpdateTerminalArgsSchema,
} from '../validation/workspace-ipc.schemas';

import type { ManagedTmuxFindResult } from '../../../shared/lib/ssh-tmux-attach';
import type { SshLinkForward, SshPreviewForward, SshWorkspaceBackend } from '../../../shared/types';
import type { RemoteSshWorkspace } from '../../../shared/types/ssh-workspace-manifest';

const execFileAsync = promisify(execFile);
const TRASH_SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;
const logger = createLogger('WorkspaceHandlers');
const SIMPLE_RM_RF_PATTERN = /^\s*rm\s+-(?:rf|fr)\s+(.+?)\s*$/;
// Allowlist: relative POSIX path chars only. Anything with shell metacharacters
// (&, ;, |, >, <, $, `, parens, etc.) falls back to shell exec so we never
// silently treat `rm -rf foo && bar` as the literal paths "foo", "&&", "bar".
const SAFE_PATH_TOKEN = /^[A-Za-z0-9._\-/]+$/;

/** The backend of an SSH workspace, whose ports Komla can forward. */
function sshWorkspaceBackend(workspaceId: string): SshWorkspaceBackend {
  const workspace = workspaceService.get(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }
  if (!isSshWorkspace(workspace)) {
    throw new Error('SSH preview forwarding is only available for SSH workspaces');
  }
  return workspace.backend;
}

function isExpectedWorkspaceCreateError(message: string): boolean {
  return (
    message.includes(WORKSPACE_LIMIT_ERROR_PREFIX) ||
    message.includes(DUPLICATE_WORKSPACE_ERROR_PREFIX) ||
    message.includes('already open in workspace') ||
    message.includes('already has an active worktree')
  );
}

/** Expected user-facing create errors, as values, so Electron doesn't log them as IPC errors. */
function workspaceCreateErrorValue(error: unknown): WorkspaceCreateError | null {
  if (error instanceof SshProjectNeedsRemoteError) {
    return {
      __workspaceCreateError: true,
      message: error.message,
      sshProjectNeedsRemote: error.detail,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return isExpectedWorkspaceCreateError(message) ? { __workspaceCreateError: true, message } : null;
}

function parseSimpleRmRfScript(script: string): string[] | null {
  const match = SIMPLE_RM_RF_PATTERN.exec(script);
  if (!match) return null;

  const paths = match[1].split(/\s+/).filter(Boolean);
  if (paths.length === 0) return null;

  for (const path of paths) {
    if (
      path === '.' ||
      path.startsWith('-') ||
      !SAFE_PATH_TOKEN.test(path) ||
      isAbsolute(path) ||
      path.split('/').includes('..')
    ) {
      return null;
    }
  }

  return paths;
}

async function runSimpleRmRfScript(paths: string[], cwd: string): Promise<void> {
  const cwdPath = resolve(cwd);
  // realpath the workspace once so symlinked workspace roots still match.
  let realCwd: string;
  try {
    realCwd = await realpath(cwdPath);
  } catch {
    realCwd = cwdPath;
  }

  for (const path of paths) {
    const target = resolve(cwdPath, path);
    const relativeTarget = relative(cwdPath, target);
    if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
      throw new Error(`Refusing to remove path outside workspace: ${path}`);
    }
    // resolve() is purely lexical, so a symlinked intermediate (e.g. vendor ->
    // /shared) would let `rm` follow the link and delete outside the workspace.
    // Realpath the target's parent and re-check containment. If the parent
    // doesn't exist, the target can't exist either — skip it (force:true would).
    const parent = dirname(target);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      continue;
    }
    const relativeParent = relative(realCwd, realParent);
    if (relativeParent !== '' && (relativeParent.startsWith('..') || isAbsolute(relativeParent))) {
      throw new Error(`Refusing to remove path outside workspace: ${path}`);
    }
    await removePath(target, { recursive: true, force: true });
  }
}

async function runWorkspaceTrashScript(workspace: Workspace): Promise<void> {
  if (!workspace.projectId) return;
  const project = projectService.get(workspace.projectId);
  const script = project?.trashCleanupScript?.trim();
  if (!script) return;

  // Directory-mode workspaces point at the user's real project directory, so a
  // destructive cleanup would delete files from there. Skip for safety.
  if (!workspace.isWorktree) {
    logger.info(
      `Skipping trash cleanup for ${workspace.id}: workspace is a directory project, not a worktree`
    );
    return;
  }

  logger.info(`Running trash cleanup for ${workspace.id} in ${workspace.workingDirectory}`);
  const startedAt = Date.now();
  try {
    if (isSshWorkspace(workspace)) {
      await sshWorkspaceService.runTrashCleanup(workspace.backend, script);
    } else {
      const simpleRmPaths = parseSimpleRmRfScript(script);
      if (simpleRmPaths) {
        await runSimpleRmRfScript(simpleRmPaths, workspace.workingDirectory);
      } else {
        const { shell, args } = getConfiguredShellCommand(script, configService.get().wslDistro);
        await execFileAsync(shell, args, {
          cwd: workspace.workingDirectory,
          env: buildTerminalEnv(),
          timeout: TRASH_SCRIPT_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });
      }
    }
    logger.info(`Trash cleanup for ${workspace.id} finished in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rawStderr =
      error && typeof error === 'object' && 'stderr' in error
        ? (error as { stderr?: unknown }).stderr
        : undefined;
    const stderr = typeof rawStderr === 'string' ? rawStderr.trim() : '';
    logger.error(
      `Trash cleanup for ${workspace.id} failed after ${Date.now() - startedAt}ms: ${message}${
        stderr ? `\nstderr: ${stderr}` : ''
      }`
    );
    const detail = stderr ? `${message}\n${stderr}` : message;
    throw new Error(`Trash cleanup script failed: ${detail}`);
  }
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    IPC.WORKSPACE_CREATE,
    handleValidated(
      IPC.WORKSPACE_CREATE,
      workspaceCreateArgsSchema,
      async (_, [params]): Promise<WorkspaceCreateResult> => {
        try {
          return await workspaceService.create(params);
        } catch (error) {
          const value = workspaceCreateErrorValue(error);
          if (value) return value;
          throw error;
        }
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_CREATE_BATCH,
    handleValidated(
      IPC.WORKSPACE_CREATE_BATCH,
      workspaceCreateBatchArgsSchema,
      async (_, [params]): Promise<WorkspaceCreateBatchResult> => {
        try {
          return await workspaceService.createBatch(params);
        } catch (error) {
          const value = workspaceCreateErrorValue(error);
          if (value) return value;
          throw error;
        }
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_ADD_TERMINAL,
    handleValidated(
      IPC.WORKSPACE_ADD_TERMINAL,
      workspaceAddTerminalArgsSchema,
      async (
        _,
        [workspaceId, name, command, layoutHint, commandKind, executionLocation]
      ): Promise<Terminal> => {
        return workspaceService.addTerminalWithPreparation(
          workspaceId,
          name,
          command,
          layoutHint,
          commandKind,
          executionLocation
        );
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_ADD_AGENT_TAB,
    handleValidated(
      IPC.WORKSPACE_ADD_AGENT_TAB,
      workspaceAddAgentTabArgsSchema,
      async (_, [workspaceId, prompt, launchModeId, presetId, options]): Promise<Terminal> => {
        return workspaceService.addAgentTab(workspaceId, prompt, launchModeId, presetId, options);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_REMOVE_TERMINAL,
    handleValidated(
      IPC.WORKSPACE_REMOVE_TERMINAL,
      workspaceRemoveTerminalArgsSchema,
      async (_, [workspaceId, terminalId]): Promise<void> => {
        return workspaceService.removeTerminal(workspaceId, terminalId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_STOP,
    handleValidated(
      IPC.WORKSPACE_STOP,
      workspaceStopArgsSchema,
      async (_, [workspaceId]): Promise<void> => {
        return workspaceService.stop(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_STOP_TERMINAL,
    handleValidated(
      IPC.WORKSPACE_STOP_TERMINAL,
      workspaceStopTerminalArgsSchema,
      async (_, [terminalId]): Promise<void> => {
        return workspaceService.stopTerminal(terminalId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RESTART_TERMINAL,
    handleValidated(
      IPC.WORKSPACE_RESTART_TERMINAL,
      workspaceRestartTerminalArgsSchema,
      async (_, [terminalId, presetId, launchModeId, cols, rows, options]): Promise<Terminal> => {
        if (!options) {
          return workspaceService.restartTerminal(
            terminalId,
            presetId,
            launchModeId ?? undefined,
            cols,
            rows
          );
        }
        const { replaceSession, ...restartOptions } = options;
        return workspaceService.restartTerminal(
          terminalId,
          presetId,
          launchModeId ?? undefined,
          cols,
          rows,
          {
            ...restartOptions,
            sshAction: replaceSession ? 'replace' : undefined,
          }
        );
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RECONNECT_SSH_TERMINAL,
    handleValidated(
      IPC.WORKSPACE_RECONNECT_SSH_TERMINAL,
      workspaceReconnectSshTerminalArgsSchema,
      async (_, [terminalId, cols, rows]): Promise<Terminal> => {
        return workspaceService.reconnectSshTerminal(terminalId, cols, rows);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_FIND_IN_SSH_TERMINAL,
    handleValidated(
      IPC.WORKSPACE_FIND_IN_SSH_TERMINAL,
      workspaceFindInSshTerminalArgsSchema,
      async (_, [terminalId, query]): Promise<ManagedTmuxFindResult> => {
        return workspaceService.findInSshTerminal(terminalId, query);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RECOVER_SSH_SESSIONS,
    handleValidated(
      IPC.WORKSPACE_RECOVER_SSH_SESSIONS,
      workspaceRecoverSshSessionsArgsSchema,
      async (_, [workspaceId]): Promise<Workspace | undefined> => {
        return workspaceService.recoverSshSessions(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_LIST_REMOTE_SSH,
    handleValidated(
      IPC.WORKSPACE_LIST_REMOTE_SSH,
      workspaceListRemoteSshArgsSchema,
      async (_, [hostId]): Promise<RemoteSshWorkspace[]> =>
        workspaceService.sshSync.listOnHost(hostId)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_ADOPT_REMOTE_SSH,
    handleValidated(
      IPC.WORKSPACE_ADOPT_REMOTE_SSH,
      workspaceAdoptRemoteSshArgsSchema,
      async (_, [hostId, workspaceId]): Promise<Workspace> =>
        workspaceService.sshSync.adopt(hostId, workspaceId)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_LINK_SSH_PROJECT,
    handleValidated(
      IPC.WORKSPACE_LINK_SSH_PROJECT,
      workspaceLinkSshProjectArgsSchema,
      async (_, [workspaceId, projectId]): Promise<void> =>
        workspaceService.linkSshWorkspaceToProject(workspaceId, projectId)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_REMOVE_MISSING_SSH,
    handleValidated(
      IPC.WORKSPACE_REMOVE_MISSING_SSH,
      workspaceRemoveMissingSshArgsSchema,
      async (_, [workspaceId]): Promise<void> => workspaceService.sshSync.removeMissing(workspaceId)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_SYNC_SSH_HOST,
    handleValidated(
      IPC.WORKSPACE_SYNC_SSH_HOST,
      workspaceSyncSshHostArgsSchema,
      async (_, [hostId]): Promise<void> => {
        sshWorkspaceService.getHost(hostId);
        await workspaceService.sshSync.syncSoon(hostId, { now: true });
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RETRY_SETUP_STEP,
    handleValidated(
      IPC.WORKSPACE_RETRY_SETUP_STEP,
      workspaceRetrySetupStepArgsSchema,
      async (_, [workspaceId, stepId]): Promise<Workspace> => {
        return workspaceService.retrySetupStep(workspaceId, stepId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RETRY_LOCAL_MIRROR_SYNC,
    handleValidated(
      IPC.WORKSPACE_RETRY_LOCAL_MIRROR_SYNC,
      workspaceRetryLocalMirrorSyncArgsSchema,
      async (_, [workspaceId]): Promise<void> => {
        workspaceService.retryLocalMirrorSync(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_DISMISS_SETUP_ACTIVITY,
    handleValidated(
      IPC.WORKSPACE_DISMISS_SETUP_ACTIVITY,
      workspaceDismissSetupActivityArgsSchema,
      async (_, [workspaceId, activityId]): Promise<Workspace> => {
        return workspaceService.dismissSetupActivity(workspaceId, activityId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RUN_BACKGROUND_ACTION,
    handleValidated(
      IPC.WORKSPACE_RUN_BACKGROUND_ACTION,
      workspaceRunBackgroundActionArgsSchema,
      async (_, [workspaceId, actionId, launch]): Promise<Workspace> => {
        return workspaceService.runBackgroundAction(workspaceId, actionId, launch);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_STOP_BACKGROUND_ACTION_RUN,
    handleValidated(
      IPC.WORKSPACE_STOP_BACKGROUND_ACTION_RUN,
      workspaceStopBackgroundActionRunArgsSchema,
      async (_, [workspaceId, activityId]): Promise<void> => {
        return workspaceService.stopBackgroundActionRun(workspaceId, activityId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_DELETE,
    handleValidated(
      IPC.WORKSPACE_DELETE,
      workspaceDeleteArgsSchema,
      async (_, [workspaceId, force = false, deleteBranch = false]): Promise<void> => {
        return workspaceService.delete(workspaceId, force, deleteBranch);
      }
    )
  );

  ipcMain.handle(IPC.WORKSPACE_LIST, async (): Promise<Workspace[]> => {
    return workspaceService.list();
  });

  ipcMain.handle(
    IPC.WORKSPACE_GET,
    handleValidated(
      IPC.WORKSPACE_GET,
      workspaceGetArgsSchema,
      async (_, [workspaceId]): Promise<Workspace | undefined> => {
        return workspaceService.get(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_UPDATE,
    handleValidated(
      IPC.WORKSPACE_UPDATE,
      workspaceUpdateArgsSchema,
      async (event, [workspaceId, updates]): Promise<Workspace> => {
        // Get current workspace state to detect dormancy transitions
        const currentWorkspace = workspaceService.get(workspaceId);
        const wasDormant = currentWorkspace?.status !== 'active';

        const isTrashing =
          currentWorkspace !== undefined &&
          currentWorkspace.status !== 'trashed' &&
          updates.status === 'trashed';

        if (
          currentWorkspace &&
          isSshWorkspace(currentWorkspace) &&
          currentWorkspace.status === 'active' &&
          updates.status === 'trashed'
        ) {
          // Enforce remote cleanup in main even if a renderer's best-effort
          // pre-stop failed. Never hide a workspace while its agent may run.
          await workspaceService.stop(workspaceId);
        }

        if (isTrashing && currentWorkspace) {
          // The stop's steps, such as `docker compose down`, end before the Trash cleans up.
          await workspaceService.stopStepsSettled(workspaceId);
          // Suspend the worktree watcher across cleanup so deleting node_modules /
          // build outputs doesn't fire a flood of change events. The renderer
          // trash flow stops PTYs (which stops the watcher) before this IPC
          // call, so trust the actual watcher state, not workspace.status.
          const watcherWasActive =
            !isSshWorkspace(currentWorkspace) && worktreeWatcherService.isWatching(workspaceId);
          if (watcherWasActive) {
            await worktreeWatcherService.stopWatching(workspaceId).catch(() => {});
          }
          try {
            await runWorkspaceTrashScript(currentWorkspace);
          } catch (error) {
            if (watcherWasActive) {
              worktreeWatcherService
                .startWatching(workspaceId, currentWorkspace.workingDirectory)
                .catch((err) => {
                  console.error(
                    `Failed to restart watcher after trash cleanup failure for ${workspaceId}:`,
                    err
                  );
                });
            }
            throw error;
          }
        }

        if (isTrashing && currentWorkspace) {
          if (isSshWorkspace(currentWorkspace)) {
            await localMirrorService.remove(workspaceId, currentWorkspace.backend);
          }
          currentWorkspace.setupActivities = undefined;
        }

        const result = workspaceService.update(workspaceId, updates);

        const isDormant = result.status !== 'active';

        if (wasDormant !== isDormant) {
          if (isDormant) {
            worktreeWatcherService.stopWatching(workspaceId).catch((err) => {
              console.error(`Failed to stop watcher for dormant workspace ${workspaceId}:`, err);
            });
          } else {
            worktreeWatcherService
              .startWatching(workspaceId, result.workingDirectory)
              .catch((err) => {
                console.error(
                  `Failed to start watcher for activated workspace ${workspaceId}:`,
                  err
                );
              });
          }
        }

        return result;
      }
    )
  );

  // Notify all other windows that workspace data has changed (used after bulk operations)
  ipcMain.handle(IPC.WORKSPACE_NOTIFY_CHANGED, (event) => {
    const senderId = event.sender?.id;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents.id !== senderId) {
        win.webContents.send(IPC.WORKSPACES_CHANGED);
      }
    }
  });

  ipcMain.handle(
    IPC.WORKSPACE_UPDATE_TERMINAL,
    handleValidated(
      IPC.WORKSPACE_UPDATE_TERMINAL,
      workspaceUpdateTerminalArgsSchema,
      async (_, [terminalId, updates]): Promise<Terminal> => {
        return workspaceService.updateTerminal(terminalId, updates);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_RESTART,
    handleValidated(
      IPC.WORKSPACE_RESTART,
      workspaceRestartArgsSchema,
      async (_, [workspaceId]): Promise<WorkspaceRestartResult> => {
        try {
          return await workspaceService.restartWithCleanup(workspaceId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Expected user-facing errors: return as values instead of throwing
          // so Electron doesn't log them as IPC errors.
          if (message.includes(WORKSPACE_LIMIT_ERROR_PREFIX)) {
            return { __workspaceRestartError: true, message };
          }
          throw error;
        }
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_REORDER,
    handleValidated(
      IPC.WORKSPACE_REORDER,
      workspaceReorderArgsSchema,
      async (_, [workspaceId, newOrder]): Promise<void> => {
        return workspaceService.reorderWorkspace(workspaceId, newOrder);
      }
    )
  );

  ipcMain.handle(
    IPC.NOTIFICATIONS_CLEAR_ATTENTION,
    handleValidated(
      IPC.NOTIFICATIONS_CLEAR_ATTENTION,
      clearAttentionArgsSchema,
      (_, [workspaceId]) => {
        workspaceService.attention.workspaceSeen(workspaceId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_CLEAR_TERMINAL_ATTENTION,
    handleValidated(
      IPC.WORKSPACE_CLEAR_TERMINAL_ATTENTION,
      clearTerminalAttentionArgsSchema,
      (_, [terminalId]): void => {
        workspaceService.attention.dismissed(terminalId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_TERMINAL_ATTENTION_SEEN,
    handleValidated(
      IPC.WORKSPACE_TERMINAL_ATTENTION_SEEN,
      terminalAttentionSeenArgsSchema,
      (_, [terminalId]): void => {
        workspaceService.attention.terminalSeen(terminalId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_GENERATE_BRANCH_NAME,
    handleValidated(
      IPC.WORKSPACE_GENERATE_BRANCH_NAME,
      generateBranchNameArgsSchema,
      async (_, [promptText]): Promise<string | null> => {
        return workspaceService.generateBranchName(promptText);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_REGENERATE_NAME,
    handleValidated(
      IPC.WORKSPACE_REGENERATE_NAME,
      regenerateWorkspaceNameArgsSchema,
      async (_, [workspaceId]): Promise<Workspace> => {
        return workspaceService.regenerateWorkspaceName(workspaceId);
      }
    )
  );

  ipcMain.handle(IPC.WORKSPACE_CANCEL_BRANCH_NAMING, async (): Promise<void> => {
    workspaceService.cancelBranchNaming();
  });

  ipcMain.handle(
    IPC.WORKSPACE_LINK,
    handleValidated(
      IPC.WORKSPACE_LINK,
      workspaceLinkArgsSchema,
      async (_, [originId, targetIds]): Promise<void> => {
        await workspaceLinksService.link(originId, targetIds);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_UNLINK,
    handleValidated(
      IPC.WORKSPACE_UNLINK,
      workspaceUnlinkArgsSchema,
      async (_, [originId, targetId]): Promise<void> => {
        await workspaceLinksService.unlink(originId, targetId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_LINK_PATHS,
    handleValidated(
      IPC.WORKSPACE_LINK_PATHS,
      workspaceLinkPathsArgsSchema,
      (_, [workspaceId]): Promise<WorkspaceLinkPath[]> =>
        workspaceLinksService.listLinkPaths(workspaceId)
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_SET_MANUAL_SPINNER,
    handleValidated(
      IPC.WORKSPACE_SET_MANUAL_SPINNER,
      workspaceSetManualSpinnerArgsSchema,
      (_, [workspaceId, active]): void => {
        workspaceService.attention.spinnerToggled(workspaceId, active);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_START_SSH_PREVIEW_FORWARD,
    handleValidated(
      IPC.WORKSPACE_START_SSH_PREVIEW_FORWARD,
      workspaceStartSshPreviewForwardArgsSchema,
      async (_, [workspaceId, tabId, remotePort, scheme]): Promise<SshPreviewForward> => {
        return sshPortForwardService.startPreviewForward({
          workspaceId,
          tabId,
          backend: sshWorkspaceBackend(workspaceId),
          remotePort,
          scheme,
        });
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_STOP_SSH_PREVIEW_FORWARD,
    handleValidated(
      IPC.WORKSPACE_STOP_SSH_PREVIEW_FORWARD,
      workspaceStopSshPreviewForwardArgsSchema,
      async (_, [workspaceId, tabId]): Promise<void> => {
        await sshPortForwardService.stopPreviewForward(workspaceId, tabId);
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_START_SSH_LINK_FORWARD,
    handleValidated(
      IPC.WORKSPACE_START_SSH_LINK_FORWARD,
      workspaceStartSshLinkForwardArgsSchema,
      async (_, [workspaceId, remotePort, scheme]): Promise<SshLinkForward> => {
        return sshPortForwardService.startLinkForward({
          workspaceId,
          backend: sshWorkspaceBackend(workspaceId),
          remotePort,
          scheme,
        });
      }
    )
  );

  ipcMain.handle(
    IPC.WORKSPACE_STOP_SSH_LINK_FORWARD,
    handleValidated(
      IPC.WORKSPACE_STOP_SSH_LINK_FORWARD,
      workspaceStopSshLinkForwardArgsSchema,
      async (_, [workspaceId, forwardId]): Promise<void> => {
        await sshPortForwardService.stopLinkForward(workspaceId, forwardId);
      }
    )
  );
}
