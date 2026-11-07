/**
 * Shared types used by both main and renderer processes.
 * This eliminates type duplication across the codebase.
 */

// Terminal types
export type {
  TerminalStatus,
  TerminalExecutionLocation,
  TerminalLaunchLocation,
  TerminalHostInfo,
  Terminal,
} from './terminal';
export { isLocalTerminalExecutionLocation } from './terminal';
export type { LocalCopySyncStatus } from './local-copy';
export type { SshWorkspaceMode } from '../lib/ssh-workspace-mode';
export { resolveSshWorkspaceMode } from '../lib/ssh-workspace-mode';

// Workspace types
export type {
  Workspace,
  CreateWorkspaceParams,
  WorkspaceCreateError,
  WorkspaceCreateResult,
  WorkspaceCreateBatchResult,
  WorkspaceAttention,
  WorkspaceAttentionEvent,
  WorkspaceAttentionKind,
  WorkspaceAttentionSource,
  WorkspacePromptSubmit,
  WorkspaceUnread,
  WorkspaceCustomNameSource,
  WorkspaceStatus,
  WorkspaceBrowserPane,
  WorkspaceBrowserTab,
  WorkspaceRecentLink,
  WorkspaceLayoutNode,
  WorkspaceLayoutPane,
  WorkspaceSavedLayout,
  WorkspaceSetupPane,
  WorkspaceVirtualDesktop,
  RestartTerminalOptions,
  AddAgentTabOptions,
  WorkspaceBackend,
  WorkspaceGitStatusSnapshot,
  SetupActivityRun,
  SetupActivityState,
  SshWorkspaceBackend,
  LocalWorkspaceBackend,
} from './workspace';
export {
  COMMAND_ATTENTION_SOURCE,
  DUPLICATE_WORKSPACE_ERROR_PREFIX,
  attentionOutranks,
  attentionWakesSnooze,
  getWorkspaceCwdIdentity,
  canDeleteWorkspaceBranch,
  canPromptForProjectIcon,
  isSshWorkspace,
  hasWorkspaceFiles,
  isWorkspaceAttentionActionable,
  isWorkspaceSnoozed,
  isWorkspaceCreateError,
  needsAttention,
  pickWorkspaceAttention,
  resolveWorkspaceTargetBranch,
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
} from './workspace';

export type {
  BranchStatus,
  RemoteWorkingTreeChange,
  RepositorySnapshotObservation,
  WorkingTreeSnapshot,
  WorkspaceObservationAcceptance,
  WorkspaceObservationBatch,
  WorkspaceObservationBatchAcceptance,
  WorkspaceObservationConfirmation,
  WorkspaceObservationCursor,
  WorkspaceObservationProjection,
} from './workspace-observation';

// Project types
export type {
  SetupStepPlacement,
  SetupStepKind,
  SetupStepPane,
  SetupDestination,
  SetupTrigger,
  AgentPlacement,
  SimpleAheadAction,
  AheadTargetAction,
  BehindTargetAction,
  GitDefaults,
  ProjectKind,
  SetupStep,
  Project,
  FolderTrustAgent,
  FolderProjectMatch,
  ProjectIconCandidate,
  ProjectIconSource,
  LeftoverBranch,
  LeftoverBranches,
  BranchDeletionResult,
  WorktreeCleanupCheck,
  WorkspaceCleanupStatus,
  CreateProjectParams,
  CreateProjectFromRemoteParams,
  CreateProjectFromNewParams,
} from './project';
export {
  SETUP_DESTINATIONS,
  SETUP_STEP_KINDS,
  SETUP_STEP_PLACEMENTS,
  SETUP_TRIGGERS,
} from './project';

// Agent preset types
export type {
  AgentPreset,
  LaunchMode,
  ReasoningLevel,
  ModelOption,
  LevelPicker,
  LevelPickerIcon,
  ActivePresetEntry,
} from './agent-preset';

// Action types
export type { Action, ActionType, ActionSshExecutionLocation } from './action';
export { ACTION_SSH_EXECUTION_LOCATIONS } from './action';

// Confirmed settings approval types
export type {
  SettingsApprovalOperation,
  SettingsApprovalChangeKind,
  SettingsApprovalDetail,
  SettingsApprovalChange,
  SettingsApprovalPrompt,
  SettingsApprovalDecision,
  SettingsFileResource,
} from './settings-approval';
export { SETTINGS_FILE_RESOURCES } from './settings-approval';

// SSH remote workspace types
export type {
  AskpassRequest,
  RemoteAgentIntegrationStatus,
  SshAgent,
  SshHost,
  SshHostCapabilities,
  SshHostSetupResult,
  SshHostStatus,
  SshIntegrationStatus,
  SshIntegrationType,
  SshIntegrationUpdates,
  SshForwardedPort,
  SshLinkForward,
  SshPreviewForward,
  SshPreviewScheme,
  SshConfigHost,
  SshPortForward,
  SshPortForwardStatus,
} from './ssh';
export {
  komlaSshRemoteDataPort,
  SSH_KOMLA_FOLDER,
  isSshKomlaFolder,
  isValidSshHostname,
} from './ssh';
export type { RemoteSshWorkspace, SshWorkspaceManifest } from './ssh-workspace-manifest';

// Customization types
export type {
  AppearanceSettings,
  CustomPaletteConfig,
  ThemeConfig,
  TerminalColorConfig,
  TerminalConfig,
} from './customization';

// Utility inference types
export { UTILITY_PROVIDER_IDS } from './utility-inference';
export type {
  CustomEndpointTestResult,
  UtilityProviderId,
  UtilityInferenceResult,
  CommitMessageDraft,
  CommitScope,
  CommitScopeResult,
  CommitDraftResult,
  CommitChangesResult,
  UtilityOpenRouterKeyStatus,
} from './utility-inference';

// Remote control types
export type {
  RemoteControlError,
  RemoteControlDirectPairingOffer,
  RemoteControlDirectServerInfo,
  RemoteControlDirectStartOptions,
  RemoteControlDirectState,
  RemoteControlDirectTailscaleStatus,
  RemoteControlDirectTailscaleServeResult,
  RemoteControlHostAccessStatus,
  RemoteControlHostEndpoint,
} from './remote-control';

// Paired device types
export type { PairedDeviceRecord } from './paired-device';

// Native dev-server preview types
export type {
  DevPreviewBounds,
  DevPreviewNavigationDirection,
  DevPreviewNavigationState,
  DevPreviewOpenTabRequest,
  DevPreviewOtherServer,
  DevPreviewService,
  DevPreviewServiceDetection,
  DevPreviewSnapshot,
  DevPreviewTabRef,
  LinkPreview,
  LinkPreviewRequest,
} from './dev-preview';
export { VIRTUAL_DESKTOP_VIEWERS } from './dev-preview';

// The macOS menu bar's agents item
export { AGENTS_MENU_BAR_CARD, AGENTS_MENU_BAR_IMAGE_MAX_DATA_URL_LENGTH } from './agents-menu-bar';
export type {
  AgentsMenuBarCounts,
  AgentsMenuBarDrawRequest,
  AgentsMenuBarImage,
  AgentsMenuBarProject,
  AgentsMenuBarState,
  AgentsMenuBarTheme,
} from './agents-menu-bar';

// Toast layer drawn above native browser previews
export { TOAST_OVERLAY_MESSAGE_MAX_LENGTH } from './toast-overlay';
export type {
  ToastOverlayContent,
  ToastOverlayEvent,
  ToastOverlayState,
  ToastOverlayToast,
} from './toast-overlay';
