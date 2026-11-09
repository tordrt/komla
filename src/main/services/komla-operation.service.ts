import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { resolveWorkspaceCreationEnvironment } from '../../shared/lib/agent-environment';
import { normalizeWorkspaceTags } from '../../shared/lib/workspace-tags';
import { createLogger } from '../lib/logger';

import { agentPresetService } from './agent-preset.service';
import { configService } from './config.service';
import { gitService } from './git.service';
import { watchAgentTurnEnd } from './komla-operation/agent-turn-end';
import {
  KomlaOperationError,
  KomlaOperationService,
  type KomlaOperationDependencies,
} from './komla-operation/operation';
import { notificationDeliveryService } from './notification-delivery.service';
import { requestOpenFolder } from './open-folder-request';
import { getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { ptyService } from './pty.service';
import { sshHostService } from './ssh-host.service';
import { statusCommandsService } from './status-commands.service';
import { statusItemsService } from './status-items.service';
import { approveTerminalSend } from './terminal-send-approval';
import { getVncAppName, openInVncApp } from './virtual-desktop.service';
import { windowService } from './window.service';
import {
  NO_MATCHING_WORKSPACE,
  workspaceCwdResolutionService,
} from './workspace-cwd-resolution.service';
import { workspaceLinksService } from './workspace-links.service';
import { workspaceService } from './workspace.service';

import type { NewWorkspaceDraft } from '../../shared/types/workspace';

const logger = createLogger('KomlaOperationService');

export type {
  AgentLaunchResult,
  KomlaOperation,
  KomlaOperationContext,
  KomlaOperationDependencies,
  KomlaOperationResult,
} from './komla-operation/operation';
export {
  komlaCommandContext,
  KomlaOperationError,
  KomlaOperationService,
} from './komla-operation/operation';

function projectRepoPath(projectId: string): string | undefined {
  const project = projectService.get(projectId);
  if (!project) return undefined;
  return project.managed && project.managedRepoPath
    ? project.managedRepoPath
    : project.repositoryPath;
}

/** Whether an agent, not a `komla notify --` command, is mid-turn in the terminal. */
function isAgentTurnActive(terminalId: string): boolean {
  return (
    workspaceService
      .findWorkspaceByTerminalId(terminalId)
      ?.terminals.some(
        (terminal) => terminal.id === terminalId && terminal.agentActive && !terminal.commandActive
      ) === true
  );
}

const productionDependencies: KomlaOperationDependencies = {
  getConfig: () => configService.get(),
  listPresets: () => agentPresetService.list(),
  getActivePresets: () => agentPresetService.getActivePresets(),
  listProjects: () => projectService.list(),
  getWorkspace: (id) => workspaceService.get(id),
  listWorkspaces: () => workspaceService.list(),
  workspaceTags: () => normalizeWorkspaceTags(configService.get().workspaceTags),
  saveWorkspaceTags: (tags) => {
    const config = configService.update({ workspaceTags: [...tags] });
    windowService.broadcastToAll(IPC.CONFIG_CHANGED, config);
  },
  findWorkspaceByTerminalId: (id) => workspaceService.findWorkspaceByTerminalId(id),
  getProject: (id) => projectService.get(id),
  getProjectRemoteUrl: async (id) => {
    const repoPath = projectRepoPath(id);
    if (!repoPath) return null;
    return gitService.getRemoteUrl(repoPath).catch(() => null);
  },
  resolveWorkspaceByCwd: (cwd, sshHostId) =>
    workspaceCwdResolutionService.resolveWorkspaceByCwd(
      cwd,
      {
        workspaces: workspaceService
          .list()
          .filter(
            (workspace) =>
              !sshHostId ||
              (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === sshHostId)
          ),
        getProject: (id) => projectService.get(id),
        komlaBasePath: getKomlaBasePath(),
      },
      { rejectAmbiguousMatches: true }
    ),
  resolveProjectByCwd: (cwd, sshHostId) => {
    const resolution = workspaceCwdResolutionService.findProjectByCwd(cwd, {
      workspaces: workspaceService
        .list()
        .filter(
          (workspace) =>
            !sshHostId ||
            (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === sshHostId)
        ),
      getProject: (id) => projectService.get(id),
      komlaBasePath: getKomlaBasePath(),
    });
    // A cwd outside every workspace isn't ambiguous: the launch names its project instead.
    return resolution.error === NO_MATCHING_WORKSPACE ? {} : resolution;
  },
  resolveEnvironment: () =>
    resolveWorkspaceCreationEnvironment({
      ...configService.get(),
      sshHosts: sshHostService.list(),
    }).environment,
  isSshHostReady: (hostId) => sshHostService.isReady(hostId),
  listSshHosts: () => sshHostService.list(),
  getCheckedOutBranch: async (workspace) => {
    // Status snapshots keep an SSH workspace's branch current; a local one is read from Git.
    if (workspace.backend?.kind === 'ssh' || !workspace.workingDirectory) {
      return workspace.branchName;
    }
    return gitService.getCheckedOutBranch(workspace.workingDirectory);
  },
  isBranchOnOrigin: async (projectId, branch) => {
    const repoPath = projectRepoPath(projectId);
    if (!repoPath) return false;
    const startPoint = await gitService
      .fetchOriginStartPoint(repoPath, branch)
      .catch(() => undefined);
    return startPoint !== undefined;
  },
  createWorkspace: (params) => workspaceService.create(params),
  addAgentTab: (...args) => workspaceService.addAgentTab(...args),
  updateWorkspace: (id, updates) => workspaceService.update(id, updates),
  linkWorkspaces: (originId, targetIds) => workspaceLinksService.link(originId, targetIds),
  unlinkWorkspace: (originId, targetId) => workspaceLinksService.unlink(originId, targetId),
  notify: async ({ id }, target, notification) => {
    const workspace = workspaceService.get(id);
    if (!workspace) {
      throw new KomlaOperationError(
        'WORKSPACE_NOT_FOUND',
        'The current Komla workspace no longer exists.',
        404
      );
    }
    await notificationDeliveryService.notify({ workspace, ...target }, notification);
  },
  setStatusItem: (workspaceId, id, content) =>
    statusItemsService.set(workspaceId, id, content) !== undefined,
  clearStatusItems: (workspaceId, id) => statusItemsService.clear(workspaceId, id),
  refreshStatusCommand: (workspaceId, id) => statusCommandsService.refresh(workspaceId, id),
  publish: (channel, payload) => {
    if (channel === IPC.WORKSPACE_OPEN_DEV_PREVIEW || channel === IPC.VIRTUAL_DESKTOP_STARTED) {
      // One window opens the page or says the desktop started: the one showing the workspace,
      // else the main window, else the next one to open.
      const { workspaceId } = payload as { workspaceId: string };
      windowService.sendToWindowOrNext(
        workspaceService.get(workspaceId)?.windowId,
        channel,
        payload
      );
      return;
    }
    if (channel === IPC.NEW_WORKSPACE_DRAFT) {
      // The window showing the calling workspace opens New Workspace, brought forward since the
      // call can come from a terminal outside Komla.
      const { workspaceId } = payload as NewWorkspaceDraft;
      const windowId =
        (workspaceId && workspaceService.get(workspaceId)?.windowId) ||
        windowService.getMainWindowId();
      const window = windowId ? windowService.getWindow(windowId) : undefined;
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      windowService.sendToWindowOrNext(windowId, channel, payload);
      return;
    }
    if (channel === IPC.WORKSPACE_CREATED) {
      for (const windowId of windowService.getAllWindowIds()) {
        windowService.sendWhenReady(windowId, channel, payload);
      }
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        window.webContents.send(channel, payload);
      } catch (error) {
        logger.warn('Failed to publish Komla operation result', {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },
  getMainWindowId: () => windowService.getMainWindowId(),
  getVncAppName,
  isWorkspaceShown: (workspaceId) => windowService.isWorkspaceShown(workspaceId),
  isAgentTurnActive,
  watchAgentTurnEnd: (workspaceId, terminalId, ended) =>
    watchAgentTurnEnd(
      {
        isTurnActive: isAgentTurnActive,
        onWorkspaceUpdated: (listener) =>
          workspaceService.onWorkspaceUpdated((workspace) => listener(workspace.id)),
        onAttentionRaised: (listener) =>
          workspaceService.onAttentionRaised((event) => listener(event.attention)),
      },
      workspaceId,
      terminalId,
      ended
    ),
  readTerminalText: (terminalId, history) => ptyService.readText(terminalId, history),
  submitToTerminal: (terminalId, text, bracketed) => ptyService.submit(terminalId, text, bracketed),
  approveTerminalSend,
  // A PTY still starting runs, as far as a wait is concerned.
  isTerminalRunning: (terminalId) => {
    const status = ptyService.getStatus(terminalId);
    return status !== null && status !== 'stopped';
  },
  onWorkspaceUpdated: (listener) =>
    workspaceService.onWorkspaceUpdated((workspace) => listener(workspace.id)),
  onPromptSubmitted: (listener) => workspaceService.onPromptSubmitted(listener),
  onAttentionRaised: (listener) =>
    workspaceService.onAttentionRaised((event) => listener(event.attention)),
  onTerminalOutput: (listener) =>
    ptyService.onData((terminalId, data) => listener(terminalId, data)),
  onTerminalExit: (listener) => ptyService.onExit((terminalId) => listener(terminalId)),
  onTerminalReset: (listener) => ptyService.onReset((terminalId) => listener(terminalId)),
  requestOpenFolder,
  requestTrash: (request) =>
    windowService.sendToWindowOrNext(
      workspaceService.get(request.workspaceId)?.windowId,
      IPC.WORKSPACE_TRASH_REQUESTED,
      request
    ),
  openInVncApp,
};

export const komlaOperationService = new KomlaOperationService(productionDependencies);
