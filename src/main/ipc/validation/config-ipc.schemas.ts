import { z } from 'zod';

import { MAX_UTILITY_PROMPT_CHARS } from '../../../shared/constants/utility-prompts';
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, snapZoomLevel } from '../../../shared/constants/zoom';
import { ACTIVITY_SPINNER_STYLES } from '../../../shared/lib/activity-spinner';
import {
  MAX_PROJECT_ICON_DATA_URL_LENGTH,
  PROJECT_ICON_DATA_URL,
} from '../../../shared/lib/project-icon';
import { REMOTE_PASSKEY_WINDOW_MINUTES } from '../../../shared/lib/remote-passkey-window';
import { STATUS_BAR_SIZES } from '../../../shared/lib/status-bar-size';
import { WORKSPACE_GROUPINGS } from '../../../shared/lib/workspace-grouping';
import {
  isWorkspaceTagIcon,
  MAX_WORKSPACE_TAG_LENGTH,
  MAX_WORKSPACE_TAGS,
  PULL_REQUEST_TAG_STATES,
  WORKSPACE_TAG_TONES,
} from '../../../shared/lib/workspace-tags';
import {
  ACTION_SSH_EXECUTION_LOCATIONS,
  isValidSshBasePath,
  isValidSshHostname,
  SETUP_DESTINATIONS,
  SETUP_STEP_PLACEMENTS,
  SETUP_TRIGGERS,
} from '../../../shared/types';
import {
  LEVEL_PICKER_ICONS,
  MAX_LEVEL_PICKER_TITLE_LENGTH,
} from '../../../shared/types/agent-preset';

import { BRANCH_NAME_PATTERN, idSchema, nonEmptyStringSchema, safePathSchema } from './primitives';

const setupStepPlacementSchema = z.enum(SETUP_STEP_PLACEMENTS);
const agentPlacementSchema = z.enum(['tab', 'split-right', 'split-bottom']);
const sshAgentSchema = z.enum(['claude', 'codex', 'antigravity', 'opencode']);
const sshIntegrationTypeSchema = z.enum(['notifications', 'mcp']);
const sshHostCapabilitiesSchema = z
  .object({
    checkedAt: z.string().datetime(),
    git: z.object({
      status: z.enum(['available', 'missing']),
      version: z.string().optional(),
    }),
    localMirror: z.object({
      platform: z.enum(['supported', 'unsupported']),
      localRsync: z.enum(['available', 'missing']),
      remoteRsync: z.enum(['available', 'missing']),
    }),
    tmux: z.object({
      status: z.enum(['available', 'missing', 'unusable']),
      version: z.string().optional(),
    }),
    monitoring: z
      .object({
        status: z.enum(['available', 'missing']),
        missingRequirements: z.array(z.string()),
      })
      .optional(),
  })
  .strip();
const workspaceEnvironmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strip(),
  z.object({ kind: z.literal('ssh'), hostId: idSchema }).strip(),
]);

export const sshHostSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    hostname: z.string().min(1).refine(isValidSshHostname, {
      message: 'hostname must be a hostname or IP address without user or port',
    }),
    user: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    identityFile: z.string().optional(),
    basePath: z.string().min(1).refine(isValidSshBasePath, {
      message:
        'base path must not resolve to the filesystem root or home directory or contain parent traversal',
    }),
    forwardAgent: z.boolean().optional(),
    isolated: z.boolean().optional(),
    extraSshArgs: z.array(z.string()).optional(),
    portForwards: z
      .array(
        z
          .object({
            id: idSchema,
            name: z.string().min(1),
            direction: z.enum(['local-to-remote', 'remote-to-local']).optional(),
            localPort: z.number().int().min(1).max(65535),
            remotePort: z.number().int().min(1).max(65535),
            enabled: z.boolean(),
          })
          .strip()
      )
      .optional(),
    setupPending: z.boolean().optional(),
    capabilities: sshHostCapabilitiesSchema.optional(),
  })
  .strip();

const setupStepSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    command: z.string(),
    placement: setupStepPlacementSchema,
    actionId: z.string().optional(),
    agent: z
      .object({
        presetId: idSchema.optional(),
        launchModeId: idSchema.optional(),
      })
      .strip()
      .optional(),
    destination: z.enum(SETUP_DESTINATIONS).optional(),
    trigger: z.enum(SETUP_TRIGGERS).optional(),
  })
  .strip();

const appConfigUpdateSchema = z
  .object({
    agentSetupComplete: z.boolean().optional(),
    scrollbackLines: z.number().int().optional(),
    theme: z.enum(['dark', 'system']).optional(),
    defaultProjectId: idSchema.nullable().optional(),
    lastUsedProjectId: idSchema.nullable().optional(),
    notificationsEnabled: z.boolean().optional(),
    notificationPort: z.number().int().optional(),
    directRemoteEnabled: z.boolean().optional(),
    directRemotePort: z.number().int().min(1).max(65535).optional(),
    directRemotePublicOrigin: z.string().max(2048).optional(),
    directRemoteManagedTailscaleOrigin: z.string().optional(),
    directRemoteKeepAwake: z.boolean().optional(),
    directRemoteLocalAccess: z.boolean().optional(),
    directRemotePasskeyWindowMinutes: z.literal(REMOTE_PASSKEY_WINDOW_MINUTES).optional(),
    utilityProvider: z.enum(['komla-managed', 'custom']).optional(),
    openRouterModel: nonEmptyStringSchema.optional(),
    openRouterBaseUrl: z.string().url().optional(),
    workspaceNamingPrompt: z.string().max(MAX_UTILITY_PROMPT_CHARS).optional(),
    commitMessagePrompt: z.string().max(MAX_UTILITY_PROMPT_CHARS).optional(),
    defaultFileTreeOpen: z.boolean().optional(),
    defaultFileTreeMode: z.enum(['diff', 'browse']).optional(),
    defaultLiveFollow: z.boolean().optional(),
    defaultCompareTargetBranch: z.boolean().optional(),
    defaultInlinePreviewLayout: z.enum(['full', 'side-by-side']).optional(),
    defaultDevServerPreviewAutoReload: z.boolean().optional(),
    webLinkOpenTarget: z.enum(['auto', 'komla', 'external']).optional(),
    workspaceGrouping: z.enum(WORKSPACE_GROUPINGS).optional(),
    hideStoppedWorkspaces: z.boolean().optional(),
    hideWorkingWorkspaces: z.boolean().optional(),
    hiddenWorkspaceHostIds: z.array(idSchema).optional(),
    workspaceTags: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(MAX_WORKSPACE_TAG_LENGTH),
            tone: z.enum(WORKSPACE_TAG_TONES),
            pullRequestState: z.enum(PULL_REQUEST_TAG_STATES).optional(),
            icon: z.string().refine(isWorkspaceTagIcon, 'Not a tag icon.').optional(),
            spinner: z.boolean().optional(),
          })
          .strip()
      )
      .max(MAX_WORKSPACE_TAGS)
      .optional(),
    // Lowercased, which can lengthen a name.
    hiddenWorkspaceTags: z
      .array(z.string().max(MAX_WORKSPACE_TAG_LENGTH * 2))
      .max(MAX_WORKSPACE_TAGS * 2)
      .optional(),
    tagsFromPullRequests: z.boolean().optional(),
    dashboardHiddenWorkspaceHostIds: z.array(idSchema).optional(),
    remoteBranchesExpanded: z.boolean().optional(),
    diffHideUnchangedRegions: z.boolean().optional(),
    anonymousTelemetryEnabled: z.boolean().optional(),
    usageTelemetryEnabled: z.boolean().optional(),
    errorReportingEnabled: z.boolean().optional(),
    dismissedAnnouncementIds: z.array(z.string()).optional(),
    zoomLevel: z
      .number()
      .min(MIN_ZOOM_LEVEL)
      .max(MAX_ZOOM_LEVEL)
      .transform(snapZoomLevel)
      .optional(),
    shellMode: z.enum(['powershell', 'wsl']).optional(),
    wslDistro: z.string().optional(),
    preferredCloneProtocol: z.enum(['https', 'ssh']).optional(),
    autoNameWorkspaces: z.enum(['off', 'first-prompt']).optional(),
    autoNameBranches: z.boolean().optional(),
    hideBranchNameInWorkspaceCards: z.boolean().optional(),
    compactWorkspaceList: z.boolean().optional(),
    defaultSearchOpenMode: z.enum(['viewer', 'preview', 'current']).optional(),
    hiddenProjectIds: z.array(idSchema).optional(),
    dashboardFilterProject: z.string().nullable().optional(),
    defaultEditor: z.string().optional(),
    showEditorInToolbar: z.boolean().optional(),
    showTipsInToolbar: z.boolean().optional(),
    showStatusBar: z.boolean().optional(),
    statusBarSize: z.enum(STATUS_BAR_SIZES).optional(),
    showAgentsInMenuBar: z.boolean().optional(),
    agentsMenuBarInBackgroundOnly: z.boolean().optional(),
    agentsDoneClearedAt: z.number().int().nonnegative().optional(),
    // Komla's own items, and custom items by id.
    statusBarHiddenItems: z.array(z.string().max(64)).max(128).optional(),
    statusBarShownItems: z.array(z.string().max(64)).max(32).optional(),
    // Komla's own items and custom items by id, in order.
    statusBarLeftItems: z.array(z.string().max(64)).max(128).optional(),
    statusBarRightItems: z.array(z.string().max(64)).max(128).optional(),
    keepAwakeMode: z.enum(['off', 'agents', 'always']).optional(),
    agentLaunchDefaultPresetId: z.string().optional(),
    agentLaunchDefaultLaunchModeId: z.string().optional(),
    agentLaunchDefaultSshHostId: z.string().optional(),
    workspaceSyncDisabledHostIds: z.array(idSchema).optional(),
    agentDisabledCapabilities: z.array(z.string()).max(64).optional(),
    disableMcpServer: z.boolean().optional(),
    disableNotificationEndpoint: z.boolean().optional(),
    defaultLaunchModeId: z.string().optional(),
    vimModeEnabled: z.boolean().optional(),
    windowsUseConptyDll: z.boolean().optional(),
    showSystemMetrics: z.boolean().optional(),
    statusBarResourceUsage: z
      .enum(['komla', 'komla-and-workspaces', 'computer', 'ssh-host', 'ssh-host-workspaces'])
      .optional(),
    statusBarResourceUsageHostId: z.string().optional(),
    statusBarUsageLimits: z.enum(['auto', 'five-hour', 'weekly', 'both']).optional(),
    statusBarUsageResetTime: z.boolean().optional(),
    showAgentSpinner: z.boolean().optional(),
    activitySpinner: z.enum(ACTIVITY_SPINNER_STYLES).optional(),
    reduceEffects: z.boolean().optional(),
    holdToQuit: z.boolean().optional(),
    onboardingTipsDismissed: z.boolean().optional(),
    agentLaunchDefaultsShown: z.boolean().optional(),
    onboardingTipsViewed: z.boolean().optional(),
    selfIntegrationTipCreated: z.boolean().optional(),
    selfIntegrationTipCompleted: z.boolean().optional(),
    notificationsNudgePending: z.boolean().optional(),
    selfSetupNudgePending: z.boolean().optional(),
    tipsIntroPending: z.boolean().optional(),
    lastWorkspaceEnvironment: workspaceEnvironmentSchema.optional(),
    defaultSshWorkspaceMode: z.enum(['remote', 'local-mirror-actions']).optional(),
    gitDefaults: z
      .object({
        branchPrefix: z.string().optional(),
        aheadMainAction: z.enum(['pr', 'merge', 'agent-prompt', 'disabled']).optional(),
        aheadOtherAction: z.enum(['pr', 'merge', 'agent-prompt', 'disabled']).optional(),
        aheadMainActionId: z.string().optional(),
        aheadOtherActionId: z.string().optional(),
        autoPushAfterMerge: z.boolean().optional(),
        behindTargetAction: z.enum(['auto', 'rebase', 'merge']).optional(),
      })
      .strict()
      .optional(),
    gitBackgroundFetch: z.boolean().optional(),
    pullRequestCiNotifications: z.boolean().optional(),
    voice: z
      .object({
        modelId: z.string(),
        modelPath: z.string().nullable(),
        enabled: z.boolean(),
        autoRecord: z.boolean(),
        transcribeAction: z.enum(['fill', 'launch']),
      })
      .strip()
      .optional(),
    notificationSounds: z
      .object({
        enabled: z.boolean(),
        volume: z.number().min(0).max(1),
        turnComplete: z.boolean(),
        turnCompleteSound: z.string(),
        inputRequired: z.boolean(),
        inputRequiredSound: z.string(),
      })
      .strip()
      .optional(),
  })
  .strip();

const categoryUpdateSchema = z
  .object({
    name: z.string().optional(),
    parentId: idSchema.nullable().optional(),
    order: z.number().int().optional(),
  })
  .strip();

const simpleAheadActionSchema = z.enum(['merge', 'pr', 'disabled', 'agent-prompt']);
const aheadTargetActionSchema = z.enum([
  'auto-default',
  'auto',
  'unconfigured',
  'merge',
  'pr',
  'disabled',
  'agent-prompt',
]);

const behindTargetActionSchema = z.enum(['auto', 'rebase', 'merge']);
const projectKindSchema = z.enum(['git', 'directory']);
const projectIconSchema = z
  .string()
  .max(MAX_PROJECT_ICON_DATA_URL_LENGTH)
  .regex(PROJECT_ICON_DATA_URL);

const autoModeFields = {
  autoMainBranchAction: simpleAheadActionSchema.optional(),
  autoOtherBranchAction: simpleAheadActionSchema.optional(),
  autoMainActionId: z.string().optional(),
  autoOtherActionId: z.string().optional(),
};

const createProjectParamsSchema = z
  .object({
    kind: projectKindSchema.optional(),
    name: z.string().optional(),
    repositoryPath: safePathSchema,
    defaultBranchPrefix: z.string().optional(),
    baseBranch: z.string().optional(),
    color: z.string().optional(),
    icon: projectIconSchema.optional(),
    iconPromptAsked: z.boolean().optional(),
    aheadTargetAction: aheadTargetActionSchema.optional(),
    autoPushAfterMerge: z.boolean().optional(),
    aheadTargetActionId: z.string().optional(),
    behindTargetAction: behindTargetActionSchema.optional(),
    ...autoModeFields,
  })
  .strip();

const createProjectFromRemoteParamsSchema = z
  .object({
    remoteUrl: nonEmptyStringSchema,
    name: z.string().optional(),
    defaultBranchPrefix: z.string().optional(),
    baseBranch: z.string().optional(),
    color: z.string().optional(),
    icon: projectIconSchema.optional(),
    aheadTargetAction: aheadTargetActionSchema.optional(),
    autoPushAfterMerge: z.boolean().optional(),
    aheadTargetActionId: z.string().optional(),
    behindTargetAction: behindTargetActionSchema.optional(),
    ...autoModeFields,
  })
  .strip();

const createProjectFromNewParamsSchema = z
  .object({
    name: nonEmptyStringSchema,
    defaultBranchPrefix: z.string().optional(),
    color: z.string().optional(),
    icon: projectIconSchema.optional(),
    aheadTargetAction: aheadTargetActionSchema.optional(),
    autoPushAfterMerge: z.boolean().optional(),
    aheadTargetActionId: z.string().optional(),
    behindTargetAction: behindTargetActionSchema.optional(),
    ...autoModeFields,
  })
  .strip();

const projectUpdateSchema = z
  .object({
    name: z.string().optional(),
    defaultBranchPrefix: z.string().optional(),
    order: z.number().int().optional(),
    color: z.string().optional(),
    // Empty goes back to the color dot.
    icon: projectIconSchema.or(z.literal('')).optional(),
    setupSteps: z.array(setupStepSchema).optional(),
    baseBranch: z.string().optional(),
    agentPlacement: agentPlacementSchema.optional(),
    agentLayoutOrder: z.number().int().optional(),
    trashCleanupScript: z
      .string()
      .max(64 * 1024)
      .optional(),
    managed: z.boolean().optional(),
    managedRepoPath: safePathSchema.optional(),
    aheadTargetAction: aheadTargetActionSchema.optional(),
    autoPushAfterMerge: z.boolean().optional(),
    aheadTargetActionId: z.string().optional(),
    behindTargetAction: behindTargetActionSchema.optional(),
    sshWorkspaceMode: z.enum(['remote', 'local-mirror-actions']).optional(),
    ...autoModeFields,
  })
  .strip();

const launchModeSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    arguments: z.string().optional(),
    color: z.string().optional(),
    agentLaunch: z.enum(['never', 'isolated', 'always']).optional(),
  })
  .strip();

const reasoningLevelSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    arguments: z.string(),
  })
  .strip();

// What a preset stores for its level picker; `komla settings apply agents` takes it too.
export const levelPickerFields = {
  title: z.string().trim().min(1).max(MAX_LEVEL_PICKER_TITLE_LENGTH).optional(),
  icon: z.enum(LEVEL_PICKER_ICONS).optional(),
  hidden: z.boolean().optional(),
};

const levelPickerSchema = z.object(levelPickerFields).strip();

const presetCreateSchema = z
  .object({
    name: nonEmptyStringSchema,
    openCommand: z.string(),
    continueCommand: z.string(),
    promptCommand: z.string(),
    launchModes: z.array(launchModeSchema).default([]),
    reasoningLevels: z.array(reasoningLevelSchema).optional(),
    levelPicker: levelPickerSchema.optional(),
    isBuiltin: z.boolean(),
  })
  .strip();

const presetUpdateSchema = z
  .object({
    name: z.string().optional(),
    openCommand: z.string().optional(),
    continueCommand: z.string().optional(),
    promptCommand: z.string().optional(),
    launchModes: z.array(launchModeSchema).optional(),
    reasoningLevels: z.array(reasoningLevelSchema).optional(),
    levelPicker: levelPickerSchema.optional(),
    isBuiltin: z.boolean().optional(),
  })
  .strip();

const themeColorsSchema = z
  .object({
    accent: z.string(),
    lightAccent: z.string(),
    background: z.string(),
    foreground: z.string(),
    muted: z.string(),
    border: z.string(),
    destructive: z.string(),
  })
  .strip();

const themeTypographySchema = z
  .object({
    fontFamily: z.string(),
    fontSize: z.number(),
    borderRadius: z.number(),
  })
  .strip();

const themeUpdateSchema = z
  .object({
    mode: z.literal('dark').optional(),
    palette: z.string().min(1).max(64).optional(),
    followSystem: z.boolean().optional(),
    lightPalette: z.string().min(1).max(64).optional(),
    colors: themeColorsSchema.partial().optional(),
    typography: themeTypographySchema.partial().optional(),
  })
  .strip();

const terminalAnsiSchema = z
  .object({
    black: z.string(),
    red: z.string(),
    green: z.string(),
    yellow: z.string(),
    blue: z.string(),
    magenta: z.string(),
    cyan: z.string(),
    white: z.string(),
    brightBlack: z.string(),
    brightRed: z.string(),
    brightGreen: z.string(),
    brightYellow: z.string(),
    brightBlue: z.string(),
    brightMagenta: z.string(),
    brightCyan: z.string(),
    brightWhite: z.string(),
  })
  .strip();

// Matches the renderer-side validator in terminal-background-settings.ts.
// Only background is enforced here because it is the sole color field exposed
// via the settings UI; the others may contain user-edited values from
// terminal.json that don't conform to 6-digit hex.
const sixDigitHexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const terminalColorConfigSchema = z
  .object({
    background: sixDigitHexColorSchema,
    foreground: z.string(),
    cursor: z.string(),
    selection: z.string(),
    ansi: terminalAnsiSchema,
  })
  .strip();

export const terminalUpdateSchema = z
  .object({
    font: z
      .object({
        family: z.string(),
        size: z.number(),
        lineHeight: z.number(),
      })
      .strip()
      .partial()
      .optional(),
    cursor: z
      .object({
        style: z.enum(['block', 'underline', 'bar']),
        blink: z.boolean(),
      })
      .strip()
      .partial()
      .optional(),
    scrollback: z.number().int().optional(),
    showPaneHeaders: z.boolean().optional(),
    showButtonsOnFocus: z.boolean().optional(),
    unfocusedPaneDimOpacity: z.number().min(0).max(1).optional(),
    focusedPaneBorder: z.boolean().optional(),
    notificationPaneBorder: z.boolean().optional(),
    sendRightClickToPrograms: z.boolean().optional(),
    colors: terminalColorConfigSchema.partial().optional(),
  })
  .strip();

const shortcutsUpdateSchema = z
  .object({
    shortcuts: z.record(z.string(), z.string()).optional(),
  })
  .strip();

const actionTypeSchema = z.enum(['prompt', 'command']);
const actionSshExecutionLocationSchema = z.enum(ACTION_SSH_EXECUTION_LOCATIONS);

const actionCreateSchema = z
  .object({
    title: nonEmptyStringSchema,
    content: nonEmptyStringSchema,
    type: actionTypeSchema.optional(),
    projectIds: z.array(idSchema).optional(),
    presetId: idSchema.optional(),
    launchModeId: idSchema.optional(),
    sshExecutionLocation: actionSshExecutionLocationSchema.optional(),
    background: z.boolean().optional(),
  })
  .strip();

const actionUpdateSchema = z
  .object({
    title: nonEmptyStringSchema.optional(),
    content: nonEmptyStringSchema.optional(),
    type: actionTypeSchema.optional(),
    projectIds: z.array(idSchema).optional(),
    presetId: idSchema.nullable().optional(),
    launchModeId: idSchema.nullable().optional(),
    sshExecutionLocation: actionSshExecutionLocationSchema.nullable().optional(),
    background: z.boolean().nullable().optional(),
  })
  .strip();

const actionRecordUsageSchema = z
  .object({
    id: idSchema,
    userInput: z.string().optional(),
    pasted: z.boolean().optional(),
  })
  .strip();

const feedbackPayloadSchema = z
  .object({
    type: z.enum(['bug', 'feature', 'general']),
    description: nonEmptyStringSchema,
    email: z.string().email().optional(),
    screenshotPaths: z.array(safePathSchema).optional(),
  })
  .strip();

const errorReportSchema = z
  .object({
    message: nonEmptyStringSchema,
    stack: z.string().optional(),
    type: z.enum(['uncaughtException', 'unhandledRejection', 'errorBoundary']),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export const configUpdateArgsSchema = z.tuple([appConfigUpdateSchema]);
export const configSaveOpenRouterApiKeyArgsSchema = z.tuple([nonEmptyStringSchema]);
export const configClearOpenRouterApiKeyArgsSchema = z.tuple([]);
export const configGetOpenRouterKeyStatusArgsSchema = z.tuple([]);
export const configTestCustomEndpointArgsSchema = z.tuple([]);
export const configVerifySshHostArgsSchema = z.union([
  z.tuple([sshHostSchema]),
  z.tuple([sshHostSchema, z.object({ prepare: z.boolean().optional() }).strip()]),
]);
export const sshSaveHostArgsSchema = z.tuple([sshHostSchema]);
export const sshDeleteHostArgsSchema = z.tuple([
  idSchema,
  z
    .object({
      deleteRemoteData: z.boolean().optional(),
    })
    .strip()
    .optional(),
]);
export const sshGetIntegrationStatusArgsSchema = z.tuple([idSchema]);
export const sshCheckHostArgsSchema = z.tuple([idSchema]);
export const sshGetCachedIntegrationUpdatesArgsSchema = z.tuple([]);
export const sshGetPortForwardStatusArgsSchema = z.tuple([idSchema]);
export const sshListForwardedPortsArgsSchema = z.tuple([]);
export const sshListConfigHostsArgsSchema = z.tuple([]);
export const sshStopDesktopForwardArgsSchema = z.tuple([
  idSchema,
  z.number().int().min(1).max(65535),
]);
export const sshEnableIntegrationArgsSchema = z.tuple([
  idSchema,
  sshAgentSchema,
  sshIntegrationTypeSchema,
]);
export const sshDisableIntegrationArgsSchema = z.tuple([
  idSchema,
  sshAgentSchema,
  sshIntegrationTypeSchema,
]);
export const komlaSkillArgsSchema = z.tuple([]);
export const sshSetKomlaSkillArgsSchema = z.tuple([idSchema, z.boolean()]);

export const categoryCreateArgsSchema = z.tuple([nonEmptyStringSchema, idSchema.optional()]);
export const categoryUpdateArgsSchema = z.tuple([idSchema, categoryUpdateSchema]);
export const categoryDeleteArgsSchema = z.tuple([idSchema]);

export const projectCreateArgsSchema = z.tuple([createProjectParamsSchema]);
export const projectGetArgsSchema = z.tuple([idSchema]);
export const projectUpdateArgsSchema = z.tuple([idSchema, projectUpdateSchema]);
export const projectSetSshWorkspaceModeIfUnsetArgsSchema = z.tuple([
  idSchema,
  z.enum(['remote', 'local-mirror-actions']),
]);
export const projectDeleteArgsSchema = z.tuple([idSchema]);
export const projectValidateRepoArgsSchema = z.tuple([safePathSchema]);
export const projectFindForFolderArgsSchema = z.tuple([safePathSchema]);
export const projectFolderOpenedArgsSchema = z.tuple([safePathSchema]);
export const projectCreateFromRemoteArgsSchema = z.tuple([createProjectFromRemoteParamsSchema]);
export const projectCreateFromNewArgsSchema = z.tuple([createProjectFromNewParamsSchema]);
export const projectFindIconsArgsSchema = z.tuple([
  z.union([
    z.object({ folder: safePathSchema }).strict(),
    z.object({ projectId: idSchema }).strict(),
  ]),
]);
export const projectTakeIconPromptArgsSchema = z.tuple([idSchema]);
export const projectChooseIconFileArgsSchema = z.tuple([]);
// The last argument is the SSH host whose clone to clean up, or null for this computer's.
export const projectListLeftoverBranchesArgsSchema = z.tuple([idSchema, idSchema.nullable()]);
export const projectCheckWorkspacesForCleanupArgsSchema = z.tuple([idSchema]);
export const projectListHostBranchesArgsSchema = z.tuple([idSchema, idSchema]);
export const projectDeleteLeftoverBranchesArgsSchema = z.tuple([
  idSchema,
  z
    .array(
      z
        .object({
          name: z.string().max(1024).regex(BRANCH_NAME_PATTERN, 'must be a branch name'),
          commit: z.string().regex(/^[0-9a-f]{40,64}$/, 'must be a commit hash'),
        })
        .strict()
    )
    .max(10_000),
  idSchema.nullable(),
]);

export const presetGetArgsSchema = z.tuple([idSchema]);
export const presetSetActiveArgsSchema = z.tuple([idSchema]).rest(z.string().nullable().optional());
export const presetCreateArgsSchema = z.tuple([presetCreateSchema]);
export const presetCreateActiveArgsSchema = z.tuple([z.array(presetCreateSchema).min(1).max(50)]);
export const presetUpdateArgsSchema = z.tuple([idSchema, presetUpdateSchema]);
export const presetDeleteArgsSchema = z.tuple([idSchema]);
export const presetReorderArgsSchema = z.tuple([idSchema, z.number().int().min(0)]);
export const presetBuildPromptArgsSchema = z.tuple([z.string()]).rest(z.string().optional());
export const presetAddActiveArgsSchema = z.tuple([idSchema]);
export const presetRemoveActiveArgsSchema = z.tuple([idSchema]);

export const shellOpenExternalArgsSchema = z.tuple([nonEmptyStringSchema]);
export const shellOpenInEditorArgsSchema = z.tuple([nonEmptyStringSchema, safePathSchema]);
export const shellPathArgsSchema = z.tuple([safePathSchema]);

export const customizationUpdateThemeArgsSchema = z.tuple([themeUpdateSchema]);
export const customizationUpdateTerminalArgsSchema = z.tuple([terminalUpdateSchema]);

export const shortcutsUpdateArgsSchema = z.tuple([shortcutsUpdateSchema]);
export const actionCreateArgsSchema = z.tuple([actionCreateSchema]);
export const actionUpdateArgsSchema = z.tuple([idSchema, actionUpdateSchema]);
export const actionReorderArgsSchema = z.tuple([idSchema, z.number().int().min(0)]);
export const actionDeleteArgsSchema = z.tuple([idSchema]);
export const actionRecordUsageArgsSchema = z.tuple([actionRecordUsageSchema]);
export const feedbackSendArgsSchema = z.tuple([feedbackPayloadSchema]);
export const errorReportArgsSchema = z.tuple([errorReportSchema]);
