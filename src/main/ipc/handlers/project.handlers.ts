import { dirname } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { canPromptForProjectIcon, hasWorkspaceFiles, isSshWorkspace } from '../../../shared/types';
import { createLogger } from '../../lib/logger';
import { actionService } from '../../services/action.service';
import { detectInstalledAgents } from '../../services/agent-detection.service';
import { agentPresetService, AgentPreset } from '../../services/agent-preset.service';
import { listAgentSkills } from '../../services/agent-skills.service';
import { devPreviewService } from '../../services/dev-preview.service';
import { gitService } from '../../services/git';
import { gitBackgroundFetchService } from '../../services/git-background-fetch.service';
import {
  chooseProjectIconFile,
  scanProjectIcons,
  scanWorkspaceIcons,
} from '../../services/project-icon.service';
import { projectService, Project } from '../../services/project.service';
import { recordOpenedFolder, refreshRecentFolders } from '../../services/recent-folders.service';
import { sshProjectSync } from '../../services/ssh-project-sync.service';
import { workspaceService } from '../../services/workspace.service';
import { handleIpc } from '../validation/ipc-validators';

import type {
  BranchDeletionResult,
  FolderProjectMatch,
  LeftoverBranches,
  ProjectIconCandidate,
  ProjectIconSource,
  WorkspaceCleanupStatus,
} from '../../../shared/types';
import type { ActivePresetEntry } from '../../../shared/types/agent-preset';
import type {
  SshHostProject,
  SshHostProjectImportResult,
} from '../../../shared/types/ssh-project-manifest';

const logger = createLogger('ProjectHandlers');

/** A new project may be the one SSH workspaces from other devices are waiting for. */
function assignSshWorkspaceProjects(): void {
  void workspaceService.assignSshWorkspaceProjects().catch((error) => {
    logger.warn('Could not match SSH workspaces to projects', error);
  });
}

/**
 * A project's icons, from its folder, or from its newest workspace when the folder has none:
 * a local one, or one on an SSH host when it has no local one. A cloned or new project's
 * folder holds only its bare repository, so it is skipped.
 */
async function findIcons(source: ProjectIconSource): Promise<ProjectIconCandidate[]> {
  if ('folder' in source) return scanProjectIcons(source.folder);
  const project = projectService.get(source.projectId);
  if (!project) return [];
  const holdsOnlyBareRepo =
    !!project.managedRepoPath && dirname(project.managedRepoPath) === project.repositoryPath;
  if (!holdsOnlyBareRepo) {
    const icons = await scanProjectIcons(project.repositoryPath);
    if (icons.length > 0) return icons;
  }
  const workspace = workspaceService
    .getWorkspacesByProjectId(project.id)
    .filter(hasWorkspaceFiles)
    .sort(
      (a, b) => Number(isSshWorkspace(a)) - Number(isSshWorkspace(b)) || b.createdAt - a.createdAt
    )[0];
  return workspace ? scanWorkspaceIcons(workspace) : [];
}

export function registerProjectHandlers(): void {
  // Project handlers
  handleIpc(IPC.PROJECT_CREATE, async (_, [params]): Promise<Project> => {
    const project = await projectService.create(params);
    assignSshWorkspaceProjects();
    return project;
  });

  handleIpc(IPC.PROJECT_LIST, async (): Promise<Project[]> => {
    return projectService.list();
  });

  handleIpc(IPC.PROJECT_GET, async (_, [id]): Promise<Project | undefined> => {
    return projectService.get(id);
  });

  handleIpc(IPC.PROJECT_UPDATE, async (_, [id, updates]): Promise<Project> => {
    const project = await projectService.update(id, updates);
    // When baseBranch changes, propagate to all workspaces in the project
    if ('baseBranch' in updates) {
      workspaceService.propagateProjectBaseBranch(id);
    }
    return project;
  });

  handleIpc(
    IPC.PROJECT_SET_SSH_WORKSPACE_MODE_IF_UNSET,
    async (_, [id, mode]): Promise<Project> => {
      return projectService.setSshWorkspaceModeIfUnset(id, mode);
    }
  );

  handleIpc(IPC.PROJECT_DELETE, async (_, [id]): Promise<{ deletedWorkspaceIds: string[] }> => {
    // Cascade-delete all workspaces belonging to this project
    const workspaces = workspaceService.getWorkspacesByProjectId(id);
    const deletedWorkspaceIds: string[] = [];

    for (const workspace of workspaces) {
      try {
        await workspaceService.delete(workspace.id, true);
        deletedWorkspaceIds.push(workspace.id);
      } catch (err) {
        logger.error('Failed to delete workspace during project deletion', err, {
          workspaceId: workspace.id,
        });
      }
    }

    await projectService.delete(id);
    await devPreviewService.clearProjectData(id).catch((err) => {
      logger.warn('Failed to clear the project browser data', { projectId: id, error: err });
    });

    return { deletedWorkspaceIds };
  });

  handleIpc(IPC.PROJECT_VALIDATE_REPO, async (_, [path]): Promise<boolean> => {
    return projectService.validateRepository(path);
  });

  handleIpc(IPC.PROJECT_FIND_FOR_FOLDER, async (_, [path]): Promise<FolderProjectMatch> => {
    return projectService.findForFolder(path);
  });

  handleIpc(IPC.PROJECT_FOLDER_OPENED, async (_, [path]) => {
    recordOpenedFolder(path);
  });

  handleIpc(IPC.PROJECT_RECENT_FOLDERS, async (): Promise<string[]> => {
    return refreshRecentFolders();
  });

  handleIpc(IPC.PROJECT_HAS_PROJECTS, async (): Promise<boolean> => {
    return projectService.hasProjects();
  });

  handleIpc(IPC.PROJECT_GET_SETTINGS_PATH, async (): Promise<string> => {
    return projectService.getSettingsPath();
  });

  handleIpc(IPC.PROJECT_CREATE_FROM_REMOTE, async (event, [params]): Promise<Project> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const project = await projectService.createFromRemote(params, (percent, stage) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC.GIT_PROGRESS, {
          operation: 'clone',
          repoPath: params.remoteUrl,
          percent,
          stage,
        });
      }
    });
    assignSshWorkspaceProjects();
    return project;
  });

  handleIpc(IPC.PROJECT_LIST_ON_SSH_HOST, async (_, [hostId]): Promise<SshHostProject[]> =>
    sshProjectSync.listOnHost(hostId)
  );

  handleIpc(
    IPC.PROJECT_IMPORT_FROM_SSH_HOST,
    async (_, [hostId, imports]): Promise<SshHostProjectImportResult[]> =>
      sshProjectSync.importFromHost(hostId, imports)
  );

  handleIpc(IPC.PROJECT_CREATE_FROM_NEW, async (_, [params]): Promise<Project> => {
    return projectService.createFromNew(params);
  });

  handleIpc(IPC.PROJECT_FIND_ICONS, async (_, [source]): Promise<ProjectIconCandidate[]> =>
    findIcons(source)
  );

  // A new workspace of a project without an icon scans its files for icons to offer.
  handleIpc(
    IPC.PROJECT_TAKE_ICON_PROMPT,
    async (_, [workspaceId]): Promise<ProjectIconCandidate[]> => {
      const workspace = workspaceService.get(workspaceId);
      const project = workspace?.projectId ? projectService.get(workspace.projectId) : undefined;
      if (!workspace || !project || !canPromptForProjectIcon(project, workspace)) return [];
      if (!projectService.takeIconPrompt(project.id, workspace.id)) return [];
      const candidates = await scanWorkspaceIcons(workspace);
      if (candidates.length > 0) projectService.markIconPromptAsked(project.id);
      return candidates;
    }
  );

  // The New Workspace dialog asks as it opens, so the workspace starts from a recent copy of
  // the project's target branch without fetching while it's created, and its branch picker asks
  // for every branch, so the list it shows is current.
  handleIpc(IPC.PROJECT_FETCH_IN_BACKGROUND, (_, [projectId, hostId, everyBranch]) =>
    gitBackgroundFetchService.fetchProject(projectId, hostId, everyBranch)
  );

  handleIpc(IPC.PROJECT_CHOOSE_ICON_FILE, async (event): Promise<ProjectIconCandidate | null> =>
    chooseProjectIconFile(BrowserWindow.fromWebContents(event.sender))
  );

  handleIpc(
    IPC.PROJECT_LIST_LEFTOVER_BRANCHES,
    async (_, [projectId, hostId]): Promise<LeftoverBranches> => {
      const { repo, targetBranch, keep, skipBranchesOnOrigin } =
        await workspaceService.getBranchCleanupScope(projectId, hostId);
      return gitService.listLeftoverBranches(repo, targetBranch, keep, { skipBranchesOnOrigin });
    }
  );

  handleIpc(
    IPC.PROJECT_DELETE_LEFTOVER_BRANCHES,
    async (_, [projectId, branches, hostId]): Promise<BranchDeletionResult> => {
      const { repo, keep } = await workspaceService.getBranchCleanupScope(projectId, hostId);
      return gitService.deleteLeftoverBranches(repo, branches, keep);
    }
  );

  handleIpc(
    IPC.PROJECT_CHECK_WORKSPACES_FOR_CLEANUP,
    async (_, [projectId]): Promise<WorkspaceCleanupStatus[]> =>
      workspaceService.checkWorkspacesForCleanup(projectId)
  );

  handleIpc(IPC.PROJECT_LIST_HOST_BRANCHES, async (_, [projectId, hostId]): Promise<string[]> =>
    workspaceService.listHostBranches(projectId, hostId)
  );

  handleIpc(IPC.PROJECT_LIST_AGENT_SKILLS, async (_, [family, projectId, hostId]) =>
    listAgentSkills(family, projectId, hostId)
  );

  // Agent preset handlers
  handleIpc(IPC.PRESET_LIST_TEMPLATES, async (): Promise<Omit<AgentPreset, 'id'>[]> => {
    return agentPresetService.listTemplates();
  });

  handleIpc(IPC.PRESET_LIST, async (): Promise<AgentPreset[]> => {
    return agentPresetService.list();
  });

  handleIpc(IPC.PRESET_GET, async (_, [id]): Promise<AgentPreset | undefined> => {
    return agentPresetService.get(id);
  });

  handleIpc(IPC.PRESET_GET_ACTIVE, async (): Promise<AgentPreset | undefined> => {
    return agentPresetService.getActive();
  });

  handleIpc(IPC.PRESET_SET_ACTIVE, async (_, [id, launchModeId]): Promise<void> => {
    return agentPresetService.setActive(id, launchModeId);
  });

  handleIpc(IPC.PRESET_CREATE, async (_, [preset]): Promise<AgentPreset> => {
    return agentPresetService.create(preset);
  });

  handleIpc(IPC.PRESET_CREATE_ACTIVE, async (_, [presets]): Promise<AgentPreset[]> => {
    return agentPresetService.createActive(presets);
  });

  handleIpc(IPC.PRESET_DETECT_INSTALLED, async (): Promise<string[]> => {
    return detectInstalledAgents(agentPresetService.listTemplates());
  });

  handleIpc(IPC.PRESET_UPDATE, async (_, [id, updates]): Promise<AgentPreset> => {
    // Detect removed launch modes before updating
    const oldPreset = agentPresetService.get(id);
    const result = agentPresetService.update(id, updates);

    if (oldPreset && updates.launchModes) {
      const newModeIds = new Set(updates.launchModes.map((m) => m.id));
      const removedModeIds = oldPreset.launchModes
        .filter((m) => !newModeIds.has(m.id))
        .map((m) => m.id);
      if (removedModeIds.length > 0) {
        actionService.clearLaunchModeReferences(id, removedModeIds);
        projectService.clearLaunchModeReferences(id, removedModeIds);
      }
    }

    return result;
  });

  handleIpc(IPC.PRESET_DELETE, async (_, [id]): Promise<void> => {
    agentPresetService.delete(id);
    actionService.clearPresetReferences(id);
    projectService.clearPresetReferences(id);
  });

  handleIpc(IPC.PRESET_REORDER, async (_, [id, newOrder]): Promise<void> => {
    agentPresetService.reorder(id, newOrder);
  });

  handleIpc(IPC.PRESET_GET_SETTINGS_PATH, async (): Promise<string> => {
    return agentPresetService.getSettingsPath();
  });

  handleIpc(
    IPC.PRESET_BUILD_PROMPT_COMMAND,
    async (_, [prompt, presetId, launchModeId]): Promise<string | null> => {
      // When a preset is explicitly pinned, resolve it strictly — do not
      // fall back to the active preset, as that would break the lock guarantee.
      const preset = presetId
        ? agentPresetService.get(presetId)
        : agentPresetService.getPresetForWorkspace(undefined);
      if (!preset) return null;

      const command = agentPresetService.resolvePresetCommand(
        preset,
        'prompt',
        launchModeId,
        prompt
      );
      return command || null;
    }
  );

  handleIpc(IPC.PRESET_GET_ACTIVE_PRESETS, async (): Promise<ActivePresetEntry[]> => {
    return agentPresetService.getActivePresets();
  });

  handleIpc(IPC.PRESET_ADD_ACTIVE, async (_, [id]): Promise<void> => {
    return agentPresetService.addActivePreset(id);
  });

  handleIpc(IPC.PRESET_REMOVE_ACTIVE, async (_, [id]): Promise<void> => {
    return agentPresetService.removeActivePreset(id);
  });
}
