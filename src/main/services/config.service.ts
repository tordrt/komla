import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { MAX_UTILITY_PROMPT_CHARS } from '../../shared/constants/utility-prompts';
import {
  ACTIVITY_SPINNER_STYLES,
  DEFAULT_ACTIVITY_SPINNER,
} from '../../shared/lib/activity-spinner';
import {
  DEFAULT_REMOTE_PASSKEY_WINDOW_MINUTES,
  normalizeRemotePasskeyWindow,
} from '../../shared/lib/remote-passkey-window';
import { DEFAULT_STATUS_BAR_SIZE, STATUS_BAR_SIZES } from '../../shared/lib/status-bar-size';
import {
  DEFAULT_HIDDEN_WORKSPACE_TAGS,
  normalizeWorkspaceTags,
} from '../../shared/lib/workspace-tags';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { migrate } from '../lib/migration';

import { ensureKomlaBasePath, getKomlaBasePath } from './paths';

import type { ActivitySpinnerStyle } from '../../shared/lib/activity-spinner';
import type { DesiredWorkspaceEnvironment } from '../../shared/lib/agent-environment';
import type { RemotePasskeyWindowMinutes } from '../../shared/lib/remote-passkey-window';
import type { SshWorkspaceMode } from '../../shared/lib/ssh-workspace-mode';
import type { StatusBarSize } from '../../shared/lib/status-bar-size';
import type { WorkspaceGrouping } from '../../shared/lib/workspace-grouping';
import type { WorkspaceTagDefinition } from '../../shared/lib/workspace-tags';
import type { GitDefaults, UtilityProviderId } from '../../shared/types';

const CONFIG_VERSION = 1;
const CONFIG_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

/** A stored workspace environment, dropping the removed Lima sandbox kind. */
function workspaceEnvironment(value: unknown): DesiredWorkspaceEnvironment | undefined {
  const kind = (value as { kind?: unknown } | null | undefined)?.kind;
  return kind === 'local' || kind === 'ssh' ? (value as DesiredWorkspaceEnvironment) : undefined;
}

/**
 * Whether agent launches were placed in a Lima sandbox, which is gone. An SSH
 * host took precedence over it, so a pin with one stays where it was.
 */
function pinnedForRemovedSandbox(raw: Record<string, unknown>): boolean {
  return !!raw.agentLaunchDefaultSandboxMethodId && !raw.agentLaunchDefaultSshHostId;
}

/** The strings in a stored list, or undefined when it isn't a list. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

/** A stored choice, or off for someone who hid branch names with the setting this replaced. */
function alwaysShowBranchName(raw: Record<string, unknown>): boolean {
  const stored = raw.alwaysShowBranchNameInWorkspaceCards;
  return typeof stored === 'boolean' ? stored : raw.hideBranchNameInWorkspaceCards !== true;
}

function normalizeUtilityProvider(value: unknown): UtilityProviderId {
  if (value === 'komla-managed' || value === 'custom') return value;
  return DEFAULT_CONFIG.utilityProvider;
}

export type AutoNameWorkspacesMode = 'off' | 'first-prompt';

function normalizeAutoNameWorkspaces(value: unknown): AutoNameWorkspacesMode {
  if (value === 'off' || value === 'first-prompt') return value;
  return DEFAULT_CONFIG.autoNameWorkspaces ?? 'first-prompt';
}

type KeepAwakeMode = NonNullable<AppConfig['keepAwakeMode']>;
const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['off', 'agents', 'always'];

// A hand-edited config, or one from a newer version, may hold a mode this one doesn't know.
function normalizeKeepAwakeMode(value: unknown): KeepAwakeMode | undefined {
  return KEEP_AWAKE_MODES.find((mode) => mode === value);
}

const AHEAD_ACTIONS = ['pr', 'merge', 'agent-prompt', 'disabled'] as const;
const BEHIND_ACTIONS = ['auto', 'rebase', 'merge'] as const;

function normalizeGitDefaults(value: unknown): GitDefaults | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const aheadMainAction = AHEAD_ACTIONS.find((action) => action === raw.aheadMainAction);
  const aheadOtherAction = AHEAD_ACTIONS.find((action) => action === raw.aheadOtherAction);
  // A quick command choice keeps the id of the command it runs.
  const actionId = (action: string | undefined, id: unknown) =>
    action === 'agent-prompt' && typeof id === 'string' && id ? id : undefined;
  const aheadMainActionId = actionId(aheadMainAction, raw.aheadMainActionId);
  const aheadOtherActionId = actionId(aheadOtherAction, raw.aheadOtherActionId);
  const behindTargetAction = BEHIND_ACTIONS.find((action) => action === raw.behindTargetAction);
  return {
    ...(typeof raw.branchPrefix === 'string' && raw.branchPrefix
      ? { branchPrefix: raw.branchPrefix }
      : {}),
    // The two ↑N choices are set together, or neither is and projects ask on first click.
    ...(aheadMainAction && aheadOtherAction
      ? {
          aheadMainAction,
          aheadOtherAction,
          ...(aheadMainActionId ? { aheadMainActionId } : {}),
          ...(aheadOtherActionId ? { aheadOtherActionId } : {}),
        }
      : {}),
    ...(typeof raw.autoPushAfterMerge === 'boolean'
      ? { autoPushAfterMerge: raw.autoPushAfterMerge }
      : {}),
    ...(behindTargetAction ? { behindTargetAction } : {}),
  };
}

type StatusBarResourceUsage = NonNullable<AppConfig['statusBarResourceUsage']>;
const STATUS_BAR_RESOURCE_USAGES: readonly StatusBarResourceUsage[] = [
  'komla',
  'komla-and-workspaces',
  'computer',
  'ssh-host',
  'ssh-host-workspaces',
];

function normalizeStatusBarResourceUsage(value: unknown): StatusBarResourceUsage | undefined {
  return STATUS_BAR_RESOURCE_USAGES.find((usage) => usage === value);
}

type StatusBarUsageLimits = NonNullable<AppConfig['statusBarUsageLimits']>;
const STATUS_BAR_USAGE_LIMITS: readonly StatusBarUsageLimits[] = [
  'auto',
  'five-hour',
  'weekly',
  'both',
];

type WebLinkOpenTarget = NonNullable<AppConfig['webLinkOpenTarget']>;
const WEB_LINK_OPEN_TARGETS: readonly WebLinkOpenTarget[] = ['auto', 'komla', 'external'];

function normalizeWebLinkOpenTarget(value: unknown): WebLinkOpenTarget {
  return WEB_LINK_OPEN_TARGETS.find((target) => target === value) ?? 'external';
}

// Saved configs keep the default model they were written with. This one is
// gone from OpenRouter, so it moves to the current default.
const RETIRED_DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash-lite-preview-09-2025';

function normalizeOpenRouterModel(value: unknown): string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim() !== RETIRED_DEFAULT_OPENROUTER_MODEL
    ? value.trim()
    : DEFAULT_CONFIG.openRouterModel;
}

function normalizeOpenRouterBaseUrl(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : DEFAULT_CONFIG.openRouterBaseUrl;
}

/** A saved utility prompt, or '' for Komla's default. */
function normalizeUtilityPrompt(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_UTILITY_PROMPT_CHARS) : '';
}

// Read `key` from raw, falling back to DEFAULT_CONFIG when missing/null. Keeps
// the load() body flat so the cyclomatic complexity rule doesn't trip on each
// `??` site individually.
function pickWithDefault<K extends keyof AppConfig>(
  raw: Record<string, unknown>,
  key: K
): AppConfig[K] {
  const value = raw[key as string];
  return (value ?? DEFAULT_CONFIG[key]) as AppConfig[K];
}

function normalizeVoice(
  raw: Partial<NonNullable<AppConfig['voice']>> | undefined
): NonNullable<AppConfig['voice']> {
  const defaults = DEFAULT_CONFIG.voice!;
  return {
    modelId: raw?.modelId ?? defaults.modelId,
    modelPath: raw?.modelPath ?? defaults.modelPath,
    enabled: raw?.enabled ?? defaults.enabled,
    autoRecord: raw?.autoRecord ?? defaults.autoRecord,
    transcribeAction: raw?.transcribeAction ?? defaults.transcribeAction,
  };
}

function normalizeNotificationSounds(
  raw: Partial<NonNullable<AppConfig['notificationSounds']>> | undefined
): NonNullable<AppConfig['notificationSounds']> {
  const defaults = DEFAULT_CONFIG.notificationSounds!;
  return {
    enabled: raw?.enabled ?? defaults.enabled,
    volume: raw?.volume ?? defaults.volume,
    turnComplete: raw?.turnComplete ?? defaults.turnComplete,
    turnCompleteSound: raw?.turnCompleteSound ?? defaults.turnCompleteSound,
    inputRequired: raw?.inputRequired ?? defaults.inputRequired,
    inputRequiredSound: raw?.inputRequiredSound ?? defaults.inputRequiredSound,
  };
}

export interface AppConfig {
  _version?: number;
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
  /** Off: paired devices reach only SSH workspaces, never this computer's own terminals. */
  directRemoteLocalAccess?: boolean;
  /** Settings → Remote → "Ask for passkey again after". */
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
  /** Folders opened with Open Folder, newest first, for Open Recent and the empty window. */
  recentFolders?: string[];
  hideStoppedWorkspaces?: boolean;
  hideWorkingWorkspaces?: boolean; // Working workspaces sit on a sidebar shelf until their agents need the user
  hiddenWorkspaceHostIds?: string[];
  workspaceTags?: WorkspaceTagDefinition[]; // Tags offered for workspaces, such as "Waiting for review"
  hiddenWorkspaceTags?: string[]; // Tags (lowercased) whose workspaces sit on the sidebar's Filtered shelf
  tagsFromPullRequests?: boolean; // Tag pushed worktrees from their GitHub pull requests, read with gh
  dashboardHiddenWorkspaceHostIds?: string[];
  telemetryPingSent?: boolean;
  lastHeartbeatDate?: string; // YYYY-MM-DD date string for daily heartbeat dedup
  telemetryDistinctId?: string; // Anonymous random ID for app telemetry uniqueness
  workspaceSyncDeviceId?: string; // Random ID this installation records in the SSH workspace manifests it writes
  workspaceSyncDisabledHostIds?: string[]; // SSH hosts whose workspaces aren't synced with other devices
  anonymousTelemetryEnabled?: boolean; // Send the anonymous install ping and daily heartbeat (on unless turned off)
  usageTelemetryEnabled?: boolean; // Opt-in: send identified usage analytics to help improve Komla
  usageTelemetryConsentAnswered?: boolean; // User has explicitly chosen on/off for usage analytics
  reportedTelemetryMilestones?: string[]; // Integration milestones already reported (once-ever dedup)
  errorReportingEnabled?: boolean; // Send crash reports to help improve Komla
  dismissedAnnouncementIds?: string[];
  zoomLevel?: number; // Electron zoom level in half steps: -3 (58%) to 3 (173%), 0 = default
  shellMode?: 'powershell' | 'wsl'; // Windows only: which shell to use for terminals
  wslDistro?: string; // WSL distro name (e.g. 'Ubuntu'), empty/undefined = default distro
  preferredCloneProtocol?: 'https' | 'ssh'; // Preferred protocol when cloning repos
  autoNameWorkspaces?: AutoNameWorkspacesMode; // When to use AI to generate workspace names from prompts
  autoNameBranches?: boolean; // Use AI to generate descriptive branch names from initial prompts
  alwaysShowBranchNameInWorkspaceCards?: boolean; // Off: a card shows its branch only when its activity row has room
  compactWorkspaceList?: boolean; // Tighter workspace cards in the sidebar
  defaultSearchOpenMode?: 'viewer' | 'preview' | 'current'; // Default target when opening search results ('current' = match the active view)
  hiddenProjectIds?: string[]; // Project IDs hidden from the sidebar workspace list
  dashboardFilterProject?: string | null; // Last selected project filter in dashboard
  remoteBranchesExpanded?: boolean; // Branch pickers list remote branches too
  diffHideUnchangedRegions?: boolean; // Collapse unchanged regions in diff viewer
  defaultEditor?: string; // Editor ID to use for "Open in Editor" (e.g. 'vscode', 'cursor')
  showEditorInToolbar?: boolean; // Show Open in editor in the status bar and title bar; ignored while the status bar is off
  showTipsInToolbar?: boolean; // Show the Tips button in the status bar; Tips moves to the settings menu when off
  showStatusBar?: boolean; // Show the status bar along the bottom of the window
  statusBarSize?: StatusBarSize; // How tall the status bar is
  showAgentsInMenuBar?: boolean; // macOS: show agent activity in the menu bar
  agentsMenuBarInBackgroundOnly?: boolean; // macOS: hide the menu bar item while a Komla window is in front
  agentsDoneClearedAt?: number; // When the agents overview last cleared its finished agents; those that finish later show again
  statusBarHiddenItems?: string[]; // Status bar items the user hid; unlisted items show, so new ones appear by default
  statusBarShownItems?: string[]; // Status bar items that start hidden and the user turned on
  statusBarLeftItems?: string[]; // Status bar items the user placed at the left, in order; unplaced items keep their default spot
  statusBarRightItems?: string[]; // Status bar items the user placed at the right, in order
  keepAwakeMode?: 'off' | 'agents' | 'always'; // Keep the computer from sleeping: never, while an agent works, or always
  agentLaunchDefaultPresetId?: string | null; // Default preset for agent-launched workspaces and tabs
  agentLaunchDefaultLaunchModeId?: string | null; // Default launch mode for agent-launched workspaces and tabs
  agentLaunchDefaultSshHostId?: string; // SSH host for agent-launched workspaces
  agentDisabledCapabilities?: string[]; // Default-on agent capabilities the user disabled
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
  aiHelpersOffDismissed?: boolean; // User dismissed the notice that a build has no managed AI helpers
  lastWorkspaceEnvironment?: DesiredWorkspaceEnvironment; // Where new workspaces start: last picked or newest added
  defaultSshWorkspaceMode?: SshWorkspaceMode;
  gitDefaults?: GitDefaults; // Git settings projects follow while they have none of their own
  gitBackgroundFetch?: boolean; // Fetch origin for projects with workspaces when Komla comes to the front; unset fetches
  pullRequestCiNotifications?: boolean; // Notify a workspace when its pull request's checks finish, while the status bar shows it; unset notifies
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

export interface UtilityInferenceConfig {
  provider: AppConfig['utilityProvider'];
  openRouterModel: AppConfig['openRouterModel'];
  openRouterBaseUrl: AppConfig['openRouterBaseUrl'];
  workspaceNamingPrompt: string;
  commitMessagePrompt: string;
}

const DEFAULT_CONFIG: AppConfig = {
  agentSetupComplete: false,
  scrollbackLines: 10000,
  theme: 'system',
  defaultProjectId: null,
  notificationsEnabled: false,
  notificationPort: 53724,
  directRemoteEnabled: false,
  directRemotePort: 52864,
  directRemoteKeepAwake: false,
  directRemoteLocalAccess: true,
  directRemotePasskeyWindowMinutes: DEFAULT_REMOTE_PASSKEY_WINDOW_MINUTES,
  utilityProvider: 'komla-managed',
  openRouterModel: 'anthropic/claude-haiku-5.5',
  openRouterBaseUrl: 'https://openrouter.ai/api/v1',
  defaultFileTreeOpen: false,
  defaultFileTreeMode: 'diff',
  defaultLiveFollow: false,
  defaultCompareTargetBranch: false,
  defaultDevServerPreviewAutoReload: true,
  webLinkOpenTarget: 'external',
  workspaceGrouping: 'project',
  recentFolders: [],
  hideStoppedWorkspaces: false,
  hideWorkingWorkspaces: false,
  hiddenWorkspaceHostIds: [],
  hiddenWorkspaceTags: [...DEFAULT_HIDDEN_WORKSPACE_TAGS],
  tagsFromPullRequests: false,
  dashboardHiddenWorkspaceHostIds: [],
  telemetryPingSent: false,
  lastHeartbeatDate: undefined,
  telemetryDistinctId: undefined,
  workspaceSyncDeviceId: undefined,
  workspaceSyncDisabledHostIds: [],
  anonymousTelemetryEnabled: true,
  usageTelemetryEnabled: false,
  usageTelemetryConsentAnswered: false,
  reportedTelemetryMilestones: [],
  errorReportingEnabled: true,
  dismissedAnnouncementIds: [],
  zoomLevel: 0,
  autoNameWorkspaces: 'first-prompt',
  autoNameBranches: false,
  alwaysShowBranchNameInWorkspaceCards: true,
  compactWorkspaceList: false,
  defaultSearchOpenMode: 'current',
  hiddenProjectIds: [],
  showSystemMetrics: false,
  statusBarUsageResetTime: true,
  showAgentSpinner: true,
  showAgentsInMenuBar: true,
  agentsMenuBarInBackgroundOnly: true,
  activitySpinner: DEFAULT_ACTIVITY_SPINNER,
  reduceEffects: false,
  holdToQuit: false,
  selfIntegrationTipCreated: false,
  selfIntegrationTipCompleted: false,
  notificationsNudgePending: false,
  selfSetupNudgePending: false,
  tipsIntroPending: false,
  aiHelpersOffDismissed: false,
  agentDisabledCapabilities: [],
  defaultSshWorkspaceMode: 'remote',
  voice: {
    modelId: 'parakeet-tdt-0.6b-v3-int8',
    modelPath: null,
    enabled: false,
    autoRecord: false,
    transcribeAction: 'fill',
  },
  notificationSounds: {
    enabled: true,
    volume: 0.5,
    turnComplete: true,
    turnCompleteSound: 'marimba',
    inputRequired: true,
    inputRequiredSound: 'bell',
  },
};

/**
 * Every key the config holds, so a key `normalizeConfig` leaves out fails to
 * compile instead of being dropped by each update.
 */
type NormalizedConfig = { [K in keyof Required<Omit<AppConfig, '_version'>>]: AppConfig[K] };

/**
 * The config a raw record holds: what load reads from disk and what update
 * keeps, so a value Komla holds in memory is the one a restart reads back.
 */
function normalizeConfig(rawConfig: Record<string, unknown>): NormalizedConfig {
  // Narrow nested records so downstream access is typed. Missing fields
  // fall back to defaults via `??`; wrong-typed values flow through
  // unchanged (no runtime schema validation here).
  const rawVoice = rawConfig.voice as Partial<NonNullable<AppConfig['voice']>> | undefined;
  const rawSounds = rawConfig.notificationSounds as
    | Partial<NonNullable<AppConfig['notificationSounds']>>
    | undefined;

  return {
    agentSetupComplete: pickWithDefault(rawConfig, 'agentSetupComplete'),
    scrollbackLines: pickWithDefault(rawConfig, 'scrollbackLines'),
    // `||` (not `??`) so an empty-string theme also falls back.
    theme: (rawConfig.theme as AppConfig['theme']) || DEFAULT_CONFIG.theme,
    defaultProjectId: pickWithDefault(rawConfig, 'defaultProjectId'),
    // DEFAULT_CONFIG omits this key, so pickWithDefault would yield
    // undefined; preserve the historical `?? null` here.
    lastUsedProjectId: (rawConfig.lastUsedProjectId as string | null | undefined) ?? null,
    notificationsEnabled: pickWithDefault(rawConfig, 'notificationsEnabled'),
    notificationPort: pickWithDefault(rawConfig, 'notificationPort'),
    directRemoteEnabled: pickWithDefault(rawConfig, 'directRemoteEnabled'),
    directRemotePort: pickWithDefault(rawConfig, 'directRemotePort'),
    directRemotePublicOrigin: pickWithDefault(rawConfig, 'directRemotePublicOrigin'),
    directRemoteManagedTailscaleOrigin: pickWithDefault(
      rawConfig,
      'directRemoteManagedTailscaleOrigin'
    ),
    directRemoteKeepAwake: pickWithDefault(rawConfig, 'directRemoteKeepAwake'),
    directRemoteLocalAccess: pickWithDefault(rawConfig, 'directRemoteLocalAccess'),
    directRemotePasskeyWindowMinutes: normalizeRemotePasskeyWindow(
      rawConfig.directRemotePasskeyWindowMinutes
    ),
    utilityProvider: normalizeUtilityProvider(rawConfig.utilityProvider),
    openRouterModel: normalizeOpenRouterModel(rawConfig.openRouterModel),
    openRouterBaseUrl: normalizeOpenRouterBaseUrl(rawConfig.openRouterBaseUrl),
    workspaceNamingPrompt: normalizeUtilityPrompt(rawConfig.workspaceNamingPrompt),
    commitMessagePrompt: normalizeUtilityPrompt(rawConfig.commitMessagePrompt),
    defaultFileTreeOpen: pickWithDefault(rawConfig, 'defaultFileTreeOpen'),
    defaultFileTreeMode: pickWithDefault(rawConfig, 'defaultFileTreeMode'),
    defaultLiveFollow: pickWithDefault(rawConfig, 'defaultLiveFollow'),
    defaultCompareTargetBranch: pickWithDefault(rawConfig, 'defaultCompareTargetBranch'),
    defaultDevServerPreviewAutoReload: pickWithDefault(
      rawConfig,
      'defaultDevServerPreviewAutoReload'
    ),
    defaultInlinePreviewLayout:
      rawConfig.defaultInlinePreviewLayout === 'side-by-side' ||
      rawConfig.defaultInlinePreviewLayout === 'full'
        ? rawConfig.defaultInlinePreviewLayout
        : undefined,
    webLinkOpenTarget: normalizeWebLinkOpenTarget(rawConfig.webLinkOpenTarget),
    workspaceGrouping: rawConfig.workspaceGrouping === 'none' ? 'none' : 'project',
    recentFolders: Array.isArray(rawConfig.recentFolders)
      ? rawConfig.recentFolders.filter((folder): folder is string => typeof folder === 'string')
      : [],
    hideStoppedWorkspaces: pickWithDefault(rawConfig, 'hideStoppedWorkspaces'),
    hideWorkingWorkspaces: pickWithDefault(rawConfig, 'hideWorkingWorkspaces'),
    hiddenWorkspaceHostIds: pickWithDefault(rawConfig, 'hiddenWorkspaceHostIds'),
    workspaceTags: normalizeWorkspaceTags(rawConfig.workspaceTags),
    hiddenWorkspaceTags: pickWithDefault(rawConfig, 'hiddenWorkspaceTags'),
    tagsFromPullRequests: pickWithDefault(rawConfig, 'tagsFromPullRequests'),
    dashboardHiddenWorkspaceHostIds: pickWithDefault(rawConfig, 'dashboardHiddenWorkspaceHostIds'),
    telemetryPingSent: pickWithDefault(rawConfig, 'telemetryPingSent'),
    lastHeartbeatDate: pickWithDefault(rawConfig, 'lastHeartbeatDate'),
    telemetryDistinctId: pickWithDefault(rawConfig, 'telemetryDistinctId'),
    workspaceSyncDeviceId: pickWithDefault(rawConfig, 'workspaceSyncDeviceId'),
    workspaceSyncDisabledHostIds: pickWithDefault(rawConfig, 'workspaceSyncDisabledHostIds'),
    anonymousTelemetryEnabled: pickWithDefault(rawConfig, 'anonymousTelemetryEnabled'),
    // Usage analytics is opt-in, and only an answer to the consent question turns it on.
    usageTelemetryEnabled:
      rawConfig.usageTelemetryConsentAnswered === true && rawConfig.usageTelemetryEnabled === true,
    usageTelemetryConsentAnswered: rawConfig.usageTelemetryConsentAnswered === true,
    reportedTelemetryMilestones: pickWithDefault(rawConfig, 'reportedTelemetryMilestones'),
    errorReportingEnabled: pickWithDefault(rawConfig, 'errorReportingEnabled'),
    dismissedAnnouncementIds: pickWithDefault(rawConfig, 'dismissedAnnouncementIds'),
    zoomLevel: pickWithDefault(rawConfig, 'zoomLevel'),
    shellMode: pickWithDefault(rawConfig, 'shellMode'),
    wslDistro: pickWithDefault(rawConfig, 'wslDistro'),
    preferredCloneProtocol: pickWithDefault(rawConfig, 'preferredCloneProtocol'),
    autoNameWorkspaces: normalizeAutoNameWorkspaces(rawConfig.autoNameWorkspaces),
    autoNameBranches: pickWithDefault(rawConfig, 'autoNameBranches'),
    alwaysShowBranchNameInWorkspaceCards: alwaysShowBranchName(rawConfig),
    compactWorkspaceList: pickWithDefault(rawConfig, 'compactWorkspaceList'),
    defaultSearchOpenMode: pickWithDefault(rawConfig, 'defaultSearchOpenMode'),
    hiddenProjectIds: pickWithDefault(rawConfig, 'hiddenProjectIds'),
    dashboardFilterProject: (rawConfig.dashboardFilterProject as string | null | undefined) ?? null,
    remoteBranchesExpanded: pickWithDefault(rawConfig, 'remoteBranchesExpanded'),
    diffHideUnchangedRegions: pickWithDefault(rawConfig, 'diffHideUnchangedRegions'),
    defaultEditor: pickWithDefault(rawConfig, 'defaultEditor'),
    showEditorInToolbar: pickWithDefault(rawConfig, 'showEditorInToolbar'),
    showTipsInToolbar: pickWithDefault(rawConfig, 'showTipsInToolbar'),
    showStatusBar: pickWithDefault(rawConfig, 'showStatusBar'),
    statusBarSize:
      STATUS_BAR_SIZES.find((size) => size === rawConfig.statusBarSize) ?? DEFAULT_STATUS_BAR_SIZE,
    showAgentsInMenuBar: pickWithDefault(rawConfig, 'showAgentsInMenuBar'),
    agentsMenuBarInBackgroundOnly: pickWithDefault(rawConfig, 'agentsMenuBarInBackgroundOnly'),
    agentsDoneClearedAt: pickWithDefault(rawConfig, 'agentsDoneClearedAt'),
    keepAwakeMode: normalizeKeepAwakeMode(rawConfig.keepAwakeMode),
    statusBarHiddenItems: stringList(rawConfig.statusBarHiddenItems),
    statusBarShownItems: stringList(rawConfig.statusBarShownItems),
    statusBarLeftItems: stringList(rawConfig.statusBarLeftItems),
    statusBarRightItems: stringList(rawConfig.statusBarRightItems),
    // Direct assignment (not pickWithDefault) so a persisted `null`
    // round-trips as `null` instead of being normalized to `undefined`.
    agentLaunchDefaultPresetId: rawConfig.agentLaunchDefaultPresetId as string | null | undefined,
    // A mode pinned to run in the sandbox must not start on the host instead.
    agentLaunchDefaultLaunchModeId: pinnedForRemovedSandbox(rawConfig)
      ? undefined
      : (rawConfig.agentLaunchDefaultLaunchModeId as string | null | undefined),
    agentLaunchDefaultSshHostId: pickWithDefault(rawConfig, 'agentLaunchDefaultSshHostId'),
    agentDisabledCapabilities: stringList(rawConfig.agentDisabledCapabilities) ?? [],
    disableMcpServer: pickWithDefault(rawConfig, 'disableMcpServer'),
    disableNotificationEndpoint: pickWithDefault(rawConfig, 'disableNotificationEndpoint'),
    defaultLaunchModeId: rawConfig.defaultLaunchModeId as string | undefined,
    vimModeEnabled: pickWithDefault(rawConfig, 'vimModeEnabled'),
    windowsUseConptyDll: pickWithDefault(rawConfig, 'windowsUseConptyDll'),
    showSystemMetrics: pickWithDefault(rawConfig, 'showSystemMetrics'),
    statusBarResourceUsage: normalizeStatusBarResourceUsage(rawConfig.statusBarResourceUsage),
    statusBarResourceUsageHostId: pickWithDefault(rawConfig, 'statusBarResourceUsageHostId'),
    statusBarUsageLimits: STATUS_BAR_USAGE_LIMITS.find(
      (limits) => limits === rawConfig.statusBarUsageLimits
    ),
    statusBarUsageResetTime: pickWithDefault(rawConfig, 'statusBarUsageResetTime'),
    showAgentSpinner: pickWithDefault(rawConfig, 'showAgentSpinner'),
    activitySpinner:
      ACTIVITY_SPINNER_STYLES.find((style) => style === rawConfig.activitySpinner) ??
      DEFAULT_ACTIVITY_SPINNER,
    reduceEffects: pickWithDefault(rawConfig, 'reduceEffects'),
    holdToQuit: pickWithDefault(rawConfig, 'holdToQuit'),
    onboardingTipsDismissed: pickWithDefault(rawConfig, 'onboardingTipsDismissed'),
    agentLaunchDefaultsShown: pickWithDefault(rawConfig, 'agentLaunchDefaultsShown'),
    onboardingTipsViewed: pickWithDefault(rawConfig, 'onboardingTipsViewed'),
    selfIntegrationTipCreated: pickWithDefault(rawConfig, 'selfIntegrationTipCreated'),
    selfIntegrationTipCompleted: pickWithDefault(rawConfig, 'selfIntegrationTipCompleted'),
    notificationsNudgePending: pickWithDefault(rawConfig, 'notificationsNudgePending'),
    selfSetupNudgePending: pickWithDefault(rawConfig, 'selfSetupNudgePending'),
    tipsIntroPending: pickWithDefault(rawConfig, 'tipsIntroPending'),
    aiHelpersOffDismissed: pickWithDefault(rawConfig, 'aiHelpersOffDismissed'),
    lastWorkspaceEnvironment: workspaceEnvironment(rawConfig.lastWorkspaceEnvironment),
    defaultSshWorkspaceMode:
      rawConfig.defaultSshWorkspaceMode === 'local-mirror-actions'
        ? 'local-mirror-actions'
        : 'remote',
    gitDefaults: normalizeGitDefaults(rawConfig.gitDefaults),
    gitBackgroundFetch:
      typeof rawConfig.gitBackgroundFetch === 'boolean' ? rawConfig.gitBackgroundFetch : undefined,
    pullRequestCiNotifications:
      typeof rawConfig.pullRequestCiNotifications === 'boolean'
        ? rawConfig.pullRequestCiNotifications
        : undefined,
    voice: normalizeVoice(rawVoice),
    notificationSounds: normalizeNotificationSounds(rawSounds),
  };
}

class ConfigService {
  private configPath: string;
  private config: AppConfig;
  private branchPrefixListeners = new Set<() => void>();
  private configFileExistedAtLoad = false;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor() {
    const komlaPath = ensureKomlaBasePath();
    this.configPath = join(komlaPath, 'config.json');
    this.config = this.load();
  }

  private load(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf-8');
        const rawConfig = migrate(JSON.parse(data), CONFIG_VERSION, CONFIG_MIGRATIONS);
        const normalized = normalizeConfig(rawConfig);
        this.configFileExistedAtLoad = true;
        return normalized;
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }

    // Fresh install (or unreadable/corrupt config) — use defaults. Flag stays
    // false so we treat this boot as having no prior known port.
    return normalizeConfig({});
  }

  private save(): void {
    // Debounce saves to prevent cascading freezes during rapid updates
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      try {
        writeFileAtomicSync(
          this.configPath,
          JSON.stringify({ ...this.config, _version: CONFIG_VERSION }, null, 2)
        );
      } catch (error) {
        console.error('Failed to save config:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  get(): AppConfig {
    return { ...this.config };
  }

  // True iff config.json was loaded successfully when this service first ran.
  // False on fresh installs (no file) AND on corrupt/unparseable configs —
  // both cases yield the defaults and have no usable prior port to compare
  // against. Used to suppress the "port changed" banner when the port we end
  // up on is just our initial assignment, not a deviation from a known value.
  wasLoadedFromDisk(): boolean {
    return this.configFileExistedAtLoad;
  }

  getTelemetryDistinctId(): string {
    if (!this.config.telemetryDistinctId) {
      this.config.telemetryDistinctId = `app_${randomUUID()}`;
      this.save();
    }
    return this.config.telemetryDistinctId;
  }

  getWorkspaceSyncDeviceId(): string {
    if (!this.config.workspaceSyncDeviceId) {
      this.config.workspaceSyncDeviceId = randomUUID();
      this.save();
    }
    return this.config.workspaceSyncDeviceId;
  }

  getUtilityInferenceConfig(): UtilityInferenceConfig {
    return {
      provider: this.config.utilityProvider,
      openRouterModel: this.config.openRouterModel,
      openRouterBaseUrl: this.config.openRouterBaseUrl,
      workspaceNamingPrompt: this.config.workspaceNamingPrompt ?? '',
      commitMessagePrompt: this.config.commitMessagePrompt ?? '',
    };
  }

  update(updates: Partial<AppConfig>): AppConfig {
    const branchPrefix = this.config.gitDefaults?.branchPrefix;
    const merged = normalizeConfig({ ...this.config, ...updates });
    this.config = merged;
    this.save();
    if (merged.gitDefaults?.branchPrefix !== branchPrefix) {
      for (const listener of this.branchPrefixListeners) listener();
    }
    return this.get();
  }

  /** Calls `listener` after the branch prefix projects without their own follow changes. */
  onBranchPrefixChange(listener: () => void): () => void {
    this.branchPrefixListeners.add(listener);
    return () => this.branchPrefixListeners.delete(listener);
  }

  getSettingsPath(): string {
    return getKomlaBasePath();
  }
}

export const configService = new ConfigService();
