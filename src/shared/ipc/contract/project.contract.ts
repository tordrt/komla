import { IPC } from '../../constants/ipc-channels';
import {
  projectCreateArgsSchema,
  projectGetArgsSchema,
  projectUpdateArgsSchema,
  projectSetSshWorkspaceModeIfUnsetArgsSchema,
  projectDeleteArgsSchema,
  projectValidateRepoArgsSchema,
  projectFindForFolderArgsSchema,
  projectFolderOpenedArgsSchema,
  projectCreateFromRemoteArgsSchema,
  projectListOnSshHostArgsSchema,
  projectImportFromSshHostArgsSchema,
  projectCreateFromNewArgsSchema,
  projectFindIconsArgsSchema,
  projectTakeIconPromptArgsSchema,
  projectChooseIconFileArgsSchema,
  projectListLeftoverBranchesArgsSchema,
  projectDeleteLeftoverBranchesArgsSchema,
  projectCheckWorkspacesForCleanupArgsSchema,
  projectListHostBranchesArgsSchema,
  presetGetArgsSchema,
  presetSetActiveArgsSchema,
  presetCreateArgsSchema,
  presetCreateActiveArgsSchema,
  presetUpdateArgsSchema,
  presetDeleteArgsSchema,
  presetReorderArgsSchema,
  presetBuildPromptArgsSchema,
  presetAddActiveArgsSchema,
  presetRemoveActiveArgsSchema,
} from '../schemas/config-ipc.schemas';

import { invoke } from './define';

import type { ActivePresetEntry, AgentPreset } from '../../types/agent-preset';
import type {
  BranchDeletionResult,
  FolderProjectMatch,
  LeftoverBranches,
  Project,
  ProjectIconCandidate,
  WorkspaceCleanupStatus,
} from '../../types/project';
import type { SshHostProject, SshHostProjectImportResult } from '../../types/ssh-project-manifest';

export const projectContract = {
  [IPC.PROJECT_CREATE]: invoke(projectCreateArgsSchema).returns<Project>(),
  [IPC.PROJECT_LIST]: invoke().returns<Project[]>(),
  [IPC.PROJECT_GET]: invoke(projectGetArgsSchema).returns<Project | undefined>(),
  [IPC.PROJECT_UPDATE]: invoke(projectUpdateArgsSchema).returns<Project>(),
  [IPC.PROJECT_SET_SSH_WORKSPACE_MODE_IF_UNSET]: invoke(
    projectSetSshWorkspaceModeIfUnsetArgsSchema
  ).returns<Project>(),
  [IPC.PROJECT_DELETE]: invoke(projectDeleteArgsSchema).returns<{
    deletedWorkspaceIds: string[];
  }>(),
  [IPC.PROJECT_VALIDATE_REPO]: invoke(projectValidateRepoArgsSchema).returns<boolean>(),
  [IPC.PROJECT_FIND_FOR_FOLDER]: invoke(
    projectFindForFolderArgsSchema
  ).returns<FolderProjectMatch>(),
  [IPC.PROJECT_FOLDER_OPENED]: invoke(projectFolderOpenedArgsSchema).returns<void>(),
  [IPC.PROJECT_RECENT_FOLDERS]: invoke().returns<string[]>(),
  [IPC.PROJECT_HAS_PROJECTS]: invoke().returns<boolean>(),
  [IPC.PROJECT_GET_SETTINGS_PATH]: invoke().returns<string>(),
  [IPC.PROJECT_CREATE_FROM_REMOTE]: invoke(projectCreateFromRemoteArgsSchema).returns<Project>(),
  [IPC.PROJECT_LIST_ON_SSH_HOST]: invoke(projectListOnSshHostArgsSchema).returns<
    SshHostProject[]
  >(),
  [IPC.PROJECT_IMPORT_FROM_SSH_HOST]: invoke(projectImportFromSshHostArgsSchema).returns<
    SshHostProjectImportResult[]
  >(),
  [IPC.PROJECT_CREATE_FROM_NEW]: invoke(projectCreateFromNewArgsSchema).returns<Project>(),
  [IPC.PROJECT_FIND_ICONS]: invoke(projectFindIconsArgsSchema).returns<ProjectIconCandidate[]>(),
  [IPC.PROJECT_TAKE_ICON_PROMPT]: invoke(projectTakeIconPromptArgsSchema).returns<
    ProjectIconCandidate[]
  >(),
  [IPC.PROJECT_CHOOSE_ICON_FILE]: invoke(
    projectChooseIconFileArgsSchema
  ).returns<ProjectIconCandidate | null>(),
  [IPC.PROJECT_LIST_LEFTOVER_BRANCHES]: invoke(
    projectListLeftoverBranchesArgsSchema
  ).returns<LeftoverBranches>(),
  [IPC.PROJECT_DELETE_LEFTOVER_BRANCHES]: invoke(
    projectDeleteLeftoverBranchesArgsSchema
  ).returns<BranchDeletionResult>(),
  [IPC.PROJECT_CHECK_WORKSPACES_FOR_CLEANUP]: invoke(
    projectCheckWorkspacesForCleanupArgsSchema
  ).returns<WorkspaceCleanupStatus[]>(),
  [IPC.PROJECT_LIST_HOST_BRANCHES]: invoke(projectListHostBranchesArgsSchema).returns<string[]>(),
  [IPC.PRESET_LIST_TEMPLATES]: invoke().returns<Omit<AgentPreset, 'id'>[]>(),
  [IPC.PRESET_LIST]: invoke().returns<AgentPreset[]>(),
  [IPC.PRESET_GET]: invoke(presetGetArgsSchema).returns<AgentPreset | undefined>(),
  [IPC.PRESET_GET_ACTIVE]: invoke().returns<AgentPreset | undefined>(),
  [IPC.PRESET_SET_ACTIVE]: invoke(presetSetActiveArgsSchema).returns<void>(),
  [IPC.PRESET_CREATE]: invoke(presetCreateArgsSchema).returns<AgentPreset>(),
  [IPC.PRESET_CREATE_ACTIVE]: invoke(presetCreateActiveArgsSchema).returns<AgentPreset[]>(),
  [IPC.PRESET_DETECT_INSTALLED]: invoke().returns<string[]>(),
  [IPC.PRESET_UPDATE]: invoke(presetUpdateArgsSchema).returns<AgentPreset>(),
  [IPC.PRESET_DELETE]: invoke(presetDeleteArgsSchema).returns<void>(),
  [IPC.PRESET_REORDER]: invoke(presetReorderArgsSchema).returns<void>(),
  [IPC.PRESET_GET_SETTINGS_PATH]: invoke().returns<string>(),
  [IPC.PRESET_BUILD_PROMPT_COMMAND]: invoke(presetBuildPromptArgsSchema).returns<string | null>(),
  [IPC.PRESET_GET_ACTIVE_PRESETS]: invoke().returns<ActivePresetEntry[]>(),
  [IPC.PRESET_ADD_ACTIVE]: invoke(presetAddActiveArgsSchema).returns<void>(),
  [IPC.PRESET_REMOVE_ACTIVE]: invoke(presetRemoveActiveArgsSchema).returns<void>(),
} as const;
