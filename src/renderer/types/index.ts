// Re-export shared types
import type { ActivitySpinnerStyle } from '../../shared/lib/activity-spinner';
import type { DesiredWorkspaceEnvironment } from '../../shared/lib/agent-environment';
import type { RemotePasskeyWindowMinutes } from '../../shared/lib/remote-passkey-window';
import type { WorkspaceGrouping } from '../../shared/lib/workspace-grouping';
import type { WorkspaceTagDefinition } from '../../shared/lib/workspace-tags';
import type { GitDefaults, UtilityProviderId } from '../../shared/types';
import type { CommitGraphRef } from '../../shared/types/commit-graph';

export {
  attentionWakesSnooze,
  komlaSshRemoteDataPort,
  canDeleteWorkspaceBranch,
  canPromptForProjectIcon,
  getWorkspaceCwdIdentity,
  isValidSshBasePath,
  isValidSshHostname,
  normalizeSshBasePath,
  isSshWorkspace,
  isWorkspaceAttentionActionable,
  isWorkspaceSnoozed,
  isWorkspaceCreateError,
  isWorkspaceRestartError,
  isLocalTerminalExecutionLocation,
  needsAttention,
  pickWorkspaceAttention,
  resolveSshWorkspaceMode,
  resolveWorkspaceTargetBranch,
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
  UTILITY_PROVIDER_IDS,
} from '../../shared/types';

export {
  agentsWorkingHere,
  canStop,
  commandsWorkingHere,
  diesOnAppRestart,
  isHiddenByHideStopped,
  isMonitored,
  isRunningHere,
  paneOffer,
  probesOnSelect,
  reconnectableTerminals,
  runningTerminalCount,
  showsRunning,
  showsTerminalRunning,
  showsWorking,
  takesFreeSshSlot,
  type PaneOffer,
} from '../../shared/lib/terminal-execution-state';

export type {
  TerminalStatus,
  TerminalExecutionLocation,
  TerminalLaunchLocation,
  TerminalHostInfo,
  LocalMirrorSyncStatus,
  SshWorkspaceMode,
  Terminal,
  Workspace,
  WorkspaceCreateResult,
  WorkspaceCreateBatchResult,
  WorkspaceRestartResult,
  WorkspaceObservationProjection,
  RemoteWorkingTreeChange,
  RestartTerminalOptions,
  AddAgentTabOptions,
  CreateWorkspaceParams,
  WorkspaceAttention,
  WorkspaceAttentionEvent,
  WorkspaceAttentionKind,
  WorkspaceAttentionSource,
  SetupActivityRun,
  SetupActivityState,
  AgentPreset,
  ActivePresetEntry,
  LaunchMode,
  ReasoningLevel,
  LevelPicker,
  Action,
  ActionType,
  ActionSshExecutionLocation,
  SettingsApprovalPrompt,
  SettingsApprovalDecision,
  SetupStepPlacement,
  SetupDestination,
  SetupTrigger,
  AgentPlacement,
  AheadTargetAction,
  BehindTargetAction,
  GitDefaults,
  SimpleAheadAction,
  SetupStep,
  Project,
  FolderProjectMatch,
  ProjectIconCandidate,
  ProjectIconSource,
  CreateProjectParams,
  CreateProjectFromRemoteParams,
  CreateProjectFromNewParams,
  AppearanceSettings,
  CustomPaletteConfig,
  ThemeConfig,
  TerminalColorConfig,
  TerminalConfig,
  UtilityProviderId,
  UtilityInferenceResult,
  CommitMessageDraft,
  CommitScope,
  CommitScopeResult,
  CommitDraftResult,
  CommitChangesResult,
  UtilityOpenRouterKeyStatus,
  CustomEndpointTestResult,
  SshAgent,
  SshHost,
  SshHostCapabilities,
  SshHostSetupResult,
  SshHostStatus,
  SshIntegrationStatus,
  SshIntegrationType,
  SshIntegrationUpdates,
  SshConfigHost,
  SshForwardedPort,
  SshLinkForward,
  SshPreviewForward,
  SshPreviewScheme,
  SshPortForward,
  SshPortForwardStatus,
  RemoteSshWorkspace,
  SshWorkspaceBackend,
  RemoteControlError,
  RemoteControlDirectPairingOffer,
  RemoteControlDirectServerInfo,
  RemoteControlDirectStartOptions,
  RemoteControlDirectState,
  RemoteControlDirectTailscaleStatus,
  RemoteControlDirectTailscaleServeResult,
  RemoteControlHostAccessStatus,
  PairedDeviceRecord,
} from '../../shared/types';

export type { DesiredWorkspaceEnvironment } from '../../shared/lib/agent-environment';
export { DEFAULT_LAUNCH_MODE_ID } from '../../shared/lib/agent-environment';

// TabRef is now just a terminal ID string
export type TabRef = string;

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
}

export interface AppConfig {
  agentSetupComplete: boolean;
  // Other settings
  scrollbackLines: number;
  theme: 'dark' | 'system';
  defaultProjectId: string | null;
  lastUsedProjectId?: string | null; // Most recently used project for new workspace creation
  notificationsEnabled: boolean;
  notificationPort: number;
  directRemoteEnabled?: boolean;
  directRemotePort?: number;
  directRemotePublicOrigin?: string;
  directRemoteManagedTailscaleOrigin?: string;
  directRemoteKeepAwake?: boolean;
  directRemoteLocalAccess?: boolean;
  directRemotePasskeyWindowMinutes?: RemotePasskeyWindowMinutes;
  utilityProvider: UtilityProviderId;
  openRouterModel: string;
  openRouterBaseUrl: string;
  workspaceNamingPrompt?: string; // A custom endpoint's system prompt for naming workspaces and branches, '' for the default
  commitMessagePrompt?: string; // A custom endpoint's system prompt for commit messages, '' for the default
  defaultFileTreeOpen?: boolean;
  defaultFileTreeMode?: 'diff' | 'browse';
  defaultLiveFollow?: boolean;
  defaultCompareTargetBranch?: boolean; // Auto-compare against target branch in diff mode
  defaultInlinePreviewLayout?: 'full' | 'side-by-side'; // Last user-chosen file preview layout, seeds new workspaces
  defaultDevServerPreviewAutoReload?: boolean; // Initial auto-reload state for browser previews
  webLinkOpenTarget?: 'auto' | 'komla' | 'external'; // Where a click on a terminal link to a web page opens; auto: localhost in Komla, other sites externally
  workspaceGrouping?: WorkspaceGrouping;
  /** Folders opened with Open Folder, newest first. Main keeps it. */
  recentFolders?: string[];
  hideStoppedWorkspaces?: boolean;
  hideWorkingWorkspaces?: boolean; // Working workspaces sit on a sidebar shelf until their agents need the user
  hiddenWorkspaceHostIds?: string[];
  workspaceTags?: WorkspaceTagDefinition[]; // Tags offered for workspaces, such as "Waiting for review"
  hiddenWorkspaceTags?: string[]; // Tags (lowercased) whose workspaces sit on the sidebar's Filtered shelf
  tagsFromPullRequests?: boolean; // Tag pushed worktrees from their GitHub pull requests, read with gh
  workspaceSyncDisabledHostIds?: string[];
  dashboardHiddenWorkspaceHostIds?: string[];
  remoteBranchesExpanded?: boolean;
  diffHideUnchangedRegions?: boolean; // Collapse unchanged regions in diff viewer
  anonymousTelemetryEnabled?: boolean; // Send the anonymous install ping and daily heartbeat (on unless turned off)
  usageTelemetryEnabled?: boolean; // Opt-in: send identified usage analytics to help improve Komla
  usageTelemetryConsentAnswered?: boolean; // User has explicitly chosen on/off for usage analytics
  errorReportingEnabled?: boolean; // Send crash reports to help improve Komla
  shellMode?: 'powershell' | 'wsl'; // Windows only: which shell to use for terminals
  wslDistro?: string; // WSL distro name (e.g. 'Ubuntu'), empty/undefined = default distro
  preferredCloneProtocol?: 'https' | 'ssh'; // Preferred protocol when cloning repos
  autoNameWorkspaces?: 'off' | 'first-prompt'; // Whether AI auto-naming runs from initial prompts
  autoNameBranches?: boolean; // Use AI to generate descriptive branch names from initial prompts
  hideBranchNameInWorkspaceCards?: boolean; // Hide branch names in workspace cards and show them in the tooltip instead
  compactWorkspaceList?: boolean; // Tighter workspace cards in the sidebar
  defaultSearchOpenMode?: 'viewer' | 'preview' | 'current'; // Default target when opening search results ('current' = match the active view)
  hiddenProjectIds?: string[]; // Project IDs hidden from the sidebar workspace list
  dashboardFilterProject?: string | null; // Last selected project filter in dashboard
  defaultEditor?: string; // Editor ID to use for "Open in Editor" (e.g. 'vscode', 'cursor')
  showEditorInToolbar?: boolean; // Show Open in editor in the status bar and title bar; ignored while the status bar is off
  showTipsInToolbar?: boolean; // Show the Tips button in the status bar; Tips moves to the settings menu when off
  showStatusBar?: boolean; // Show the status bar along the bottom of the window
  showAgentsInMenuBar?: boolean; // macOS: show agent activity in the menu bar
  agentsMenuBarInBackgroundOnly?: boolean; // macOS: hide the menu bar item while a Komla window is in front
  agentsDoneClearedAt?: number; // When the agents overview last cleared its finished agents; those that finish later show again
  statusBarHiddenItems?: string[]; // Status bar items the user hid; unlisted items show, so new ones appear by default
  statusBarShownItems?: string[]; // Status bar items that start hidden and the user turned on
  statusBarLeftItems?: string[]; // Status bar items the user placed at the left, in order; unplaced items keep their default spot
  statusBarRightItems?: string[]; // Status bar items the user placed at the right, in order
  keepAwakeMode?: 'off' | 'agents' | 'always'; // Keep the computer from sleeping: never, while an agent works, or always
  zoomLevel?: number; // Electron zoom level in half steps: -3 (58%) to 3 (173%), 0 = default
  agentLaunchDefaultPresetId?: string | null;
  agentLaunchDefaultLaunchModeId?: string | null;
  agentLaunchDefaultSshHostId?: string;
  agentDisabledCapabilities?: string[];
  disableMcpServer?: boolean; // Master kill switch: when true, the HTTP server stops serving /mcp and /workspace
  disableNotificationEndpoint?: boolean; // When true, the HTTP server stops serving /notify
  defaultLaunchModeId?: string; // Default launch mode for new agent tabs (global, last-used)
  vimModeEnabled?: boolean; // Enable vim keybindings in the Monaco file viewer
  windowsUseConptyDll?: boolean; // Windows: spawn terminals with node-pty's bundled conpty.dll instead of the inbox ConPTY; on unless false
  showSystemMetrics?: boolean; // Show live CPU and memory usage in the status bar
  statusBarResourceUsage?:
    | 'komla'
    | 'komla-and-workspaces'
    | 'computer'
    | 'ssh-host'
    | 'ssh-host-workspaces'; // What the status bar's resource usage counts
  statusBarResourceUsageHostId?: string; // The SSH host it counts, for the ssh-host choices
  statusBarUsageLimits?: 'auto' | 'five-hour' | 'weekly' | 'both'; // Which plan limits the agent usage items show
  statusBarUsageResetTime?: boolean; // Show the time until each limit resets in the agent usage items
  showAgentSpinner?: boolean; // Show loading spinner on workspace cards while agent is processing
  activitySpinner?: ActivitySpinnerStyle; // How that spinner looks
  reduceEffects?: boolean; // Hold animations still, drop blur and keep fewer terminals on WebGL
  holdToQuit?: boolean; // macOS and Linux: Cmd+Q / Ctrl+Q quits only after it is held
  onboardingTipsDismissed?: boolean;
  agentLaunchDefaultsShown?: boolean; // True once turning on the Komla skill or MCP showed the Komla CLI launch defaults dialog
  onboardingTipsViewed?: boolean; // True once the user opens the tips popover at least once
  selfIntegrationTipCreated?: boolean; // Show self-integration follow-up tip after unsupported-agent onboarding
  selfIntegrationTipCompleted?: boolean; // True once onboarding launches the self-integration workspace
  notificationsNudgePending?: boolean; // Set by onboarding; cleared once launching a one-click agent without notifications shows the nudge
  selfSetupNudgePending?: boolean; // Set by onboarding; cleared once launching an agent without one-click setup shows the nudge, or a self-integration skill launches
  tipsIntroPending?: boolean; // Set by onboarding; cleared once the pointer at Tips after it is dismissed or Tips first opens
  defaultSshWorkspaceMode?: import('../../shared/lib/ssh-workspace-mode').SshWorkspaceMode;
  gitDefaults?: GitDefaults; // Git settings projects follow while they have none of their own
  gitBackgroundFetch?: boolean; // Fetch origin for projects with workspaces when Komla comes to the front; unset fetches
  pullRequestCiNotifications?: boolean; // Notify a workspace when its pull request's checks finish, while the status bar shows it; unset notifies
  lastWorkspaceEnvironment?: DesiredWorkspaceEnvironment; // Where new workspaces start: last picked or newest added
  voice?: {
    modelId: string;
    modelPath: string | null;
    enabled: boolean;
    autoRecord: boolean;
    transcribeAction: 'fill' | 'launch';
  };
  notificationSounds?: {
    enabled: boolean;
    volume: number; // 0–1
    turnComplete: boolean;
    turnCompleteSound: string;
    inputRequired: boolean;
    inputRequiredSound: string;
  };
}

export interface DirectoryInfo {
  isGit: boolean;
  branch: string | null;
}

export interface PtyData {
  terminalId: string;
  data: string;
}

export interface WorkspaceEvent {
  type: 'status-change' | 'output' | 'error';
  workspaceId: string;
  terminalId?: string;
  payload: unknown;
}

export interface FileChange {
  path: string;
  /** Previous path when Git reports a rename or copy. */
  originalPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
  additions: number;
  deletions: number;
  /** Untracked file status is known, but its line count was not collected. */
  lineCountsUnavailable?: boolean;
  /** True when git reports this as a directory entry (e.g. untracked dirs with -unormal) */
  isDirectory?: boolean;
}

export interface WorktreeDiff {
  files: FileChange[];
  summary: { additions: number; deletions: number; filesChanged: number };
}

export interface FileDiffContent {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  status: FileChange['status'];
  isBinary: boolean;
  isImage?: boolean;
  mimeType?: string;
  oldImageData?: string | null;
  newImageData?: string | null;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  parentHashes: string[];
  refs: CommitGraphRef[];
}

export interface CommitDiff {
  commit: CommitInfo;
  files: FileChange[];
  summary: { additions: number; deletions: number; filesChanged: number };
}

export interface BlameHunk {
  commitHash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  summary: string;
  startLine: number; // 1-based
  lineCount: number;
}

export interface GitBranchQuickStatus {
  behindTargetBranch: number;
  aheadTargetBranch: number;
  mainBranch: string;
  defaultBranch: string;
  /** The branch origin/HEAD names, when the repository records one (local workspaces only). */
  remoteDefaultBranch?: string;
  hasRemote: boolean;
  hasOriginRemote: boolean;
  unpushedCommits: number;
  behindRemote: number;
  currentBranch: string;
  targetBranchHasRemote: boolean;
  targetBranchAheadRemote: number;
  targetBranchBehindRemote: number;
  /** Git stopped mid-rebase (usually on conflicts) and is waiting to continue or abort. */
  rebaseInProgress?: boolean;
}

export interface BranchInfo {
  name: string;
  isRemoteOnly: boolean;
  /** A remote branch's ref with its remote's name, such as `upstream/main`. */
  remoteRef?: string;
}

// Keyboard shortcuts config
export interface ShortcutsConfig {
  shortcuts: Record<string, string>;
  isUSKeyboardLayout?: boolean;
}

// License types
export type LicenseFeature = 'unlimited_workspaces' | 'remote_ssh';

export interface LicenseActivation {
  id: string;
  machineName: string | null;
  platform: string | null;
  lastSeen: string;
  firstActivated?: string;
  isCurrent?: boolean;
}

export type LicenseType = 'monthly' | 'yearly' | 'lifetime';

export interface LicenseStatus {
  isLicensed: boolean;
  licenseKey: string | null;
  customerEmail: string | null;
  activatedAt: number | null;
  features: Record<LicenseFeature, boolean>;
  activationsUsed?: number;
  maxActivations?: number;
  licenseType?: LicenseType | null;
  validUntil?: string | null;
  cancelAtPeriodEnd?: boolean;
}

export interface ActivationLimitError {
  error: 'activation_limit_reached';
  activations: LicenseActivation[];
  activationsUsed: number;
  maxActivations: number;
}

/** Prices in minor units in one currency; lifetime is null once its early-access price has ended. */
export interface PlanPrices {
  currency: 'usd' | 'eur';
  monthly: number;
  yearly: number;
  lifetime: number | null;
}

export interface WorkspaceQuota {
  allowed: boolean;
  count: number;
  limit: number;
  isLicensed: boolean;
}

export type { McpStatus } from '../../shared/types/mcp-status';
export type { KomlaSkillStatus } from '../../shared/types/komla-skill';

// Feedback types
export type FeedbackType = 'bug' | 'feature' | 'general';

export interface FeedbackPayload {
  type: FeedbackType;
  description: string;
  email?: string;
  screenshotPaths?: string[];
}

export interface FeedbackResult {
  success: boolean;
  error?: string;
}

// Content search types
export interface ContentSearchMatch {
  start: number;
  end: number;
}

export interface ContentSearchResult {
  path: string;
  lineNumber: number;
  lineContent: string;
  matches: ContentSearchMatch[];
}

export interface ContentSearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  maxResults?: number;
  maxFileSize?: string;
}

// Re-export layout types
export * from './layout';
