import { dirname } from 'path';

import { ipcMain, BrowserWindow } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { canPromptForProjectIcon, hasWorkspaceFiles, isSshWorkspace } from '../../../shared/types';
import { createLogger } from '../../lib/logger';
import { actionService } from '../../services/action.service';
import { detectInstalledAgents } from '../../services/agent-detection.service';
import { agentPresetService, AgentPreset } from '../../services/agent-preset.service';
import { devPreviewService } from '../../services/dev-preview.service';
import { gitService } from '../../services/git';
import {
  chooseProjectIconFile,
  scanProjectIcons,
  scanWorkspaceIcons,
} from '../../services/project-icon.service';
import { projectService, Project } from '../../services/project.service';
import { recordOpenedFolder, refreshRecentFolders } from '../../services/recent-folders.service';
import { workspaceService } from '../../services/workspace.service';
import {
  presetAddActiveArgsSchema,
  presetBuildPromptArgsSchema,
  presetCreateActiveArgsSchema,
  presetCreateArgsSchema,
  presetDeleteArgsSchema,
  presetGetArgsSchema,
  presetReorderArgsSchema,
  presetRemoveActiveArgsSchema,
  presetSetActiveArgsSchema,
  presetUpdateArgsSchema,
  projectCreateArgsSchema,
  projectCreateFromNewArgsSchema,
  projectCreateFromRemoteArgsSchema,
  projectDeleteArgsSchema,
  projectDeleteLeftoverBranchesArgsSchema,
  projectFindForFolderArgsSchema,
  projectFindIconsArgsSchema,
  projectFolderOpenedArgsSchema,
  projectGetArgsSchema,
  projectListHostBranchesArgsSchema,
  projectListLeftoverBranchesArgsSchema,
  projectSetSshWorkspaceModeIfUnsetArgsSchema,
  projectTakeIconPromptArgsSchema,
  projectChooseIconFileArgsSchema,
  projectCheckWorkspacesForCleanupArgsSchema,
  projectUpdateArgsSchema,
  projectValidateRepoArgsSchema,
} from '../validation/config-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';

import type {
  BranchDeletionResult,
  FolderProjectMatch,
  LeftoverBranches,
  ProjectIconCandidate,
  ProjectIconSource,
  WorkspaceCleanupStatus,
} from '../../../shared/types';
import type { ActivePresetEntry } from '../../../shared/types/agent-preset';

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
  ipcMain.handle(
    IPC.PROJECT_CREATE,
    handleValidated(
      IPC.PROJECT_CREATE,
      projectCreateArgsSchema,
      async (_, [params]): Promise<Project> => {
        const project = await projectService.create(params);
        assignSshWorkspaceProjects();
        return project;
      }
    )
  );

  ipcMain.handle(IPC.PROJECT_LIST, async (): Promise<Project[]> => {
    return projectService.list();
  });

  ipcMain.handle(
    IPC.PROJECT_GET,
    handleValidated(
      IPC.PROJECT_GET,
      projectGetArgsSchema,
      async (_, [id]): Promise<Project | undefined> => {
        return projectService.get(id);
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_UPDATE,
    handleValidated(
      IPC.PROJECT_UPDATE,
      projectUpdateArgsSchema,
      async (_, [id, updates]): Promise<Project> => {
        const project = await projectService.update(id, updates);
        // When baseBranch changes, propagate to all workspaces in the project
        if ('baseBranch' in updates) {
          workspaceService.propagateProjectBaseBranch(id);
        }
        return project;
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_SET_SSH_WORKSPACE_MODE_IF_UNSET,
    handleValidated(
      IPC.PROJECT_SET_SSH_WORKSPACE_MODE_IF_UNSET,
      projectSetSshWorkspaceModeIfUnsetArgsSchema,
      async (_, [id, mode]): Promise<Project> => {
        return projectService.setSshWorkspaceModeIfUnset(id, mode);
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_DELETE,
    handleValidated(
      IPC.PROJECT_DELETE,
      projectDeleteArgsSchema,
      async (_, [id]): Promise<{ deletedWorkspaceIds: string[] }> => {
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
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_VALIDATE_REPO,
    handleValidated(
      IPC.PROJECT_VALIDATE_REPO,
      projectValidateRepoArgsSchema,
      async (_, [path]): Promise<boolean> => {
        return projectService.validateRepository(path);
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_FIND_FOR_FOLDER,
    handleValidated(
      IPC.PROJECT_FIND_FOR_FOLDER,
      projectFindForFolderArgsSchema,
      async (_, [path]): Promise<FolderProjectMatch> => {
        return projectService.findForFolder(path);
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_FOLDER_OPENED,
    handleValidated(IPC.PROJECT_FOLDER_OPENED, projectFolderOpenedArgsSchema, async (_, [path]) => {
      recordOpenedFolder(path);
    })
  );

  ipcMain.handle(IPC.PROJECT_RECENT_FOLDERS, async (): Promise<string[]> => {
    return refreshRecentFolders();
  });

  ipcMain.handle(IPC.PROJECT_HAS_PROJECTS, async (): Promise<boolean> => {
    return projectService.hasProjects();
  });

  ipcMain.handle(IPC.PROJECT_GET_SETTINGS_PATH, async (): Promise<string> => {
    return projectService.getSettingsPath();
  });

  ipcMain.handle(
    IPC.PROJECT_CREATE_FROM_REMOTE,
    handleValidated(
      IPC.PROJECT_CREATE_FROM_REMOTE,
      projectCreateFromRemoteArgsSchema,
      async (event, [params]): Promise<Project> => {
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
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_CREATE_FROM_NEW,
    handleValidated(
      IPC.PROJECT_CREATE_FROM_NEW,
      projectCreateFromNewArgsSchema,
      async (_, [params]): Promise<Project> => {
        return projectService.createFromNew(params);
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_FIND_ICONS,
    handleValidated(
      IPC.PROJECT_FIND_ICONS,
      projectFindIconsArgsSchema,
      async (_, [source]): Promise<ProjectIconCandidate[]> => findIcons(source)
    )
  );

  // A new workspace of a project without an icon scans its files for icons to offer.
  ipcMain.handle(
    IPC.PROJECT_TAKE_ICON_PROMPT,
    handleValidated(
      IPC.PROJECT_TAKE_ICON_PROMPT,
      projectTakeIconPromptArgsSchema,
      async (_, [workspaceId]): Promise<ProjectIconCandidate[]> => {
        const workspace = workspaceService.get(workspaceId);
        const project = workspace?.projectId ? projectService.get(workspace.projectId) : undefined;
        if (!workspace || !project || !canPromptForProjectIcon(project, workspace)) return [];
        if (!projectService.takeIconPrompt(project.id, workspace.id)) return [];
        const candidates = await scanWorkspaceIcons(workspace);
        if (candidates.length > 0) projectService.markIconPromptAsked(project.id);
        return candidates;
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_CHOOSE_ICON_FILE,
    handleValidated(
      IPC.PROJECT_CHOOSE_ICON_FILE,
      projectChooseIconFileArgsSchema,
      async (event): Promise<ProjectIconCandidate | null> =>
        chooseProjectIconFile(BrowserWindow.fromWebContents(event.sender))
    )
  );

  ipcMain.handle(
    IPC.PROJECT_LIST_LEFTOVER_BRANCHES,
    handleValidated(
      IPC.PROJECT_LIST_LEFTOVER_BRANCHES,
      projectListLeftoverBranchesArgsSchema,
      async (_, [projectId, hostId]): Promise<LeftoverBranches> => {
        const { repo, targetBranch, keep, skipBranchesOnOrigin } =
          await workspaceService.getBranchCleanupScope(projectId, hostId);
        return gitService.listLeftoverBranches(repo, targetBranch, keep, { skipBranchesOnOrigin });
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_DELETE_LEFTOVER_BRANCHES,
    handleValidated(
      IPC.PROJECT_DELETE_LEFTOVER_BRANCHES,
      projectDeleteLeftoverBranchesArgsSchema,
      async (_, [projectId, branches, hostId]): Promise<BranchDeletionResult> => {
        const { repo, keep } = await workspaceService.getBranchCleanupScope(projectId, hostId);
        return gitService.deleteLeftoverBranches(repo, branches, keep);
      }
    )
  );

  ipcMain.handle(
    IPC.PROJECT_CHECK_WORKSPACES_FOR_CLEANUP,
    handleValidated(
      IPC.PROJECT_CHECK_WORKSPACES_FOR_CLEANUP,
      projectCheckWorkspacesForCleanupArgsSchema,
      async (_, [projectId]): Promise<WorkspaceCleanupStatus[]> =>
        workspaceService.checkWorkspacesForCleanup(projectId)
    )
  );

  ipcMain.handle(
    IPC.PROJECT_LIST_HOST_BRANCHES,
    handleValidated(
      IPC.PROJECT_LIST_HOST_BRANCHES,
      projectListHostBranchesArgsSchema,
      async (_, [projectId, hostId]): Promise<string[]> =>
        workspaceService.listHostBranches(projectId, hostId)
    )
  );

  // Agent preset handlers
  ipcMain.handle(IPC.PRESET_LIST_TEMPLATES, async (): Promise<Omit<AgentPreset, 'id'>[]> => {
    return agentPresetService.listTemplates();
  });

  ipcMain.handle(IPC.PRESET_LIST, async (): Promise<AgentPreset[]> => {
    return agentPresetService.list();
  });

  ipcMain.handle(
    IPC.PRESET_GET,
    handleValidated(
      IPC.PRESET_GET,
      presetGetArgsSchema,
      async (_, [id]): Promise<AgentPreset | undefined> => {
        return agentPresetService.get(id);
      }
    )
  );

  ipcMain.handle(IPC.PRESET_GET_ACTIVE, async (): Promise<AgentPreset | undefined> => {
    return agentPresetService.getActive();
  });

  ipcMain.handle(
    IPC.PRESET_SET_ACTIVE,
    handleValidated(
      IPC.PRESET_SET_ACTIVE,
      presetSetActiveArgsSchema,
      async (_, [id, launchModeId]): Promise<void> => {
        return agentPresetService.setActive(id, launchModeId);
      }
    )
  );

  ipcMain.handle(
    IPC.PRESET_CREATE,
    handleValidated(
      IPC.PRESET_CREATE,
      presetCreateArgsSchema,
      async (_, [preset]): Promise<AgentPreset> => {
        return agentPresetService.create(preset);
      }
    )
  );

  ipcMain.handle(
    IPC.PRESET_CREATE_ACTIVE,
    handleValidated(
      IPC.PRESET_CREATE_ACTIVE,
      presetCreateActiveArgsSchema,
      async (_, [presets]): Promise<AgentPreset[]> => {
        return agentPresetService.createActive(presets);
      }
    )
  );

  ipcMain.handle(IPC.PRESET_DETECT_INSTALLED, async (): Promise<string[]> => {
    return detectInstalledAgents(agentPresetService.listTemplates());
  });

  ipcMain.handle(
    IPC.PRESET_UPDATE,
    handleValidated(
      IPC.PRESET_UPDATE,
      presetUpdateArgsSchema,
      async (_, [id, updates]): Promise<AgentPreset> => {
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
      }
    )
  );

  ipcMain.handle(
    IPC.PRESET_DELETE,
    handleValidated(IPC.PRESET_DELETE, presetDeleteArgsSchema, async (_, [id]): Promise<void> => {
      agentPresetService.delete(id);
      actionService.clearPresetReferences(id);
      projectService.clearPresetReferences(id);
    })
  );

  ipcMain.handle(
    IPC.PRESET_REORDER,
    handleValidated(
      IPC.PRESET_REORDER,
      presetReorderArgsSchema,
      async (_, [id, newOrder]): Promise<void> => {
        agentPresetService.reorder(id, newOrder);
      }
    )
  );

  ipcMain.handle(IPC.PRESET_GET_SETTINGS_PATH, async (): Promise<string> => {
    return agentPresetService.getSettingsPath();
  });

  ipcMain.handle(
    IPC.PRESET_BUILD_PROMPT_COMMAND,
    handleValidated(
      IPC.PRESET_BUILD_PROMPT_COMMAND,
      presetBuildPromptArgsSchema,
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
    )
  );

  ipcMain.handle(IPC.PRESET_GET_ACTIVE_PRESETS, async (): Promise<ActivePresetEntry[]> => {
    return agentPresetService.getActivePresets();
  });

  ipcMain.handle(
    IPC.PRESET_ADD_ACTIVE,
    handleValidated(
      IPC.PRESET_ADD_ACTIVE,
      presetAddActiveArgsSchema,
      async (_, [id]): Promise<void> => {
        return agentPresetService.addActivePreset(id);
      }
    )
  );

  ipcMain.handle(
    IPC.PRESET_REMOVE_ACTIVE,
    handleValidated(
      IPC.PRESET_REMOVE_ACTIVE,
      presetRemoveActiveArgsSchema,
      async (_, [id]): Promise<void> => {
        return agentPresetService.removeActivePreset(id);
      }
    )
  );
}
