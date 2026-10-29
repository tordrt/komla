import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { IPC } from '../shared/constants/ipc-channels';

import type {
  Workspace,
  WorkspaceCreateResult,
  WorkspaceCreateBatchResult,
  WorkspaceRestartResult,
  WorkspaceObservationProjection,
  RemoteWorkingTreeChange,
  RestartTerminalOptions,
  AddAgentTabOptions,
  Terminal,
  TerminalExecutionLocation,
  TerminalStatus,
  TerminalLaunchLocation,
  TerminalHostInfo,
  AppConfig,
  Category,
  CreateWorkspaceParams,
  WorktreeDiff,
  FileChange,
  FileDiffContent,
  Project,
  FolderProjectMatch,
  ProjectIconCandidate,
  ProjectIconSource,
  CreateProjectParams,
  CreateProjectFromRemoteParams,
  CreateProjectFromNewParams,
  DirectoryInfo,
  GitBranchQuickStatus,
  ThemeConfig,
  TerminalConfig,
  AgentPreset,
  ActivePresetEntry,
  ShortcutsConfig,
  Action,
  ActionSshExecutionLocation,
  LicenseStatus,
  LicenseActivation,
  ActivationLimitError,
  BranchInfo,
  McpStatus,
  FeedbackPayload,
  FeedbackResult,
  WorkspaceQuota,
  PlanPrices,
  UtilityOpenRouterKeyStatus,
  CommitChangesResult,
  CommitDraftResult,
  CommitScope,
  CommitScopeResult,
  CustomEndpointTestResult,
  ContentSearchResult,
  ContentSearchOptions,
  CommitDiff,
  BlameHunk,
  WorkspaceAttentionEvent,
  RemoteControlDirectPairingOffer,
  RemoteControlDirectServerInfo,
  RemoteControlDirectStartOptions,
  RemoteControlDirectState,
  RemoteControlDirectTailscaleStatus,
  RemoteControlDirectTailscaleServeResult,
  RemoteControlHostAccessStatus,
  PairedDeviceRecord,
  SshConfigHost,
  SshHost,
  SshHostSetupResult,
  SshHostStatus,
  SshWorkspaceMode,
  SshIntegrationStatus,
  SshIntegrationUpdates,
  SshForwardedPort,
  SshLinkForward,
  SshPreviewForward,
  SshPortForwardStatus,
  SettingsApprovalPrompt,
  SettingsApprovalDecision,
} from '../renderer/types';
import type { ManagedTmuxFindResult } from '../shared/lib/ssh-tmux-attach';
import type {
  AskpassRequest,
  BranchDeletionResult,
  DevPreviewBounds,
  DevPreviewNavigationDirection,
  DevPreviewNavigationState,
  DevPreviewOpenTabRequest,
  DevPreviewServiceDetection,
  DevPreviewSnapshot,
  DevPreviewTabRef,
  LeftoverBranches,
  WorkspaceCleanupStatus,
  LinkPreview,
  LinkPreviewRequest,
  AgentsMenuBarDrawRequest,
  AgentsMenuBarImage,
  AgentsMenuBarState,
  AgentsMenuBarTheme,
  ToastOverlayContent,
  ToastOverlayEvent,
  ToastOverlayState,
  LocalMirrorSyncStatus,
} from '../shared/types';
import type { AgentUsage, AgentUsageSource } from '../shared/types/agent-usage';
import type {
  Automation,
  AutomationHostReads,
  AutomationRun,
  AutomationTarget,
  AutomationTargetSnapshot,
  SaveAutomationParams,
} from '../shared/types/automation';
import type { CommitGraph, CommitGraphQuery } from '../shared/types/commit-graph';
import type { GitIdentityStatus } from '../shared/types/git-identity';
import type { KomlaSkillStatus } from '../shared/types/komla-skill';
import type { NoteSummary } from '../shared/types/notes';
import type { NotificationIntegrationUpdate } from '../shared/types/notification-integration';
import type { PullRequestStatus } from '../shared/types/pull-request';
import type { MachineResourceUsage } from '../shared/types/resource-usage';
import type { SettingsHistoryEntry } from '../shared/types/settings-history';
import type { SshHostAddedSource } from '../shared/types/ssh';
import type {
  RemoteSshWorkspace,
  SshWorkspaceRemovedOnOtherDevice,
  SshWorkspaceLayoutChangedOnOtherDevice,
} from '../shared/types/ssh-workspace-manifest';
import type {
  StatusCommandList,
  StatusButtonRunResult,
  StatusCommandResult,
  StatusPopoverResult,
  StatusPopoverTheme,
  WindowStatusItem,
} from '../shared/types/status-items';
import type { ViewerFile, ViewerFileSource, ViewerFolderFile } from '../shared/types/viewer-file';
import type {
  OpenDevPreviewEvent,
  WorkspaceTrashRequest,
  WorkspaceVirtualDesktop,
} from '../shared/types/workspace';

export type IpcCallback = (event: Electron.IpcRendererEvent, ...args: unknown[]) => void;

declare const __KOMLA_ENV__: string;
const komlaEnv = typeof __KOMLA_ENV__ !== 'undefined' ? __KOMLA_ENV__ : 'staging';
declare const __KOMLA_DISTRIBUTION__: string | undefined;
declare const __KOMLA_HAS_UTILITY_TOKEN__: boolean | undefined;

const api = {
  platform: process.platform,
  // On Windows, major.minor.build. Terminals use the build to work with ConPTY.
  systemVersion: process.getSystemVersion(),
  // For paths terminals print in the home folder, as ~/.
  homeDir: process.env.HOME ?? null,
  websiteUrl: komlaEnv === 'production' ? 'https://komla.dev' : 'https://test.komla.dev',
  // Built from source rather than by the release pipeline, so it doesn't update itself.
  buildFromSource:
    typeof __KOMLA_DISTRIBUTION__ === 'undefined' || __KOMLA_DISTRIBUTION__ !== 'official',
  // Without the utility token, as in most builds from source, the managed AI helpers can't run.
  managedAiHelpers:
    typeof __KOMLA_HAS_UTILITY_TOKEN__ !== 'undefined' && __KOMLA_HAS_UTILITY_TOKEN__,
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // Workspace operations
  createWorkspace: (params: CreateWorkspaceParams): Promise<WorkspaceCreateResult> =>
    ipcRenderer.invoke(IPC.WORKSPACE_CREATE, params),
  createWorkspaces: (params: CreateWorkspaceParams[]): Promise<WorkspaceCreateBatchResult> =>
    ipcRenderer.invoke(IPC.WORKSPACE_CREATE_BATCH, params),

  addTerminal: (
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    commandKind?: 'agent' | 'host' | 'host-shell',
    executionLocation?: TerminalLaunchLocation
  ): Promise<Terminal> =>
    ipcRenderer.invoke(
      IPC.WORKSPACE_ADD_TERMINAL,
      workspaceId,
      name,
      command,
      layoutHint,
      commandKind,
      executionLocation
    ),

  addAgentTab: (
    workspaceId: string,
    prompt?: string,
    launchModeId?: string,
    presetId?: string,
    options?: AddAgentTabOptions
  ): Promise<Terminal> =>
    ipcRenderer.invoke(
      IPC.WORKSPACE_ADD_AGENT_TAB,
      workspaceId,
      prompt,
      launchModeId,
      presetId,
      options
    ),

  removeTerminal: (workspaceId: string, terminalId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_REMOVE_TERMINAL, workspaceId, terminalId),

  stopWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_STOP, workspaceId),

  /** The workspaces this window shows a browser or note pane of, which keeps them running. */
  setPaneSurfaceWorkspaces: (workspaceIds: string[]): void =>
    ipcRenderer.send(IPC.WORKSPACE_SET_PANE_SURFACE_WORKSPACES, workspaceIds),

  stopTerminal: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_STOP_TERMINAL, terminalId),
  restartTerminal: (
    terminalId: string,
    presetId?: string,
    launchModeId?: string | null,
    cols?: number,
    rows?: number,
    options?: RestartTerminalOptions
  ): Promise<Terminal> =>
    ipcRenderer.invoke(
      IPC.WORKSPACE_RESTART_TERMINAL,
      terminalId,
      presetId,
      launchModeId,
      cols,
      rows,
      options
    ),
  reconnectSshTerminal: (terminalId: string, cols?: number, rows?: number): Promise<Terminal> =>
    ipcRenderer.invoke(IPC.WORKSPACE_RECONNECT_SSH_TERMINAL, terminalId, cols, rows),
  findInSshTerminal: (terminalId: string, query: string): Promise<ManagedTmuxFindResult> =>
    ipcRenderer.invoke(IPC.WORKSPACE_FIND_IN_SSH_TERMINAL, terminalId, query),
  recoverSshSessions: (workspaceId: string): Promise<Workspace | undefined> =>
    ipcRenderer.invoke(IPC.WORKSPACE_RECOVER_SSH_SESSIONS, workspaceId),
  listRemoteSshWorkspaces: (hostId: string): Promise<RemoteSshWorkspace[]> =>
    ipcRenderer.invoke(IPC.WORKSPACE_LIST_REMOTE_SSH, hostId),
  adoptRemoteSshWorkspace: (hostId: string, workspaceId: string): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.WORKSPACE_ADOPT_REMOTE_SSH, hostId, workspaceId),
  linkSshWorkspaceToProject: (workspaceId: string, projectId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_LINK_SSH_PROJECT, workspaceId, projectId),
  syncSshHostWorkspaces: (hostId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_SYNC_SSH_HOST, hostId),
  removeMissingSshWorkspace: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_REMOVE_MISSING_SSH, workspaceId),

  retrySetupStep: (workspaceId: string, stepId: string): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.WORKSPACE_RETRY_SETUP_STEP, workspaceId, stepId),

  runBackgroundAction: (
    workspaceId: string,
    actionId: string,
    launch?: { command?: string; executionLocation?: TerminalExecutionLocation }
  ): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.WORKSPACE_RUN_BACKGROUND_ACTION, workspaceId, actionId, launch),

  stopBackgroundActionRun: (workspaceId: string, activityId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_STOP_BACKGROUND_ACTION_RUN, workspaceId, activityId),

  retryLocalMirrorSync: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_RETRY_LOCAL_MIRROR_SYNC, workspaceId),

  dismissSetupActivity: (workspaceId: string, activityId: string): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.WORKSPACE_DISMISS_SETUP_ACTIVITY, workspaceId, activityId),

  deleteWorkspace: (workspaceId: string, force = false, deleteBranch = false): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_DELETE, workspaceId, force, deleteBranch),

  generateBranchName: (promptText: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GENERATE_BRANCH_NAME, promptText),

  regenerateWorkspaceName: (workspaceId: string): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.WORKSPACE_REGENERATE_NAME, workspaceId),

  cancelBranchNaming: (): void => {
    void ipcRenderer.invoke(IPC.WORKSPACE_CANCEL_BRANCH_NAMING);
  },

  getWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.WORKSPACE_LIST),

  getWorkspace: (workspaceId: string): Promise<Workspace | undefined> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET, workspaceId),

  updateWorkspace: (workspaceId: string, updates: Partial<Workspace>): Promise<Workspace> =>
    ipcRenderer.invoke(IPC.WORKSPACE_UPDATE, workspaceId, updates),

  notifyWorkspacesChanged: (): Promise<void> => ipcRenderer.invoke(IPC.WORKSPACE_NOTIFY_CHANGED),

  updateTerminal: (terminalId: string, updates: Partial<Terminal>): Promise<Terminal> =>
    ipcRenderer.invoke(IPC.WORKSPACE_UPDATE_TERMINAL, terminalId, updates),

  restartWorkspace: (workspaceId: string): Promise<WorkspaceRestartResult> =>
    ipcRenderer.invoke(IPC.WORKSPACE_RESTART, workspaceId),

  reorderWorkspace: (workspaceId: string, newOrder: number): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_REORDER, workspaceId, newOrder),

  linkWorkspaces: (originId: string, targetIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_LINK, originId, targetIds),

  unlinkWorkspace: (originId: string, targetId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_UNLINK, originId, targetId),

  setManualSpinner: (workspaceId: string, active: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_SET_MANUAL_SPINNER, workspaceId, active),

  startSshPreviewForward: (
    workspaceId: string,
    tabId: string,
    remotePort: number,
    scheme: 'http' | 'https' = 'http'
  ): Promise<SshPreviewForward> =>
    ipcRenderer.invoke(
      IPC.WORKSPACE_START_SSH_PREVIEW_FORWARD,
      workspaceId,
      tabId,
      remotePort,
      scheme
    ),

  stopSshPreviewForward: (workspaceId: string, tabId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_STOP_SSH_PREVIEW_FORWARD, workspaceId, tabId),

  /** Forwards a port of the SSH host for a link opened in the default browser. */
  startSshLinkForward: (
    workspaceId: string,
    remotePort: number,
    scheme: 'http' | 'https' = 'http'
  ): Promise<SshLinkForward> =>
    ipcRenderer.invoke(IPC.WORKSPACE_START_SSH_LINK_FORWARD, workspaceId, remotePort, scheme),

  stopSshLinkForward: (workspaceId: string, forwardId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_STOP_SSH_LINK_FORWARD, workspaceId, forwardId),

  clearTerminalAttention: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_CLEAR_TERMINAL_ATTENTION, terminalId),

  markTerminalAttentionSeen: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_TERMINAL_ATTENTION_SEEN, terminalId),

  // PTY operations (work for all terminals via terminalId)
  sendInput: (terminalId: string, data: string): void =>
    ipcRenderer.send(IPC.PTY_INPUT, terminalId, data),

  setTerminalFocus: (terminalId: string, focused: boolean): void =>
    ipcRenderer.send(IPC.TERMINAL_SET_FOCUS, terminalId, focused),

  resizePty: (terminalId: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.PTY_RESIZE, terminalId, cols, rows),

  /** Takes the terminal's size back from a phone; the desktop user typed or clicked in it. */
  claimTerminalSize: (terminalId: string): void =>
    ipcRenderer.send(IPC.TERMINAL_CLAIM_SIZE, terminalId),

  ackPtyOutput: (terminalId: string, chars: number): void =>
    ipcRenderer.send(IPC.PTY_ACK, terminalId, chars),

  getPtyBuffer: (
    terminalId: string
  ): Promise<{ buffer: string; seq: number; hostInfo?: TerminalHostInfo }> =>
    ipcRenderer.invoke(IPC.PTY_GET_BUFFER, terminalId),

  // Automation operations
  listAutomations: (
    options: { readHosts?: AutomationHostReads } = {}
  ): Promise<AutomationTargetSnapshot[]> => ipcRenderer.invoke(IPC.AUTOMATION_LIST, options),

  saveAutomation: (params: SaveAutomationParams): Promise<Automation> =>
    ipcRenderer.invoke(IPC.AUTOMATION_SAVE, params),

  setAutomationEnabled: (target: AutomationTarget, id: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.AUTOMATION_SET_ENABLED, target, id, enabled),

  deleteAutomation: (target: AutomationTarget, id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.AUTOMATION_DELETE, target, id),

  runAutomationNow: (target: AutomationTarget, id: string): Promise<AutomationRun> =>
    ipcRenderer.invoke(IPC.AUTOMATION_RUN_NOW, target, id),

  onAutomationsChange: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC.AUTOMATIONS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.AUTOMATIONS_CHANGED, handler);
  },

  // Category operations
  getCategories: (): Promise<Category[]> => ipcRenderer.invoke(IPC.CATEGORY_LIST),

  createCategory: (name: string, parentId?: string): Promise<Category> =>
    ipcRenderer.invoke(IPC.CATEGORY_CREATE, name, parentId),

  updateCategory: (id: string, updates: Partial<Category>): Promise<Category> =>
    ipcRenderer.invoke(IPC.CATEGORY_UPDATE, id, updates),

  deleteCategory: (id: string): Promise<void> => ipcRenderer.invoke(IPC.CATEGORY_DELETE, id),

  getCategorySettingsPath: (): Promise<string> =>
    ipcRenderer.invoke(IPC.CATEGORY_GET_SETTINGS_PATH),

  // Project operations
  createProject: (params: CreateProjectParams): Promise<Project> =>
    ipcRenderer.invoke(IPC.PROJECT_CREATE, params),

  getProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.PROJECT_LIST),

  getProject: (id: string): Promise<Project | undefined> => ipcRenderer.invoke(IPC.PROJECT_GET, id),

  updateProject: (id: string, updates: Partial<Project>): Promise<Project> =>
    ipcRenderer.invoke(IPC.PROJECT_UPDATE, id, updates),

  setProjectSshWorkspaceModeIfUnset: (id: string, mode: SshWorkspaceMode): Promise<Project> =>
    ipcRenderer.invoke(IPC.PROJECT_SET_SSH_WORKSPACE_MODE_IF_UNSET, id, mode),

  deleteProject: (id: string): Promise<{ deletedWorkspaceIds: string[] }> =>
    ipcRenderer.invoke(IPC.PROJECT_DELETE, id),

  validateProjectRepo: (path: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.PROJECT_VALIDATE_REPO, path),

  findProjectForFolder: (path: string): Promise<FolderProjectMatch> =>
    ipcRenderer.invoke(IPC.PROJECT_FIND_FOR_FOLDER, path),

  /** Puts a folder opened with Open Folder first among the recent folders. */
  recordOpenedFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PROJECT_FOLDER_OPENED, path),

  /** The recent folders that are still there, newest first. */
  getRecentFolders: (): Promise<string[]> => ipcRenderer.invoke(IPC.PROJECT_RECENT_FOLDERS),

  hasProjects: (): Promise<boolean> => ipcRenderer.invoke(IPC.PROJECT_HAS_PROJECTS),

  getProjectSettingsPath: (): Promise<string> => ipcRenderer.invoke(IPC.PROJECT_GET_SETTINGS_PATH),

  createProjectFromRemote: (params: CreateProjectFromRemoteParams): Promise<Project> =>
    ipcRenderer.invoke(IPC.PROJECT_CREATE_FROM_REMOTE, params),

  createProjectFromNew: (params: CreateProjectFromNewParams): Promise<Project> =>
    ipcRenderer.invoke(IPC.PROJECT_CREATE_FROM_NEW, params),

  findProjectIcons: (source: ProjectIconSource): Promise<ProjectIconCandidate[]> =>
    ipcRenderer.invoke(IPC.PROJECT_FIND_ICONS, source),

  takeProjectIconPrompt: (workspaceId: string): Promise<ProjectIconCandidate[]> =>
    ipcRenderer.invoke(IPC.PROJECT_TAKE_ICON_PROMPT, workspaceId),

  /** Null when cancelled; rejects when the file can't be an icon. */
  chooseProjectIconFile: (): Promise<ProjectIconCandidate | null> =>
    ipcRenderer.invoke(IPC.PROJECT_CHOOSE_ICON_FILE),

  /** `hostId` names the SSH host whose clone to check; null checks this computer's. */
  listLeftoverBranches: (projectId: string, hostId: string | null): Promise<LeftoverBranches> =>
    ipcRenderer.invoke(IPC.PROJECT_LIST_LEFTOVER_BRANCHES, projectId, hostId),

  deleteLeftoverBranches: (
    projectId: string,
    branches: Array<{ name: string; commit: string }>,
    hostId: string | null
  ): Promise<BranchDeletionResult> =>
    ipcRenderer.invoke(IPC.PROJECT_DELETE_LEFTOVER_BRANCHES, projectId, branches, hostId),

  /**
   * How each of the project's workspaces on a branch stands against its target branch, for
   * workspace cleanup, each in its own worktree, on its SSH host for an SSH workspace.
   */
  checkWorkspacesForCleanup: (projectId: string): Promise<WorkspaceCleanupStatus[]> =>
    ipcRenderer.invoke(IPC.PROJECT_CHECK_WORKSPACES_FOR_CLEANUP, projectId),

  /** Local branches in the SSH host's clone of the project, most recent first. */
  listProjectHostBranches: (projectId: string, hostId: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.PROJECT_LIST_HOST_BRANCHES, projectId, hostId),

  validateRemoteUrl: (url: string): Promise<{ valid: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.GIT_VALIDATE_REMOTE_URL, url),

  // Config operations
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_GET),

  updateConfig: (updates: Partial<AppConfig>): Promise<AppConfig> =>
    ipcRenderer.invoke(IPC.CONFIG_UPDATE, updates),

  /** Another window saved the config. */
  onConfigChanged: (callback: (config: AppConfig) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, config: AppConfig): void => {
      callback(config);
    };
    ipcRenderer.on(IPC.CONFIG_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.CONFIG_CHANGED, handler);
  },

  saveOpenRouterApiKey: (apiKey: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CONFIG_SAVE_OPENROUTER_API_KEY, apiKey),

  clearOpenRouterApiKey: (): Promise<void> =>
    ipcRenderer.invoke(IPC.CONFIG_CLEAR_OPENROUTER_API_KEY),

  getOpenRouterKeyStatus: (): Promise<UtilityOpenRouterKeyStatus> =>
    ipcRenderer.invoke(IPC.CONFIG_GET_OPENROUTER_KEY_STATUS),

  testCustomEndpoint: (): Promise<CustomEndpointTestResult> =>
    ipcRenderer.invoke(IPC.CONFIG_TEST_CUSTOM_ENDPOINT),

  verifySshHost: (host: SshHost, options?: { prepare?: boolean }): Promise<SshHostSetupResult> =>
    options
      ? ipcRenderer.invoke(IPC.CONFIG_VERIFY_SSH_HOST, host, options)
      : ipcRenderer.invoke(IPC.CONFIG_VERIFY_SSH_HOST, host),

  listSshHosts: (): Promise<SshHost[]> => ipcRenderer.invoke(IPC.SSH_LIST_HOSTS),

  /** The Host entries in ~/.ssh/config, for filling in a new SSH host. */
  listSshConfigHosts: (): Promise<SshConfigHost[]> => ipcRenderer.invoke(IPC.SSH_LIST_CONFIG_HOSTS),

  saveSshHost: (host: SshHost): Promise<SshHost> => ipcRenderer.invoke(IPC.SSH_SAVE_HOST, host),

  onSshHostsChange: (callback: (hosts: SshHost[]) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, hosts: SshHost[]): void => {
      callback(hosts);
    };
    ipcRenderer.on(IPC.SSH_HOSTS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SSH_HOSTS_CHANGED, handler);
  },

  getSshHostStatuses: (): Promise<SshHostStatus[]> => ipcRenderer.invoke(IPC.SSH_HOST_STATUSES_GET),
  /** Runs a quick command on the host to learn whether it answers. */
  checkSshHost: (hostId: string): Promise<SshHostStatus | undefined> =>
    ipcRenderer.invoke(IPC.SSH_HOST_CHECK, hostId),
  onSshHostStatusesChange: (callback: (statuses: SshHostStatus[]) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, statuses: SshHostStatus[]): void => {
      callback(statuses);
    };
    ipcRenderer.on(IPC.SSH_HOST_STATUSES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SSH_HOST_STATUSES_CHANGED, handler);
  },

  deleteSshHost: (
    hostId: string,
    options?: { deleteRemoteData?: boolean }
  ): Promise<{ deletedWorkspaceIds: string[] }> =>
    ipcRenderer.invoke(IPC.SSH_DELETE_HOST, hostId, options),

  getSshIntegrationStatus: (hostId: string): Promise<SshIntegrationStatus> =>
    ipcRenderer.invoke(IPC.SSH_GET_INTEGRATION_STATUS, hostId),

  /** Agents needing a notification update per SSH host, as of each host's last check. */
  getCachedSshIntegrationUpdates: (): Promise<Record<string, SshIntegrationUpdates>> =>
    ipcRenderer.invoke(IPC.SSH_GET_CACHED_INTEGRATION_UPDATES),

  onSshIntegrationUpdatesChange: (
    callback: (updates: Record<string, SshIntegrationUpdates>) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      updates: Record<string, SshIntegrationUpdates>
    ): void => {
      callback(updates);
    };
    ipcRenderer.on(IPC.SSH_INTEGRATION_UPDATES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SSH_INTEGRATION_UPDATES_CHANGED, handler);
  },

  getSshPortForwardStatus: (hostId: string): Promise<SshPortForwardStatus> =>
    ipcRenderer.invoke(IPC.SSH_GET_PORT_FORWARD_STATUS, hostId),

  listSshForwardedPorts: (): Promise<SshForwardedPort[]> =>
    ipcRenderer.invoke(IPC.SSH_LIST_FORWARDED_PORTS),

  /** Stops the forward of one of the host's virtual desktops. */
  stopSshDesktopForward: (hostId: string, remotePort: number): Promise<void> =>
    ipcRenderer.invoke(IPC.SSH_STOP_DESKTOP_FORWARD, hostId, remotePort),

  enableSshIntegration: (hostId: string, agent: string, type: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SSH_ENABLE_INTEGRATION, hostId, agent, type),

  disableSshIntegration: (hostId: string, agent: string, type: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SSH_DISABLE_INTEGRATION, hostId, agent, type),

  setSshKomlaSkill: (hostId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.SSH_SET_KOMLA_SKILL, hostId, enabled),

  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.CONFIG_SELECT_DIRECTORY),

  selectAnyDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.CONFIG_SELECT_ANY_DIRECTORY),

  // Agent preset operations
  getPresetTemplates: (): Promise<Omit<AgentPreset, 'id'>[]> =>
    ipcRenderer.invoke(IPC.PRESET_LIST_TEMPLATES),

  getPresets: (): Promise<AgentPreset[]> => ipcRenderer.invoke(IPC.PRESET_LIST),

  getPreset: (id: string): Promise<AgentPreset | undefined> =>
    ipcRenderer.invoke(IPC.PRESET_GET, id),

  getActivePreset: (): Promise<AgentPreset | undefined> =>
    ipcRenderer.invoke(IPC.PRESET_GET_ACTIVE),

  setActivePreset: (id: string, launchModeId?: string | null): Promise<void> =>
    launchModeId === undefined
      ? ipcRenderer.invoke(IPC.PRESET_SET_ACTIVE, id)
      : ipcRenderer.invoke(IPC.PRESET_SET_ACTIVE, id, launchModeId),

  createPreset: (preset: Omit<AgentPreset, 'id'>): Promise<AgentPreset> =>
    ipcRenderer.invoke(IPC.PRESET_CREATE, preset),

  // Creates the presets and activates them in order, the first as the most recently used.
  createActivePresets: (presets: Omit<AgentPreset, 'id'>[]): Promise<AgentPreset[]> =>
    ipcRenderer.invoke(IPC.PRESET_CREATE_ACTIVE, presets),

  // Names of the agent templates whose CLI is installed on this computer.
  detectInstalledAgents: (): Promise<string[]> => ipcRenderer.invoke(IPC.PRESET_DETECT_INSTALLED),

  updatePreset: (id: string, updates: Partial<Omit<AgentPreset, 'id'>>): Promise<AgentPreset> =>
    ipcRenderer.invoke(IPC.PRESET_UPDATE, id, updates),

  deletePreset: (id: string): Promise<void> => ipcRenderer.invoke(IPC.PRESET_DELETE, id),

  reorderPreset: (id: string, newOrder: number): Promise<void> =>
    ipcRenderer.invoke(IPC.PRESET_REORDER, id, newOrder),

  getPresetSettingsPath: (): Promise<string> => ipcRenderer.invoke(IPC.PRESET_GET_SETTINGS_PATH),

  buildPromptCommand: (
    prompt: string,
    presetId?: string,
    launchModeId?: string
  ): Promise<string | null> =>
    ipcRenderer.invoke(IPC.PRESET_BUILD_PROMPT_COMMAND, prompt, presetId, launchModeId),

  getActivePresets: (): Promise<ActivePresetEntry[]> =>
    ipcRenderer.invoke(IPC.PRESET_GET_ACTIVE_PRESETS),

  addActivePreset: (id: string): Promise<void> => ipcRenderer.invoke(IPC.PRESET_ADD_ACTIVE, id),

  removeActivePreset: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PRESET_REMOVE_ACTIVE, id),

  // Git operations
  listWorktrees: (repoPath: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.GIT_LIST_WORKTREES, repoPath),

  getWorktreeBranches: (repoPath: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.GIT_GET_WORKTREE_BRANCHES, repoPath),

  validateRepo: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.GIT_VALIDATE_REPO, path),

  getChangedFilesWithSummary: (
    worktreePath: string
  ): Promise<{
    files: FileChange[];
    summary: { additions: number; deletions: number; filesChanged: number };
  }> => ipcRenderer.invoke(IPC.GIT_GET_CHANGED_FILES_WITH_SUMMARY, worktreePath),

  getDiff: (worktreePath: string): Promise<WorktreeDiff> =>
    ipcRenderer.invoke(IPC.GIT_GET_DIFF, worktreePath),

  getDiffAgainstBranch: (
    worktreePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<WorktreeDiff> =>
    ipcRenderer.invoke(IPC.GIT_GET_DIFF_AGAINST_BRANCH, worktreePath, branch, useMergeBase),

  getFileDiffContent: (
    worktreePath: string,
    filePath: string,
    staged: boolean
  ): Promise<FileDiffContent> =>
    ipcRenderer.invoke(IPC.GIT_GET_FILE_DIFF_CONTENT, worktreePath, filePath, staged),

  getFileDiffContentAgainstBranch: (
    worktreePath: string,
    filePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<FileDiffContent> =>
    ipcRenderer.invoke(
      IPC.GIT_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
      worktreePath,
      filePath,
      branch,
      useMergeBase
    ),

  getWorkspaceDiff: (workspaceId: string): Promise<WorktreeDiff> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_DIFF, workspaceId),

  getWorkspaceDiffAgainstBranch: (
    workspaceId: string,
    branch: string,
    useMergeBase = false
  ): Promise<WorktreeDiff> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_DIFF_AGAINST_BRANCH, workspaceId, branch, useMergeBase),

  getWorkspaceFileDiffContent: (
    workspaceId: string,
    filePath: string,
    staged: boolean
  ): Promise<FileDiffContent> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_FILE_DIFF_CONTENT, workspaceId, filePath, staged),

  getWorkspaceFileDiffContentAgainstBranch: (
    workspaceId: string,
    filePath: string,
    branch: string,
    useMergeBase = false
  ): Promise<FileDiffContent> =>
    ipcRenderer.invoke(
      IPC.WORKSPACE_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH,
      workspaceId,
      filePath,
      branch,
      useMergeBase
    ),

  listWorkspaceFiles: (
    workspaceId: string,
    includeGitIgnored?: boolean
  ): Promise<{
    files: string[];
    gitIgnoredFiles: string[];
    emptyDirs: string[];
    managedLinkPaths?: string[];
    fileListHash?: string;
  }> => ipcRenderer.invoke(IPC.WORKSPACE_LIST_FILES, workspaceId, includeGitIgnored),

  readWorkspaceFile: (workspaceId: string, filePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.WORKSPACE_READ_FILE, workspaceId, filePath),

  searchWorkspaceContent: (
    workspaceId: string,
    query: string,
    options?: ContentSearchOptions
  ): Promise<ContentSearchResult[]> =>
    ipcRenderer.invoke(IPC.WORKSPACE_SEARCH_CONTENT, workspaceId, query, options),

  readWorkspaceImageFile: (
    workspaceId: string,
    filePath: string
  ): Promise<{ data: string; mimeType: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_READ_IMAGE_FILE, workspaceId, filePath),

  writeWorkspaceFile: (workspaceId: string, filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_WRITE_FILE, workspaceId, filePath, content),

  deleteWorkspacePath: (workspaceId: string, filePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_DELETE_PATH, workspaceId, filePath),

  importWorkspaceExternalFile: (
    workspaceId: string,
    sourcePath: string,
    preferredName?: string,
    executionLocation?: 'workspace' | 'local-mirror'
  ): Promise<string> =>
    ipcRenderer.invoke(
      IPC.WORKSPACE_IMPORT_EXTERNAL_FILE,
      workspaceId,
      sourcePath,
      preferredName,
      executionLocation
    ),

  readViewerFile: (
    workspaceId: string,
    terminalId: string | null,
    source: ViewerFileSource
  ): Promise<ViewerFile> =>
    ipcRenderer.invoke(IPC.WORKSPACE_READ_VIEWER_FILE, workspaceId, terminalId, source),

  getViewerPreviewUrl: (
    workspaceId: string,
    terminalId: string | null,
    source: ViewerFileSource,
    options?: { replacesPrevious?: boolean }
  ): Promise<string> =>
    ipcRenderer.invoke(
      IPC.WORKSPACE_GET_VIEWER_PREVIEW_URL,
      workspaceId,
      terminalId,
      source,
      options
    ),

  listViewerFolder: (
    workspaceId: string,
    terminalId: string | null,
    source: ViewerFileSource
  ): Promise<ViewerFolderFile[]> =>
    ipcRenderer.invoke(IPC.WORKSPACE_LIST_VIEWER_FOLDER, workspaceId, terminalId, source),

  getDirectoryInfo: (path: string): Promise<DirectoryInfo> =>
    ipcRenderer.invoke(IPC.GIT_GET_DIRECTORY_INFO, path),

  getGitBranchStatus: (worktreePath: string, projectId?: string): Promise<GitBranchQuickStatus> =>
    ipcRenderer.invoke(IPC.GIT_GET_BRANCH_STATUS, worktreePath, projectId),

  getWorkspaceGitBranchStatus: (
    workspaceId: string,
    projectId?: string
  ): Promise<GitBranchQuickStatus> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_BRANCH_STATUS, workspaceId, projectId),

  listWorkspaceBranches: (workspaceId: string, includeRemote = false): Promise<BranchInfo[]> =>
    ipcRenderer.invoke(IPC.WORKSPACE_LIST_BRANCHES, workspaceId, includeRemote),

  getWorkspaceCommitGraph: (workspaceId: string, query: CommitGraphQuery): Promise<CommitGraph> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_COMMIT_GRAPH, workspaceId, query),

  getWorkspacePullRequestStatus: (workspaceId: string): Promise<PullRequestStatus> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_PULL_REQUEST_STATUS, workspaceId),

  getWorkspaceCommitDiff: (workspaceId: string, commitHash: string): Promise<CommitDiff> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_COMMIT_DIFF, workspaceId, commitHash),

  getWorkspaceCommitFileDiff: (
    workspaceId: string,
    commitHash: string,
    filePath: string
  ): Promise<FileDiffContent> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GET_COMMIT_FILE_DIFF, workspaceId, commitHash, filePath),

  fetchWorkspaceRemote: (workspaceId: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_FETCH_REMOTE, workspaceId),

  mergeWorkspaceFrom: (
    workspaceId: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_MERGE_FROM, workspaceId, branchName, options),

  rebaseWorkspaceOnBranch: (
    workspaceId: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_REBASE_ON_BRANCH, workspaceId, branchName, options),

  pushWorkspace: (
    workspaceId: string
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_PUSH, workspaceId),

  pullWorkspace: (workspaceId: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_PULL, workspaceId),

  pushWorkspaceTargetBranch: (
    workspaceId: string
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_PUSH_TARGET_BRANCH, workspaceId),

  pullWorkspaceTargetBranch: (
    workspaceId: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_PULL_TARGET_BRANCH, workspaceId),

  mergeWorkspaceTargetBranchFromRemote: (
    workspaceId: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_MERGE_TARGET_BRANCH_FROM_REMOTE, workspaceId),

  mergeWorkspaceToTargetBranch: (
    workspaceId: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_MERGE_TO_TARGET_BRANCH, workspaceId),

  restoreWorkspaceFile: (
    workspaceId: string,
    filePath: string,
    status: FileChange['status'],
    oldPath?: string
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_RESTORE_FILE, workspaceId, filePath, status, oldPath),

  discardWorkspaceChanges: (workspaceId: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_DISCARD_ALL_CHANGES, workspaceId),

  mergeFrom: (
    worktreePath: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_MERGE_FROM, worktreePath, branchName, options),

  listBranches: (repoPath: string, includeRemote = false): Promise<BranchInfo[]> =>
    ipcRenderer.invoke(IPC.GIT_LIST_BRANCHES, repoPath, includeRemote),

  hasOriginRemote: (repoPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GIT_HAS_ORIGIN_REMOTE, repoPath),

  getMainBranch: (repoPath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.GIT_GET_MAIN_BRANCH, repoPath),

  fetchFromRemote: (repoPath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_FETCH, repoPath),

  push: (
    worktreePath: string
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> =>
    ipcRenderer.invoke(IPC.GIT_PUSH, worktreePath),

  pull: (worktreePath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_PULL, worktreePath),

  pullRebase: (worktreePath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_PULL_REBASE, worktreePath),

  pushTargetBranch: (
    worktreePath: string
  ): Promise<{ success: boolean; message: string; errorCode?: 'rejected' }> =>
    ipcRenderer.invoke(IPC.GIT_PUSH_TARGET_BRANCH, worktreePath),

  pullTargetBranch: (worktreePath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_PULL_TARGET_BRANCH, worktreePath),

  mergeTargetBranchFromRemote: (
    worktreePath: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_MERGE_TARGET_BRANCH_FROM_REMOTE, worktreePath),

  rebaseOnTargetBranch: (
    worktreePath: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_REBASE_ON_TARGET_BRANCH, worktreePath, options),

  rebaseOnBranch: (
    worktreePath: string,
    branchName: string,
    options?: { stash?: boolean }
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_REBASE_ON_BRANCH, worktreePath, branchName, options),

  abortRebase: (worktreePath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_ABORT_REBASE, worktreePath),

  mergeToTargetBranch: (worktreePath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_MERGE_TO_TARGET_BRANCH, worktreePath),

  switchBranch: (
    worktreePath: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_SWITCH_BRANCH, worktreePath, branchName),

  deleteBranch: (
    worktreePath: string,
    branchName: string,
    force?: boolean
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_DELETE_BRANCH, worktreePath, branchName, force ?? false),

  deleteRemoteBranch: (
    worktreePath: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_DELETE_REMOTE_BRANCH, worktreePath, branchName),

  getBranchUrl: (worktreePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.GIT_GET_BRANCH_URL, worktreePath),

  getCreatePrUrl: (worktreePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.GIT_GET_CREATE_PR_URL, worktreePath),

  /** The web page of a repository's origin remote, when Komla can tell it. */
  getRepoWebInfo: (repoPath: string): Promise<{ webUrl: string | null }> =>
    ipcRenderer.invoke(IPC.GIT_GET_REPO_WEB_INFO, repoPath),

  addOriginRemote: (
    repoPath: string,
    url: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_ADD_ORIGIN_REMOTE, repoPath, url),

  createGithubRepo: (
    repoPath: string,
    repoName: string,
    isPrivate: boolean
  ): Promise<{ success: boolean; message: string; url?: string }> =>
    ipcRenderer.invoke(IPC.GIT_CREATE_GITHUB_REPO, repoPath, repoName, isPrivate),

  /** Pushes the given local branches to origin where origin doesn't have them yet. */
  pushProjectBranches: (
    projectId: string,
    branches: string[]
  ): Promise<{ success: boolean; message: string; removedOrigin?: boolean }> =>
    ipcRenderer.invoke(IPC.GIT_PUSH_PROJECT_BRANCHES, projectId, branches),

  checkGhAuth: (): Promise<{ authenticated: boolean; username?: string; installed: boolean }> =>
    ipcRenderer.invoke(IPC.GIT_CHECK_GH_AUTH),

  getGitIdentity: (): Promise<GitIdentityStatus> => ipcRenderer.invoke(IPC.GIT_GET_IDENTITY),

  setGitIdentity: (
    userName: string,
    userEmail: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_SET_IDENTITY, userName, userEmail),

  fileExists: (dirPath: string, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GIT_FILE_EXISTS, dirPath, filePath),

  getFileMetadata: (
    dirPath: string,
    filePath: string
  ): Promise<{ size: number; mtimeMs: number }> =>
    ipcRenderer.invoke(IPC.GIT_GET_FILE_METADATA, dirPath, filePath),

  copyFile: (workingDir: string, src: string, dest: string): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_COPY_FILE, workingDir, src, dest),

  copyDirectory: (workingDir: string, src: string, dest: string): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_COPY_DIRECTORY, workingDir, src, dest),

  importExternalFile: (
    workingDir: string,
    sourcePath: string,
    preferredName?: string
  ): Promise<string> =>
    ipcRenderer.invoke(IPC.GIT_IMPORT_EXTERNAL_FILE, workingDir, sourcePath, preferredName),

  deleteFile: (worktreePath: string, filePath: string, status: string): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_DELETE_FILE, worktreePath, filePath, status),

  renameFile: (worktreePath: string, oldPath: string, newPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_RENAME_FILE, worktreePath, oldPath, newPath),

  createDirectory: (worktreePath: string, dirPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_CREATE_DIRECTORY, worktreePath, dirPath),

  writeFile: (worktreePath: string, filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_WRITE_FILE, worktreePath, filePath, content),

  listFiles: (
    dirPath: string,
    includeGitIgnored?: boolean
  ): Promise<{ files: string[]; gitIgnoredFiles: string[]; emptyDirs: string[] }> =>
    ipcRenderer.invoke(IPC.GIT_LIST_FILES, dirPath, includeGitIgnored),

  readFile: (dirPath: string, filePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC.GIT_READ_FILE, dirPath, filePath),

  getHtmlPreviewUrl: (dirPath: string, filePath: string, content?: string): Promise<string> =>
    ipcRenderer.invoke(IPC.GIT_GET_HTML_PREVIEW_URL, dirPath, filePath, content),

  readImageFile: (dirPath: string, filePath: string): Promise<{ data: string; mimeType: string }> =>
    ipcRenderer.invoke(IPC.GIT_READ_IMAGE_FILE, dirPath, filePath),

  getMediaFileMetadata: (
    dirPath: string,
    filePath: string
  ): Promise<{ mimeType: string; kind: 'audio' | 'video'; size: number; mtimeMs: number }> =>
    ipcRenderer.invoke(IPC.GIT_GET_MEDIA_FILE_METADATA, dirPath, filePath),

  readMediaFile: (
    dirPath: string,
    filePath: string
  ): Promise<{ data: string; mimeType: string; kind: 'audio' | 'video' }> =>
    ipcRenderer.invoke(IPC.GIT_READ_MEDIA_FILE, dirPath, filePath),

  restoreFile: (
    worktreePath: string,
    filePath: string,
    status: string,
    oldPath?: string
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_RESTORE_FILE, worktreePath, filePath, status, oldPath),

  discardAllChanges: (worktreePath: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.GIT_DISCARD_ALL_CHANGES, worktreePath),

  inspectCommitScope: (worktreePath: string): Promise<CommitScopeResult> =>
    ipcRenderer.invoke(IPC.GIT_INSPECT_COMMIT_SCOPE, worktreePath),

  generateCommitDraft: (worktreePath: string, scope?: CommitScope): Promise<CommitDraftResult> =>
    ipcRenderer.invoke(IPC.GIT_GENERATE_COMMIT_DRAFT, worktreePath, scope),

  commitChanges: (
    worktreePath: string,
    input: { subject: string; body?: string | null; scope: CommitScope }
  ): Promise<CommitChangesResult> =>
    ipcRenderer.invoke(IPC.GIT_COMMIT_CHANGES, worktreePath, input),

  inspectWorkspaceCommitScope: (workspaceId: string): Promise<CommitScopeResult> =>
    ipcRenderer.invoke(IPC.WORKSPACE_INSPECT_COMMIT_SCOPE, workspaceId),

  generateWorkspaceCommitDraft: (workspaceId: string): Promise<CommitDraftResult> =>
    ipcRenderer.invoke(IPC.WORKSPACE_GENERATE_COMMIT_DRAFT, workspaceId),

  commitWorkspaceChanges: (
    workspaceId: string,
    input: { subject: string; body?: string | null; scope: CommitScope }
  ): Promise<CommitChangesResult> =>
    ipcRenderer.invoke(IPC.WORKSPACE_COMMIT_CHANGES, workspaceId, input),

  createWorkspaceBranch: (
    workspaceId: string,
    branchName: string,
    startPoint?: string
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_CREATE_BRANCH, workspaceId, branchName, startPoint),

  switchWorkspaceBranch: (
    workspaceId: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.WORKSPACE_SWITCH_BRANCH, workspaceId, branchName),

  getBlame: (worktreePath: string, filePath: string, commitHash?: string): Promise<BlameHunk[]> =>
    ipcRenderer.invoke(IPC.GIT_GET_BLAME, worktreePath, filePath, commitHash),

  refreshGitStatus: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.GIT_REFRESH_STATUS, workspaceId),

  getWorkspaceObservations: (): Promise<WorkspaceObservationProjection[]> =>
    ipcRenderer.invoke(IPC.WORKSPACE_OBSERVATIONS_GET),

  onWorkspaceObservation: (
    callback: (projection: WorkspaceObservationProjection) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      projection: WorkspaceObservationProjection
    ): void => callback(projection);
    ipcRenderer.on(IPC.WORKSPACE_OBSERVATION_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_OBSERVATION_CHANGED, handler);
  },

  // Shell operations
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url),

  // Telemetry
  getTelemetryDistinctId: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.TELEMETRY_GET_DISTINCT_ID),
  trackMonetizationEvent: (
    event: 'free_limit_hit' | 'upgrade_clicked' | 'license_activated',
    props?: {
      source?: 'create_workspace' | 'start_workspace' | 'free_limit_wall';
      limit?: number;
      runningCount?: number;
    }
  ): Promise<void> => ipcRenderer.invoke(IPC.TELEMETRY_TRACK_MONETIZATION, event, props),
  trackAgentSelected: (agent: string): Promise<void> =>
    ipcRenderer.invoke(IPC.TELEMETRY_TRACK_AGENT_SELECTED, agent),
  trackSshHostAdded: (source: SshHostAddedSource): Promise<void> =>
    ipcRenderer.invoke(IPC.TELEMETRY_TRACK_SSH_HOST_ADDED, source),

  showItemInFolder: (fullPath: string): void => {
    void ipcRenderer.invoke(IPC.SHELL_SHOW_ITEM_IN_FOLDER, fullPath);
  },

  openPath: (fullPath: string): Promise<void> => ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, fullPath),

  getAvailableEditors: (): Promise<{ id: string; name: string }[]> =>
    ipcRenderer.invoke(IPC.SHELL_GET_AVAILABLE_EDITORS),

  openInEditor: (editorId: string, dirPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SHELL_OPEN_IN_EDITOR, editorId, dirPath),

  getWslDistros: (): Promise<string[]> => ipcRenderer.invoke(IPC.SHELL_GET_WSL_DISTROS),

  // Notes
  listNotes: (scopeId: string): Promise<NoteSummary[]> =>
    ipcRenderer.invoke(IPC.NOTES_LIST, scopeId),
  createNote: (scopeId: string): Promise<NoteSummary> =>
    ipcRenderer.invoke(IPC.NOTES_CREATE, scopeId),
  readNote: (scopeId: string, name: string): Promise<string> =>
    ipcRenderer.invoke(IPC.NOTES_READ, scopeId, name),
  writeNote: (scopeId: string, name: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.NOTES_WRITE, scopeId, name, content),
  trashNote: (scopeId: string, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.NOTES_TRASH, scopeId, name),
  /** Deletes a note for good; with onlyIfBlank, only a note with no text. Returns whether it did. */
  deleteNote: (scopeId: string, name: string, onlyIfBlank: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.NOTES_DELETE, scopeId, name, onlyIfBlank),
  onNotesChanged: (callback: (scopeId: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, scopeId: string): void => {
      callback(scopeId);
    };
    ipcRenderer.on(IPC.NOTES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.NOTES_CHANGED, handler);
  },

  // Sounds
  listCustomSounds: (): Promise<string[]> => ipcRenderer.invoke(IPC.SOUNDS_LIST_CUSTOM),
  getSoundDataUrl: (filename: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.SOUNDS_GET_DATA_URL, filename),
  openSoundsDirectory: (): Promise<void> => ipcRenderer.invoke(IPC.SOUNDS_OPEN_DIRECTORY),

  // Event subscriptions
  onPtyData: (callback: (terminalId: string, data: string, seq: number) => void): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      terminalId: string,
      data: string,
      seq: number
    ): void => {
      callback(terminalId, data, seq);
    };
    ipcRenderer.on(IPC.PTY_DATA, handler);
    return () => ipcRenderer.removeListener(IPC.PTY_DATA, handler);
  },

  onTerminalStatusChange: (
    callback: (terminalId: string, status: TerminalStatus) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      terminalId: string,
      status: TerminalStatus
    ): void => {
      callback(terminalId, status);
    };
    ipcRenderer.on(IPC.TERMINAL_STATUS_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_STATUS_CHANGE, handler);
  },

  onTerminalExit: (
    callback: (terminalId: string, exitCode: number, signal?: number) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      terminalId: string,
      exitCode: number,
      signal?: number
    ): void => {
      callback(terminalId, exitCode, signal);
    };
    ipcRenderer.on(IPC.TERMINAL_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, handler);
  },

  onTerminalHostChanged: (
    callback: (terminalId: string, hostname: string, isLocal: boolean) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      terminalId: string,
      hostname: string,
      isLocal: boolean
    ): void => {
      callback(terminalId, hostname, isLocal);
    };
    ipcRenderer.on(IPC.TERMINAL_HOST_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_HOST_CHANGED, handler);
  },

  onTerminalReset: (callback: (terminalId: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, terminalId: string): void => {
      callback(terminalId);
    };
    ipcRenderer.on(IPC.TERMINAL_RESET, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_RESET, handler);
  },

  onTerminalSizeAuthorityChanged: (
    callback: (terminalId: string, remoteOwned: boolean, cols: number, rows: number) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      terminalId: string,
      remoteOwned: boolean,
      cols: number,
      rows: number
    ): void => callback(terminalId, remoteOwned, cols, rows);
    ipcRenderer.on(IPC.TERMINAL_SIZE_AUTHORITY, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_SIZE_AUTHORITY, handler);
  },

  onTerminalError: (callback: (terminalId: string, error: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, terminalId: string, error: string): void => {
      callback(terminalId, error);
    };
    ipcRenderer.on(IPC.TERMINAL_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_ERROR, handler);
  },

  // Notification operations
  enableNotifications: (): Promise<void> => ipcRenderer.invoke(IPC.NOTIFICATIONS_ENABLE),

  disableNotifications: (): Promise<void> => ipcRenderer.invoke(IPC.NOTIFICATIONS_DISABLE),

  clearWorkspaceAttention: (workspaceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.NOTIFICATIONS_CLEAR_ATTENTION, workspaceId),

  // Hook details (for displaying in UI)
  getNotificationHookDetails: (): Promise<{
    command: string;
    configJson: string;
    settingsPath: string;
    port: number;
    isConfigured: boolean;
    update?: NotificationIntegrationUpdate;
  }> => ipcRenderer.invoke(IPC.NOTIFICATIONS_GET_HOOK_DETAILS),

  enableCodexNotifications: (): Promise<void> => ipcRenderer.invoke(IPC.CODEX_NOTIFICATIONS_ENABLE),

  disableCodexNotifications: (): Promise<void> =>
    ipcRenderer.invoke(IPC.CODEX_NOTIFICATIONS_DISABLE),

  getCodexNotificationHookDetails: (): Promise<{
    command: string;
    configJson: string;
    settingsPath: string;
    port: number;
    isConfigured: boolean;
    update?: NotificationIntegrationUpdate;
    hasConflict: boolean;
    canAutoConfigure: boolean;
    conflictMessage: string | null;
    isKomlaManaged?: boolean;
  }> => ipcRenderer.invoke(IPC.CODEX_NOTIFICATIONS_GET_HOOK_DETAILS),

  enableCodexNotificationsForce: (): Promise<{
    success: boolean;
    backupPath?: string;
    error?: string;
  }> => ipcRenderer.invoke(IPC.CODEX_NOTIFICATIONS_ENABLE_FORCE),

  enableAntigravityNotifications: (): Promise<void> =>
    ipcRenderer.invoke(IPC.ANTIGRAVITY_NOTIFICATIONS_ENABLE),

  disableAntigravityNotifications: (): Promise<void> =>
    ipcRenderer.invoke(IPC.ANTIGRAVITY_NOTIFICATIONS_DISABLE),

  getAntigravityNotificationHookDetails: (): Promise<{
    command: string;
    configJson: string;
    settingsPath: string;
    port: number;
    isConfigured: boolean;
    update?: NotificationIntegrationUpdate;
  }> => ipcRenderer.invoke(IPC.ANTIGRAVITY_NOTIFICATIONS_GET_HOOK_DETAILS),

  // The Komla skill in the user-level skills folders agents read
  getKomlaSkillStatus: (): Promise<KomlaSkillStatus> =>
    ipcRenderer.invoke(IPC.KOMLA_SKILL_GET_STATUS),

  enableKomlaSkill: (): Promise<void> => ipcRenderer.invoke(IPC.KOMLA_SKILL_ENABLE),

  disableKomlaSkill: (): Promise<void> => ipcRenderer.invoke(IPC.KOMLA_SKILL_DISABLE),

  // MCP operations
  getMcpStatus: (agent?: string, sshHostId?: string): Promise<McpStatus> =>
    ipcRenderer.invoke(IPC.MCP_GET_STATUS, agent, sshHostId),

  enableMcp: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_ENABLE),

  disableMcp: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_DISABLE),

  runMcpCli: (): Promise<{ success: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_RUN_CLI),

  runMcpRemoveCli: (): Promise<{ success: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_RUN_REMOVE_CLI),

  runCodexMcpCli: (): Promise<{ success: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_RUN_CODEX_CLI),

  runCodexMcpRemoveCli: (): Promise<{ success: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_RUN_CODEX_REMOVE_CLI),

  runAntigravityMcpCli: (): Promise<{ success: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_RUN_ANTIGRAVITY_CLI),

  runAntigravityMcpRemoveCli: (): Promise<{ success: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_RUN_ANTIGRAVITY_REMOVE_CLI),

  enableOpenCodeNotifications: (): Promise<void> =>
    ipcRenderer.invoke(IPC.OPENCODE_NOTIFICATIONS_ENABLE),

  disableOpenCodeNotifications: (): Promise<void> =>
    ipcRenderer.invoke(IPC.OPENCODE_NOTIFICATIONS_DISABLE),

  getOpenCodeNotificationHookDetails: (): Promise<{
    pluginContent: string;
    pluginPath: string;
    port: number;
    isConfigured: boolean;
    update?: NotificationIntegrationUpdate;
  }> => ipcRenderer.invoke(IPC.OPENCODE_NOTIFICATIONS_GET_HOOK_DETAILS),

  getPortChange: (): Promise<{ oldPort: number; newPort: number } | null> =>
    ipcRenderer.invoke(IPC.SERVER_GET_PORT_CHANGE),

  getServerPort: (): Promise<number> => ipcRenderer.invoke(IPC.SERVER_GET_PORT),

  reconfigureMcp: (): Promise<{
    success: boolean;
    results: { agent: string; success: boolean; error?: string }[];
  }> => ipcRenderer.invoke(IPC.MCP_RECONFIGURE_ALL),

  onWorkspaceNeedsAttention: (callback: (event: WorkspaceAttentionEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: WorkspaceAttentionEvent): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.WORKSPACE_NEEDS_ATTENTION, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_NEEDS_ATTENTION, handler);
  },

  onWorkspaceCreated: (callback: (workspace: Workspace) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, workspace: Workspace): void => {
      callback(workspace);
    };
    ipcRenderer.on(IPC.WORKSPACE_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_CREATED, handler);
  },

  onWorkspaceUpdated: (callback: (workspace: Workspace) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, workspace: Workspace): void => {
      callback(workspace);
    };
    ipcRenderer.on(IPC.WORKSPACE_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_UPDATED, handler);
  },

  onLocalMirrorSyncStatus: (callback: (status: LocalMirrorSyncStatus) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, status: LocalMirrorSyncStatus): void => {
      callback(status);
    };
    ipcRenderer.on(IPC.WORKSPACE_LOCAL_MIRROR_SYNC_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_LOCAL_MIRROR_SYNC_STATUS, handler);
  },

  onWorkspacesChanged: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(IPC.WORKSPACES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACES_CHANGED, handler);
  },

  onWorkspaceRemovedOnOtherDevice: (
    callback: (event: SshWorkspaceRemovedOnOtherDevice) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      event: SshWorkspaceRemovedOnOtherDevice
    ): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.WORKSPACE_REMOVED_ON_OTHER_DEVICE, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_REMOVED_ON_OTHER_DEVICE, handler);
  },

  onWorkspaceLayoutChangedOnOtherDevice: (
    callback: (event: SshWorkspaceLayoutChangedOnOtherDevice) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      event: SshWorkspaceLayoutChangedOnOtherDevice
    ): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.WORKSPACE_LAYOUT_CHANGED_ON_OTHER_DEVICE, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_LAYOUT_CHANGED_ON_OTHER_DEVICE, handler);
  },

  onAgentTabAdded: (
    callback: (event: { workspaceId: string; terminalId: string }) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      event: { workspaceId: string; terminalId: string }
    ): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.WORKSPACE_AGENT_TAB_ADDED, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_AGENT_TAB_ADDED, handler);
  },

  /** `komla desktop run` started a virtual desktop for the workspace without opening it. */
  onVirtualDesktopStarted: (
    callback: (event: { workspaceId: string; desktop: WorkspaceVirtualDesktop }) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      event: { workspaceId: string; desktop: WorkspaceVirtualDesktop }
    ): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.VIRTUAL_DESKTOP_STARTED, handler);
    return () => ipcRenderer.removeListener(IPC.VIRTUAL_DESKTOP_STARTED, handler);
  },

  /** An agent or `komla preview` opened a page, or the workspace's browser, in Komla. */
  onOpenDevPreview: (callback: (event: OpenDevPreviewEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: OpenDevPreviewEvent): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.WORKSPACE_OPEN_DEV_PREVIEW, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_OPEN_DEV_PREVIEW, handler);
  },

  /** An agent ran `komla trash` and its turn ended. */
  onWorkspaceTrashRequested: (callback: (request: WorkspaceTrashRequest) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, request: WorkspaceTrashRequest): void => {
      callback(request);
    };
    ipcRenderer.on(IPC.WORKSPACE_TRASH_REQUESTED, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_TRASH_REQUESTED, handler);
  },

  onPortChanged: (
    callback: (event: { oldPort: number; newPort: number }) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      event: { oldPort: number; newPort: number }
    ): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.SERVER_PORT_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SERVER_PORT_CHANGED, handler);
  },

  onLicenseRevoked: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(IPC.LICENSE_REVOKED, handler);
    return () => ipcRenderer.removeListener(IPC.LICENSE_REVOKED, handler);
  },

  onWorktreeChanged: (
    callback: (
      sessionId: string,
      changeTypes: string[],
      activityAt?: number,
      pushedFileStatus?: {
        files: FileChange[];
        summary: { additions: number; deletions: number; filesChanged: number };
      },
      pushedGitStatus?: GitBranchQuickStatus,
      remoteChange?: RemoteWorkingTreeChange
    ) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      sessionId: string,
      changeTypes?: string[],
      activityAt?: number,
      pushedFileStatus?: {
        files: FileChange[];
        summary: { additions: number; deletions: number; filesChanged: number };
      },
      pushedGitStatus?: GitBranchQuickStatus,
      remoteChange?: RemoteWorkingTreeChange
    ): void => {
      callback(
        sessionId,
        changeTypes ?? ['file'],
        activityAt,
        pushedFileStatus,
        pushedGitStatus,
        remoteChange
      );
    };
    ipcRenderer.on(IPC.GIT_STATUS_WORKTREE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.GIT_STATUS_WORKTREE_CHANGED, handler);
  },

  onGitProgress: (
    callback: (data: {
      operation: 'fetch' | 'push' | 'pull' | 'clone';
      repoPath: string;
      percent: number;
      stage: string;
    }) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: {
        operation: 'fetch' | 'push' | 'pull' | 'clone';
        repoPath: string;
        percent: number;
        stage: string;
      }
    ): void => {
      callback(data);
    };
    ipcRenderer.on(IPC.GIT_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.GIT_PROGRESS, handler);
  },

  // Customization operations
  getTheme: (): Promise<ThemeConfig> => ipcRenderer.invoke(IPC.CUSTOMIZATION_GET_THEME),

  getTerminalConfig: (): Promise<TerminalConfig> =>
    ipcRenderer.invoke(IPC.CUSTOMIZATION_GET_TERMINAL),

  updateTheme: (updates: Partial<ThemeConfig>): Promise<ThemeConfig> =>
    ipcRenderer.invoke(IPC.CUSTOMIZATION_UPDATE_THEME, updates),

  updateTerminalConfig: (updates: Partial<TerminalConfig>): Promise<TerminalConfig> =>
    ipcRenderer.invoke(IPC.CUSTOMIZATION_UPDATE_TERMINAL, updates),

  resetTheme: (): Promise<ThemeConfig> => ipcRenderer.invoke(IPC.CUSTOMIZATION_RESET_THEME),

  onThemeChange: (callback: (theme: ThemeConfig) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, theme: ThemeConfig): void => {
      callback(theme);
    };
    ipcRenderer.on(IPC.CUSTOMIZATION_THEME_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.CUSTOMIZATION_THEME_CHANGED, handler);
  },

  onTerminalConfigChange: (callback: (config: TerminalConfig) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, config: TerminalConfig): void => {
      callback(config);
    };
    ipcRenderer.on(IPC.CUSTOMIZATION_TERMINAL_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.CUSTOMIZATION_TERMINAL_CHANGED, handler);
  },

  // Shortcuts operations
  getShortcuts: (): Promise<ShortcutsConfig> => ipcRenderer.invoke(IPC.SHORTCUTS_GET),

  updateShortcuts: (updates: Partial<ShortcutsConfig>): Promise<ShortcutsConfig> =>
    ipcRenderer.invoke(IPC.SHORTCUTS_UPDATE, updates),

  resetShortcuts: (): Promise<ShortcutsConfig> => ipcRenderer.invoke(IPC.SHORTCUTS_RESET),

  onShortcutsChange: (callback: (config: ShortcutsConfig) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, config: ShortcutsConfig): void => {
      callback(config);
    };
    ipcRenderer.on(IPC.SHORTCUTS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SHORTCUTS_CHANGED, handler);
  },

  // Action operations
  listActions: (): Promise<Action[]> => ipcRenderer.invoke(IPC.ACTION_LIST),

  createAction: (params: {
    title: string;
    content: string;
    type?: 'prompt' | 'command';
    projectIds?: string[];
    presetId?: string;
    launchModeId?: string;
    sshExecutionLocation?: ActionSshExecutionLocation;
    background?: boolean;
  }): Promise<Action> => ipcRenderer.invoke(IPC.ACTION_CREATE, params),

  updateAction: (
    id: string,
    updates: {
      title?: string;
      content?: string;
      type?: 'prompt' | 'command';
      projectIds?: string[];
      presetId?: string | null;
      launchModeId?: string | null;
      sshExecutionLocation?: ActionSshExecutionLocation | null;
      background?: boolean | null;
    }
  ): Promise<Action> => ipcRenderer.invoke(IPC.ACTION_UPDATE, id, updates),

  reorderAction: (id: string, newOrder: number): Promise<void> =>
    ipcRenderer.invoke(IPC.ACTION_REORDER, id, newOrder),

  deleteAction: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ACTION_DELETE, id),

  recordActionUsage: (id: string, userInput?: string, pasted?: boolean): Promise<Action> =>
    ipcRenderer.invoke(IPC.ACTION_RECORD_USAGE, { id, userInput, pasted }),

  onActionsChange: (callback: (actions: Action[]) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, actions: Action[]): void => {
      callback(actions);
    };
    ipcRenderer.on(IPC.ACTIONS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.ACTIONS_CHANGED, handler);
  },

  onHookNotice: (callback: (message: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, message: string): void => callback(message);
    ipcRenderer.on(IPC.HOOK_NOTICE, handler);
    return () => ipcRenderer.removeListener(IPC.HOOK_NOTICE, handler);
  },

  onSettingsFeedback: (callback: (message: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, message: string): void => callback(message);
    ipcRenderer.on(IPC.SETTINGS_FEEDBACK, handler);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_FEEDBACK, handler);
  },

  onSettingsApprovalRequested: (
    callback: (prompt: SettingsApprovalPrompt) => void
  ): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, prompt: SettingsApprovalPrompt): void =>
      callback(prompt);
    ipcRenderer.on(IPC.SETTINGS_APPROVAL_REQUESTED, handler);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_APPROVAL_REQUESTED, handler);
  },

  onSettingsApprovalDismissed: (callback: (id: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, id: string): void => callback(id);
    ipcRenderer.on(IPC.SETTINGS_APPROVAL_DISMISSED, handler);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_APPROVAL_DISMISSED, handler);
  },

  requestPendingSettingsApproval: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SETTINGS_APPROVAL_REQUEST_PENDING),

  resolveSettingsApproval: (id: string, decision: SettingsApprovalDecision): Promise<boolean> =>
    ipcRenderer.invoke(IPC.SETTINGS_APPROVAL_RESOLVE, id, decision),

  listSettingsHistory: (): Promise<SettingsHistoryEntry[]> =>
    ipcRenderer.invoke(IPC.SETTINGS_HISTORY_LIST),

  revertSettingsChange: (id: string): Promise<SettingsHistoryEntry> =>
    ipcRenderer.invoke(IPC.SETTINGS_HISTORY_REVERT, id),

  listStatusItems: (): Promise<WindowStatusItem[]> => ipcRenderer.invoke(IPC.STATUS_ITEMS_LIST),

  onStatusItemsChange: (callback: (items: WindowStatusItem[]) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, items: WindowStatusItem[]): void =>
      callback(items);
    ipcRenderer.on(IPC.STATUS_ITEMS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.STATUS_ITEMS_CHANGED, handler);
  },

  listStatusCommands: (workspaceId: string): Promise<StatusCommandList> =>
    ipcRenderer.invoke(IPC.STATUS_COMMANDS_LIST, workspaceId),

  runStatusCommand: (workspaceId: string, id: string): Promise<StatusCommandResult> =>
    ipcRenderer.invoke(IPC.STATUS_COMMAND_RUN, workspaceId, id),

  runStatusPopover: (
    workspaceId: string,
    id: string,
    theme?: StatusPopoverTheme
  ): Promise<StatusPopoverResult> =>
    ipcRenderer.invoke(IPC.STATUS_POPOVER_RUN, workspaceId, id, theme),

  /** The sandboxed page of an agent item's HTML popover, or null when it has none. */
  statusItemPopoverPage: (
    workspaceId: string,
    id: string,
    theme?: StatusPopoverTheme
  ): Promise<string | null> =>
    ipcRenderer.invoke(IPC.STATUS_ITEM_POPOVER_PAGE, workspaceId, id, theme),

  runStatusButton: (
    workspaceId: string,
    id: string,
    name: string
  ): Promise<StatusButtonRunResult> =>
    ipcRenderer.invoke(IPC.STATUS_BUTTON_RUN, workspaceId, id, name),

  onStatusCommandsChange: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC.STATUS_COMMANDS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.STATUS_COMMANDS_CHANGED, handler);
  },

  /** Runs of status-items.json items that `komla status refresh` asked for. */
  onStatusCommandResult: (callback: (result: StatusCommandResult) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, result: StatusCommandResult): void =>
      callback(result);
    ipcRenderer.on(IPC.STATUS_COMMAND_RESULT, handler);
    return () => ipcRenderer.removeListener(IPC.STATUS_COMMAND_RESULT, handler);
  },

  onSettingsHistoryChange: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC.SETTINGS_HISTORY_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_HISTORY_CHANGED, handler);
  },

  /** `page` is the browser pane the shortcut was pressed in, if any. */
  onPaneCloseShortcut: (callback: (page?: DevPreviewTabRef) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, page?: DevPreviewTabRef): void => callback(page);
    ipcRenderer.on(IPC.SHORTCUT_PANE_CLOSE, handler);
    return () => ipcRenderer.removeListener(IPC.SHORTCUT_PANE_CLOSE, handler);
  },

  onForwardedShortcut: (callback: (actionId: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, actionId: string): void => callback(actionId);
    ipcRenderer.on(IPC.SHORTCUT_FORWARDED, handler);
    return () => ipcRenderer.removeListener(IPC.SHORTCUT_FORWARDED, handler);
  },

  onMenuAddProject: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC.MENU_ADD_PROJECT, handler);
    return () => ipcRenderer.removeListener(IPC.MENU_ADD_PROJECT, handler);
  },

  /** `path` is set for a folder from Open Recent. */
  onMenuOpenFolder: (callback: (path?: string) => void): (() => void) => {
    const handler = (_event: unknown, path?: string): void => callback(path);
    ipcRenderer.on(IPC.MENU_OPEN_FOLDER, handler);
    return () => ipcRenderer.removeListener(IPC.MENU_OPEN_FOLDER, handler);
  },

  onMenuNewWorkspace: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC.MENU_NEW_WORKSPACE, handler);
    return () => ipcRenderer.removeListener(IPC.MENU_NEW_WORKSPACE, handler);
  },

  onMenuOpenSettings: (callback: (tab: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, tab: string): void => callback(tab);
    ipcRenderer.on(IPC.MENU_OPEN_SETTINGS, handler);
    return () => ipcRenderer.removeListener(IPC.MENU_OPEN_SETTINGS, handler);
  },

  onMenuOpenFeedback: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC.MENU_OPEN_FEEDBACK, handler);
    return () => ipcRenderer.removeListener(IPC.MENU_OPEN_FEEDBACK, handler);
  },

  onHoldToQuitHint: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC.HOLD_TO_QUIT_HINT, handler);
    return () => ipcRenderer.removeListener(IPC.HOLD_TO_QUIT_HINT, handler);
  },

  // Settings change listeners for hot-reload
  onProjectsChange: (callback: (projects: Project[]) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, projects: Project[]): void => {
      callback(projects);
    };
    ipcRenderer.on(IPC.PROJECTS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.PROJECTS_CHANGED, handler);
  },

  onCategoriesChange: (callback: (categories: Category[]) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, categories: Category[]): void => {
      callback(categories);
    };
    ipcRenderer.on(IPC.CATEGORIES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.CATEGORIES_CHANGED, handler);
  },

  onAgentPresetsChange: (
    callback: (data: {
      presets: AgentPreset[];
      activePreset: AgentPreset | null;
      activePresets: ActivePresetEntry[];
    }) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: {
        presets: AgentPreset[];
        activePreset: AgentPreset | null;
        activePresets: ActivePresetEntry[];
      }
    ): void => {
      callback(data);
    };
    ipcRenderer.on(IPC.AGENT_PRESETS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.AGENT_PRESETS_CHANGED, handler);
  },

  // License operations
  getLicenseStatus: (): Promise<LicenseStatus> => ipcRenderer.invoke(IPC.LICENSE_GET_STATUS),

  refreshLicenseStatus: (): Promise<LicenseStatus> =>
    ipcRenderer.invoke(IPC.LICENSE_REFRESH_STATUS),

  activateLicense: (key: string): Promise<LicenseStatus | ActivationLimitError> =>
    ipcRenderer.invoke(IPC.LICENSE_ACTIVATE, key),

  deactivateLicense: (): Promise<LicenseStatus> => ipcRenderer.invoke(IPC.LICENSE_DEACTIVATE),

  getWorkspaceQuota: (): Promise<WorkspaceQuota> =>
    ipcRenderer.invoke(IPC.LICENSE_GET_WORKSPACE_QUOTA),

  getActivations: (
    licenseKey: string
  ): Promise<{
    activations: LicenseActivation[];
    activationsUsed: number;
    maxActivations: number;
  }> => ipcRenderer.invoke(IPC.LICENSE_GET_ACTIVATIONS, licenseKey),

  revokeActivation: (
    activationId: string,
    licenseKey: string
  ): Promise<{
    success: boolean;
    activations: LicenseActivation[];
  }> => ipcRenderer.invoke(IPC.LICENSE_REVOKE_ACTIVATION, activationId, licenseKey),

  openBillingPortal: (): Promise<{ url: string } | { error: string }> =>
    ipcRenderer.invoke(IPC.LICENSE_OPEN_BILLING_PORTAL),

  getPlanPrices: (): Promise<PlanPrices | null> => ipcRenderer.invoke(IPC.LICENSE_GET_PRICES),

  // Announcement operations
  getAnnouncements: (): Promise<
    {
      id: string;
      type: 'info' | 'tip' | 'whats-new' | 'warning';
      title: string;
      body: string;
      date: string;
      dismissible?: boolean;
      displayMode: 'banner' | 'dialog' | 'both';
      action?: { label: string; url: string };
    }[]
  > => ipcRenderer.invoke(IPC.ANNOUNCEMENTS_GET),

  dismissAnnouncement: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.ANNOUNCEMENTS_DISMISS, id),

  onAnnouncementsUpdated: (
    callback: (
      announcements: {
        id: string;
        type: 'info' | 'tip' | 'whats-new' | 'warning';
        title: string;
        body: string;
        date: string;
        dismissible?: boolean;
        displayMode: 'banner' | 'dialog' | 'both';
        action?: { label: string; url: string };
      }[]
    ) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      announcements: {
        id: string;
        type: 'info' | 'tip' | 'whats-new' | 'warning';
        title: string;
        body: string;
        date: string;
        dismissible?: boolean;
        displayMode: 'banner' | 'dialog' | 'both';
        action?: { label: string; url: string };
      }[]
    ): void => {
      callback(announcements);
    };
    ipcRenderer.on(IPC.ANNOUNCEMENTS_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC.ANNOUNCEMENTS_UPDATED, handler);
  },

  // System metrics
  getSystemMetrics: (): Promise<{ cpuPercent: number; memoryMB: number }> =>
    ipcRenderer.invoke(IPC.APP_GET_SYSTEM_METRICS),

  /** This computer, or the SSH host with this ID. */
  getResourceUsage: (
    hostId: string | null,
    options?: { prompt?: boolean; maxAgeMs?: number }
  ): Promise<MachineResourceUsage> => ipcRenderer.invoke(IPC.RESOURCE_USAGE_GET, hostId, options),

  // Agent plan usage limits
  getAgentUsage: (): Promise<AgentUsage> => ipcRenderer.invoke(IPC.AGENT_USAGE_GET),
  /** Reads these agents' usage again, each unless that happened in the last minute (force: 10 s). */
  refreshAgentUsage: (options: {
    sources: AgentUsageSource[];
    force?: boolean;
  }): Promise<AgentUsage> => ipcRenderer.invoke(IPC.AGENT_USAGE_REFRESH, options),
  onAgentUsageChange: (callback: (usage: AgentUsage) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, usage: AgentUsage): void => {
      callback(usage);
    };
    ipcRenderer.on(IPC.AGENT_USAGE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.AGENT_USAGE_CHANGED, handler);
  },

  // Update operations
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION),
  getBasePath: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_BASE_PATH),
  getHostResources: (): Promise<{ cpuCount: number; totalMemoryGB: number }> =>
    ipcRenderer.invoke(IPC.APP_GET_HOST_RESOURCES),

  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.APP_INSTALL_UPDATE),

  checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC.APP_CHECK_UPDATES),

  downloadUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.APP_DOWNLOAD_UPDATE),

  syncDevPreview: (
    workspaceId: string,
    tabId: string,
    url: string,
    bounds: DevPreviewBounds
  ): void => ipcRenderer.send(IPC.DEV_PREVIEW_SYNC, workspaceId, tabId, url, bounds),

  hideDevPreview: (workspaceId: string, tabId: string): void =>
    ipcRenderer.send(IPC.DEV_PREVIEW_HIDE, workspaceId, tabId),

  closeDevPreview: (workspaceId: string, tabId: string): void =>
    ipcRenderer.send(IPC.DEV_PREVIEW_CLOSE, workspaceId, tabId),

  reloadDevPreview: (workspaceId: string, tabId: string, ignoreCache = false): Promise<boolean> =>
    ipcRenderer.invoke(IPC.DEV_PREVIEW_RELOAD, workspaceId, tabId, ignoreCache),

  navigateDevPreview: (
    workspaceId: string,
    tabId: string,
    direction: DevPreviewNavigationDirection
  ): Promise<boolean> =>
    ipcRenderer.invoke(IPC.DEV_PREVIEW_NAVIGATE, workspaceId, tabId, direction),

  clearDevPreviewSiteData: (workspaceId: string, tabId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.DEV_PREVIEW_CLEAR_SITE_DATA, workspaceId, tabId),

  captureDevPreview: (workspaceId: string, tabId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.DEV_PREVIEW_CAPTURE, workspaceId, tabId),

  detectDevPreviewServices: (
    workspaceId: string,
    ports: number[],
    remotePorts: number[],
    ownPorts: number[] = []
  ): Promise<DevPreviewServiceDetection> =>
    ipcRenderer.invoke(IPC.DEV_PREVIEW_DETECT_SERVICES, workspaceId, ports, remotePorts, ownPorts),

  getLinkPreview: (request: LinkPreviewRequest): Promise<LinkPreview | null> =>
    ipcRenderer.invoke(IPC.LINK_PREVIEW_GET, request),

  getLinkPreviewImage: (url: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.LINK_PREVIEW_IMAGE, url),

  /** Opens one of the workspace's virtual desktops in the app this computer opens vnc:// links with. */
  openVirtualDesktopInVncApp: (workspaceId: string, vncPort: number): Promise<void> =>
    ipcRenderer.invoke(IPC.VIRTUAL_DESKTOP_OPEN_IN_VNC_APP, workspaceId, vncPort),

  /** Forgets the workspace's virtual desktops on `vncPorts` shown before `checkedAt`, which stopped. */
  forgetVirtualDesktops: (
    workspaceId: string,
    vncPorts: number[],
    checkedAt: number
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.VIRTUAL_DESKTOP_FORGET, workspaceId, vncPorts, checkedAt),

  onDevPreviewFocused: (callback: (page: DevPreviewTabRef) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, page: DevPreviewTabRef): void => callback(page);
    ipcRenderer.on(IPC.DEV_PREVIEW_FOCUSED, handler);
    return () => ipcRenderer.removeListener(IPC.DEV_PREVIEW_FOCUSED, handler);
  },

  onDevPreviewNavigationStateChanged: (
    callback: (state: DevPreviewNavigationState) => void
  ): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: DevPreviewNavigationState): void => {
      callback(state);
    };
    ipcRenderer.on(IPC.DEV_PREVIEW_NAVIGATION_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.DEV_PREVIEW_NAVIGATION_STATE_CHANGED, handler);
  },

  onDevPreviewSnapshotUpdated: (callback: (snapshot: DevPreviewSnapshot) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, snapshot: DevPreviewSnapshot): void => {
      callback(snapshot);
    };
    ipcRenderer.on(IPC.DEV_PREVIEW_SNAPSHOT_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC.DEV_PREVIEW_SNAPSHOT_UPDATED, handler);
  },

  onDevPreviewOpenTab: (callback: (request: DevPreviewOpenTabRequest) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, request: DevPreviewOpenTabRequest): void => {
      callback(request);
    };
    ipcRenderer.on(IPC.DEV_PREVIEW_OPEN_TAB, handler);
    return () => ipcRenderer.removeListener(IPC.DEV_PREVIEW_OPEN_TAB, handler);
  },

  // The macOS menu bar's agents item: its image, drawn here, and its popover page.
  onAgentsMenuBarDraw: (callback: (request: AgentsMenuBarDrawRequest) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, request: AgentsMenuBarDrawRequest): void =>
      callback(request);
    ipcRenderer.on(IPC.AGENTS_MENU_BAR_DRAW, handler);
    return () => ipcRenderer.removeListener(IPC.AGENTS_MENU_BAR_DRAW, handler);
  },

  setAgentsMenuBarImage: (image: AgentsMenuBarImage): void =>
    ipcRenderer.send(IPC.AGENTS_MENU_BAR_IMAGE, image),

  setAgentsMenuBarTheme: (theme: AgentsMenuBarTheme): void =>
    ipcRenderer.send(IPC.AGENTS_MENU_BAR_THEME, theme),

  onAgentsMenuBarState: (callback: (state: AgentsMenuBarState) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: AgentsMenuBarState): void =>
      callback(state);
    ipcRenderer.on(IPC.AGENTS_MENU_BAR_STATE, handler);
    return () => ipcRenderer.removeListener(IPC.AGENTS_MENU_BAR_STATE, handler);
  },

  requestAgentsMenuBarState: (): void => ipcRenderer.send(IPC.AGENTS_MENU_BAR_STATE_REQUEST),

  resizeAgentsMenuBar: (width: number, height: number): void =>
    ipcRenderer.send(IPC.AGENTS_MENU_BAR_RESIZE, width, height),

  openFromAgentsMenuBar: (workspaceId: string, terminalId?: string): void =>
    ipcRenderer.send(IPC.AGENTS_MENU_BAR_OPEN, workspaceId, terminalId),

  closeAgentsMenuBar: (): void => ipcRenderer.send(IPC.AGENTS_MENU_BAR_CLOSE),

  showToastOverlay: (state: ToastOverlayState): void =>
    ipcRenderer.send(IPC.TOAST_OVERLAY_SHOW, state),

  hideToastOverlay: (): void => ipcRenderer.send(IPC.TOAST_OVERLAY_HIDE),

  onToastOverlayEvent: (callback: (event: ToastOverlayEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: ToastOverlayEvent): void => {
      callback(event);
    };
    ipcRenderer.on(IPC.TOAST_OVERLAY_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.TOAST_OVERLAY_EVENT, handler);
  },

  // Used by the toast overlay page (src/renderer/toast-overlay.tsx), not the main window.
  onToastOverlayContent: (callback: (content: ToastOverlayContent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, content: ToastOverlayContent): void => {
      callback(content);
    };
    ipcRenderer.on(IPC.TOAST_OVERLAY_CONTENT, handler);
    return () => ipcRenderer.removeListener(IPC.TOAST_OVERLAY_CONTENT, handler);
  },

  sendToastOverlayEvent: (event: ToastOverlayEvent): void =>
    ipcRenderer.send(IPC.TOAST_OVERLAY_EVENT, event),

  releaseToastOverlayFocus: (): void => ipcRenderer.send(IPC.TOAST_OVERLAY_POINTER_UP),

  onUpdateAvailable: (
    callback: (info: {
      version: string;
      releaseNotes: string | null;
      releaseName: string | null;
      /** Set where Komla can't update itself, so the new version is a download. */
      downloadUrl?: string;
    }) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      info: {
        version: string;
        releaseNotes: string | null;
        releaseName: string | null;
        downloadUrl?: string;
      }
    ): void => {
      callback(info);
    };
    ipcRenderer.on(IPC.APP_UPDATE_AVAILABLE, handler);
    return () => ipcRenderer.removeListener(IPC.APP_UPDATE_AVAILABLE, handler);
  },

  onUpdateNotAvailable: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on(IPC.APP_UPDATE_NOT_AVAILABLE, handler);
    return () => ipcRenderer.removeListener(IPC.APP_UPDATE_NOT_AVAILABLE, handler);
  },

  onUpdateDownloaded: (callback: (version: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, version: string): void => {
      callback(version);
    };
    ipcRenderer.on(IPC.APP_UPDATE_DOWNLOADED, handler);
    return () => ipcRenderer.removeListener(IPC.APP_UPDATE_DOWNLOADED, handler);
  },

  onUpdateError: (callback: (message: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, message: string): void => {
      callback(message);
    };
    ipcRenderer.on(IPC.APP_UPDATE_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.APP_UPDATE_ERROR, handler);
  },

  // Window operations
  createWindow: (): Promise<string> => ipcRenderer.invoke(IPC.WINDOW_CREATE),

  getAllWindowIds: (): Promise<{ id: string; displayNumber: number }[]> =>
    ipcRenderer.invoke(IPC.WINDOW_GET_ALL_IDS),

  moveWorkspaceToWindow: (
    workspaceId: string,
    windowId: string | null,
    layoutData?: unknown
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.WORKSPACE_MOVE_TO_WINDOW, workspaceId, windowId, layoutData),

  focusWorkspaceWindow: (workspaceId: string, terminalId?: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.WORKSPACE_FOCUS_WINDOW, workspaceId, terminalId),

  saveWorkspaceLayouts: (windowId: string, layouts: Record<string, unknown>): void => {
    ipcRenderer.send(IPC.WORKSPACE_SAVE_LAYOUTS_ON_CLOSE, windowId, layouts);
  },
  // Snapshot workspace layouts synchronously so close-time updates are guaranteed delivery.
  saveWorkspaceLayoutsSync: (windowId: string, layouts: Record<string, unknown>): void => {
    ipcRenderer.sendSync(IPC.WORKSPACE_SAVE_LAYOUTS_ON_CLOSE, windowId, layouts);
  },

  /** The files this window has unsaved edits to, which closing it or quitting asks about first. */
  setUnsavedFiles: (names: string[]): void => ipcRenderer.send(IPC.WINDOW_SET_UNSAVED_FILES, names),
  /** The workspace this window shows; null while it shows no single one, as on the overview. */
  setShownWorkspace: (workspaceId: string | null): void =>
    ipcRenderer.send(IPC.WINDOW_SET_SHOWN_WORKSPACE, workspaceId),

  // Window control operations (for Linux custom controls)
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE),

  maximizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_MAXIMIZE),

  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_CLOSE),

  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),

  isWindowFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_FULLSCREEN),

  setTitleBarOverlay: (overlay: { color: string; symbolColor: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.WINDOW_SET_TITLE_BAR_OVERLAY, overlay),

  showMessageBox: (options: {
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
    title?: string;
    message: string;
    detail?: string;
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
  }): Promise<number> => ipcRenderer.invoke(IPC.DIALOG_SHOW_MESSAGE_BOX, options),

  onWindowMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, isMaximized: boolean): void => {
      callback(isMaximized);
    };
    ipcRenderer.on(IPC.WINDOW_MAXIMIZED_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZED_CHANGE, handler);
  },

  onWindowFullscreenChange: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, isFullscreen: boolean): void => {
      callback(isFullscreen);
    };
    ipcRenderer.on(IPC.WINDOW_FULLSCREEN_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC.WINDOW_FULLSCREEN_CHANGE, handler);
  },

  onWorkspaceWindowChanged: (
    callback: (workspaceId: string, windowId: string | null) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      workspaceId: string,
      windowId: string | null
    ): void => {
      callback(workspaceId, windowId);
    };
    ipcRenderer.on(IPC.WORKSPACE_WINDOW_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_WINDOW_CHANGED, handler);
  },

  onWorkspaceSelect: (
    callback: (workspaceId: string, terminalId?: string) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      workspaceId: string,
      terminalId?: string
    ): void => {
      callback(workspaceId, terminalId);
    };
    ipcRenderer.on(IPC.WORKSPACE_SELECT, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_SELECT, handler);
  },

  onWorkspaceMovedHere: (
    callback: (workspaceId: string, layoutData: unknown) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      workspaceId: string,
      layoutData: unknown
    ): void => {
      callback(workspaceId, layoutData);
    };
    ipcRenderer.on(IPC.WORKSPACE_MOVED_HERE, handler);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_MOVED_HERE, handler);
  },

  onWindowListUpdated: (
    callback: (windows: { id: string; displayNumber: number }[]) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      windows: { id: string; displayNumber: number }[]
    ): void => {
      callback(windows);
    };
    ipcRenderer.on(IPC.WINDOW_LIST_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC.WINDOW_LIST_UPDATED, handler);
  },

  notifyRendererReady: (): void => {
    ipcRenderer.send(IPC.WINDOW_RENDERER_READY);
  },

  // Managed repo operations
  fetchProject: (projectId: string): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.MANAGED_REPO_FETCH, projectId),

  pushProject: (
    projectId: string,
    branchName: string
  ): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC.MANAGED_REPO_PUSH, projectId, branchName),

  getProjectRemoteStatus: (
    projectId: string,
    branchName: string
  ): Promise<{ hasRemote: boolean; ahead: number; behind: number; lastFetched: number | null }> =>
    ipcRenderer.invoke(IPC.MANAGED_REPO_GET_REMOTE_STATUS, projectId, branchName),

  // Feedback operations
  selectScreenshots: (): Promise<string[]> => ipcRenderer.invoke(IPC.FEEDBACK_SELECT_SCREENSHOTS),

  sendFeedback: (payload: FeedbackPayload): Promise<FeedbackResult> =>
    ipcRenderer.invoke(IPC.FEEDBACK_SEND, payload),

  // Project sync status operations
  getAllProjectSyncStatuses: (): Promise<
    Array<{
      projectId: string;
      hasRemote: boolean;
      behindRemote: number;
      aheadRemote: number;
      lastFetched: number | null;
      mainBranch: string;
    }>
  > => ipcRenderer.invoke(IPC.PROJECT_SYNC_GET_ALL_STATUSES),

  refreshProjectSyncStatus: (
    projectId: string,
    skipFetch?: boolean
  ): Promise<{
    projectId: string;
    hasRemote: boolean;
    behindRemote: number;
    aheadRemote: number;
    lastFetched: number | null;
    mainBranch: string;
  } | null> => ipcRenderer.invoke(IPC.PROJECT_SYNC_REFRESH, projectId, skipFetch),

  // Askpass operations (SSH passphrase prompting)
  onAskpassRequest: (callback: (data: AskpassRequest) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: AskpassRequest): void => {
      callback(data);
    };
    ipcRenderer.on(IPC.ASKPASS_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC.ASKPASS_REQUEST, handler);
  },

  onAskpassEnded: (callback: (id: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, id: string): void => {
      callback(id);
    };
    ipcRenderer.on(IPC.ASKPASS_ENDED, handler);
    return () => ipcRenderer.removeListener(IPC.ASKPASS_ENDED, handler);
  },

  onAskpassNotRemembered: (callback: (keyPath: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, keyPath: string): void => {
      callback(keyPath);
    };
    ipcRenderer.on(IPC.ASKPASS_NOT_REMEMBERED, handler);
    return () => ipcRenderer.removeListener(IPC.ASKPASS_NOT_REMEMBERED, handler);
  },

  sendAskpassResponse: (id: string, passphrase: string | null, remember?: boolean): void =>
    ipcRenderer.send(IPC.ASKPASS_RESPONSE, { id, passphrase, remember }),

  // Error reporting
  reportError: (error: {
    message: string;
    stack?: string;
    type: string;
    context?: Record<string, unknown>;
  }): Promise<void> => ipcRenderer.invoke(IPC.ERROR_REPORT, error),

  // Data management
  deleteAllWorkspaces: (): Promise<void> => ipcRenderer.invoke(IPC.DATA_DELETE_ALL_WORKSPACES),

  clearLogs: (): Promise<void> => ipcRenderer.invoke(IPC.DATA_CLEAR_LOGS),

  resetApp: (): Promise<void> => ipcRenderer.invoke(IPC.DATA_RESET_APP),

  // Diagnostics (renderer → main, fire-and-forget)
  reportRendererDiagnostics: (stats: {
    terminalCacheSize: number;
    parkedTerminalCount: number;
    activeWebglContexts: number;
    timestamp: number;
  }): void => ipcRenderer.send(IPC.DIAGNOSTICS_RENDERER_STATS, stats),

  isDiagnosticsEnabled: komlaEnv !== 'production',

  // Voice transcription
  voiceGetModelStatus: (): Promise<string> => ipcRenderer.invoke(IPC.VOICE_MODEL_STATUS),

  voiceGetModels: (): Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      sizeMB: number;
      runtimeMemoryMB: string;
      status: string;
      isCurrent: boolean;
    }>
  > => ipcRenderer.invoke(IPC.VOICE_MODELS_LIST),

  voiceSelectModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VOICE_MODEL_SELECT, modelId),

  voiceDownloadModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VOICE_MODEL_DOWNLOAD, modelId),

  voiceCancelModelDownload: (): Promise<void> =>
    ipcRenderer.invoke(IPC.VOICE_MODEL_DOWNLOAD_CANCEL),

  voiceDeleteModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VOICE_MODEL_DELETE, modelId),

  voiceTranscribe: (audioBuffer: Float32Array, requestId?: string): Promise<string> => {
    const samplesBuffer =
      audioBuffer.byteOffset === 0 && audioBuffer.byteLength === audioBuffer.buffer.byteLength
        ? (audioBuffer.buffer as ArrayBuffer)
        : (audioBuffer.buffer.slice(
            audioBuffer.byteOffset,
            audioBuffer.byteOffset + audioBuffer.byteLength
          ) as ArrayBuffer);
    return ipcRenderer.invoke(IPC.VOICE_TRANSCRIBE, { samples: samplesBuffer, requestId });
  },

  voiceCancelTranscription: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VOICE_TRANSCRIBE_CANCEL, requestId),

  voiceWarmup: (): Promise<void> => ipcRenderer.invoke(IPC.VOICE_WARMUP),

  voiceRequestMicAccess: (): Promise<boolean> => ipcRenderer.invoke(IPC.VOICE_REQUEST_MIC_ACCESS),

  voiceSetRecordingState: (active: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.VOICE_RECORDING_STATE, active),

  onVoiceDownloadProgress: (
    callback: (progress: {
      percent: number;
      downloadedMB: number;
      totalMB: number;
      status?: string;
    }) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      progress: { percent: number; downloadedMB: number; totalMB: number; status?: string }
    ): void => {
      callback(progress);
    };
    ipcRenderer.on(IPC.VOICE_MODEL_DOWNLOAD_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.VOICE_MODEL_DOWNLOAD_PROGRESS, handler);
  },

  copyToClipboard: (text: string): void => {
    void ipcRenderer.invoke(IPC.CLIPBOARD_WRITE_TEXT, text);
  },
  readFromClipboard: (): Promise<string> => ipcRenderer.invoke(IPC.CLIPBOARD_READ_TEXT),
  importClipboardImage: (
    workspaceId: string,
    executionLocation?: 'workspace' | 'local-mirror'
  ): Promise<string | null> =>
    ipcRenderer.invoke(IPC.CLIPBOARD_IMPORT_IMAGE, workspaceId, executionLocation),
  /** Saves the clipboard image to a temporary file and returns its path. */
  stageClipboardImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.CLIPBOARD_STAGE_IMAGE),

  // Remote control operations
  remoteControlDisconnectActive: (): Promise<void> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_DISCONNECT_ACTIVE, 'direct'),
  remoteControlDirectStart: (
    options?: RemoteControlDirectStartOptions
  ): Promise<RemoteControlDirectServerInfo> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_DIRECT_START, options),
  remoteControlDirectStop: (): Promise<void> => ipcRenderer.invoke(IPC.REMOTE_CONTROL_DIRECT_STOP),
  remoteControlDirectStartPairing: (
    options?: RemoteControlDirectStartOptions
  ): Promise<RemoteControlDirectPairingOffer> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_DIRECT_START_PAIRING, options),
  remoteControlDirectStartTailscaleServe: (
    options: RemoteControlDirectStartOptions
  ): Promise<RemoteControlDirectTailscaleServeResult> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_DIRECT_START_TAILSCALE_SERVE, options),
  remoteControlDirectGetTailscaleStatus: (): Promise<RemoteControlDirectTailscaleStatus> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_DIRECT_GET_TAILSCALE_STATUS),
  remoteControlDirectCancelPairing: (): Promise<void> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_DIRECT_CANCEL_PAIRING),
  remoteControlDirectGetState: (): Promise<RemoteControlDirectState> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_DIRECT_GET_STATE),
  onRemoteControlDirectStateChanged: (
    callback: (state: RemoteControlDirectState) => void
  ): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, state: RemoteControlDirectState): void => {
      callback(state);
    };
    ipcRenderer.on(IPC.REMOTE_CONTROL_DIRECT_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.REMOTE_CONTROL_DIRECT_STATE_CHANGED, handler);
  },

  // Paired devices registry operations
  pairedDevicesList: (): Promise<PairedDeviceRecord[]> =>
    ipcRenderer.invoke(IPC.PAIRED_DEVICES_LIST),
  remoteControlHostAccessList: (): Promise<RemoteControlHostAccessStatus[]> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_HOST_ACCESS_LIST),
  remoteControlHostAccessSet: (
    hostId: string,
    enabled: boolean
  ): Promise<RemoteControlHostAccessStatus> =>
    ipcRenderer.invoke(IPC.REMOTE_CONTROL_HOST_ACCESS_SET, { hostId, enabled }),
  onRemoteControlHostAccessChanged: (
    callback: (statuses: RemoteControlHostAccessStatus[]) => void
  ): (() => void) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      statuses: RemoteControlHostAccessStatus[]
    ): void => {
      callback(statuses);
    };
    ipcRenderer.on(IPC.REMOTE_CONTROL_HOST_ACCESS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.REMOTE_CONTROL_HOST_ACCESS_CHANGED, handler);
  },
  pairedDevicesRename: (credentialId: string, label: string): Promise<PairedDeviceRecord> =>
    ipcRenderer.invoke(IPC.PAIRED_DEVICES_RENAME, { credentialId, label }),
  pairedDevicesRemove: (credentialId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PAIRED_DEVICES_REMOVE, { credentialId }),
  onPairedDevicesChanged: (callback: (devices: PairedDeviceRecord[]) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, devices: PairedDeviceRecord[]): void => {
      callback(devices);
    };
    ipcRenderer.on(IPC.PAIRED_DEVICES_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.PAIRED_DEVICES_CHANGED, handler);
  },
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('__KOMLA_IS_DEMO__', process.env.IS_DEMO === '1');

declare global {
  interface Window {
    api: ElectronAPI;
    __KOMLA_IS_DEMO__: boolean;
  }
}
