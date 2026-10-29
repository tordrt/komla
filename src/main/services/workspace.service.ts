import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { realpath, stat } from 'fs/promises';
import { join, basename, dirname, posix as pathPosix, resolve, sep } from 'path';
import { isDeepStrictEqual } from 'util';

import { BrowserWindow } from 'electron';

import { turnedOffQueuedCommands } from '../../shared/constants/agent-capabilities';
import { IPC } from '../../shared/constants/ipc-channels';
import {
  buildProjectSetupPrompt,
  isProjectSetupPrompt,
} from '../../shared/constants/project-setup-prompt';
import {
  requestedWorkspaceEnvironment,
  resolveWorkspaceCreationEnvironment,
} from '../../shared/lib/agent-environment';
import { normalizeBrowserPanes } from '../../shared/lib/browser-tabs';
import { resolveBranchPrefix } from '../../shared/lib/project-git-defaults';
import { projectRepoPath } from '../../shared/lib/project-repo-path';
import {
  generateBranchSuffix,
  branchSuffixToName,
  sanitizeBranchSuffix,
  sanitizeBranchName,
  sanitizeWorktreeProjectSegment,
} from '../../shared/lib/random-names';
import { normalizeRecentLinks } from '../../shared/lib/recent-links';
import {
  normalizeSshStartPoint,
  normalizeSshTargetBranch,
} from '../../shared/lib/ssh-target-branch';
import { resolveSshWorkspaceMode } from '../../shared/lib/ssh-workspace-mode';
import {
  encodeTerminalExecution,
  endsIfGoneFromHost,
  hostCheckStamp,
  isResumable,
  isRunningHere,
  isRunningOnSshHost,
  needsHostCheck,
  persistedRemoteSessionActive,
  sessionEndedHere,
  takesFreeSshSlot,
} from '../../shared/lib/terminal-execution-state';
import { normalizeVirtualDesktops } from '../../shared/lib/virtual-desktops';
import {
  MAX_WORKSPACE_TAG_TOOLTIP,
  normalizeWorkspaceTagName,
  normalizeWorkspaceTags,
  PULL_REQUEST_TAG_STATES,
  pullRequestTagUpdate,
  type PullRequestTagState,
} from '../../shared/lib/workspace-tags';
import { normalizeSshBasePath, type SshHost } from '../../shared/types/ssh';
import { isLocalTerminalExecutionLocation } from '../../shared/types/terminal';
import {
  attentionWakesSnooze,
  canDeleteWorkspaceBranch,
  getBranchesInUse,
  hasWorkspaceFiles,
  isSshWorkspace,
  isWorkspaceSnoozed,
  resolveWorkspaceTargetBranch,
  SshProjectNeedsRemoteError,
  toLocalBranchName,
  type CommandKind,
  type RestartTerminalOptions,
  type WorkspaceCustomNameSource,
  type SshWorkspaceBackend,
  type WorkspaceBackend,
  type WorkspaceGitStatusSnapshot,
} from '../../shared/types/workspace';
import { writeFileAtomic } from '../lib/atomic-write';
import { gitRemoteIdentity } from '../lib/git-remote-identity';
import { publishAttentionHookEvent, publishHookEvent } from '../lib/hook-events';
import { createLogger } from '../lib/logger';
import { migrate } from '../lib/migration';
import { deleteReleasingOpenCodeLocation } from '../lib/opencode-service';
import { sshConnectionFailure } from '../lib/ssh-connection-failure';
import {
  onTerminalOscNotification,
  onTerminalProgramStatus,
  onTerminalTitle,
} from '../lib/terminal-notification-events';
import { createWorkspaceId } from '../lib/workspace-id';

import { actionService } from './action.service';
import { agentPresetService } from './agent-preset.service';
import { backgroundProcessService } from './background-process.service';
import { configService } from './config.service';
import { executionLocations } from './execution-location';
import {
  CHECK_CONCURRENCY,
  localGitBatchRunner,
  mapWithConcurrency,
  type GitBatchRunner,
  type WorktreeHead,
} from './git/git-branch-cleanup';
import { gitService } from './git.service';
import { httpServerService } from './http-server.service';
import { FREE_WORKSPACE_LIMIT, licenseService } from './license.service';
import { localMirrorService } from './local-mirror.service';
import {
  configureManagedRemoteTerminalLifecycle,
  managedRemoteTerminalLifecycleService,
} from './managed-remote-terminal-lifecycle.service';
import { metricsCollectorService } from './metrics-collector.service';
import { notesService } from './notes.service';
import { ensureKomlaBasePath, getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { ptyService } from './pty.service';
import { remoteCompanionService, resolveRemoteCompanionRuntime } from './remote-companion.service';
import { remoteControlHostAccessService } from './remote-control-host-access.service';
import { configureHostLaunch } from './remote-control-host-launch';
import { publishRemoteWorkspaceChange } from './remote-workspace-events';
import {
  configureRemoteWorkspaceObservation,
  remoteWorkspaceObservationService,
} from './remote-workspace-observation.service';
import { sshHostService } from './ssh-host.service';
import { sshPortForwardService } from './ssh-port-forward.service';
import {
  configureSshWorkspaceProvisioning,
  sshWorkspaceProvisioningService,
} from './ssh-workspace-provisioning.service';
import { sshWorkspaceSyncHost } from './ssh-workspace-sync/host';
import {
  SshWorkspaceSync,
  type SshWorkspacePlacement,
} from './ssh-workspace-sync/ssh-workspace-sync';
import { normalizePersistedTerminalLayout } from './ssh-workspace-sync/terminal-layout';
import { sshCompanionInstallationId, sshWorkspaceService } from './ssh-workspace.service';
import { telemetryService } from './telemetry.service';
import {
  TerminalAttention,
  type AgentHook,
  type HookMark,
} from './terminal-attention/terminal-attention';
import { electronAttentionWindows } from './terminal-attention/windows';
import { utilityInferenceService } from './utility-inference.service';
import { windowService } from './window.service';
import { workspaceFileService } from './workspace-file.service';
import { sshWorkspaceGit } from './workspace-git/ssh-git';
import { workspaceLinksService } from './workspace-links.service';
import { backgroundActionNotification } from './workspace-setup/action-run-notification';
import { configureWorkspaceSetup, workspaceSetupService } from './workspace-setup.service';
import { wakeWorkspace, WorkspaceSnoozeAlarm } from './workspace-snooze';
import { configureWorkspaceStatus, workspaceStatusService } from './workspace-status.service';
import { worktreeWatcherService } from './worktree-watcher.service';

import type { ManagedRemoteTerminalState } from './managed-remote-terminal-lifecycle.service';
import type { BackgroundActionLaunch } from './workspace-setup/automation';
import type { ManagedTmuxFindResult } from '../../shared/lib/ssh-tmux-attach';
import type {
  TerminalStatus,
  TerminalExecutionLocation,
  TerminalLaunchLocation,
  Terminal,
  Workspace,
  CreateWorkspaceParams,
  WorkspaceAttention,
  WorkspaceAttentionEvent,
  WorkspaceAttentionSource,
  WorkspaceStatus,
  WorkspaceBrowserPane,
  WorkspaceRecentLink,
  WorkspaceVirtualDesktop,
  WorkspacePromptSubmit,
  Project,
  AgentPreset,
  AddAgentTabOptions,
  WorkspaceCleanupStatus,
} from '../../shared/types';
import type {
  SshWorkspaceLaunch,
  SshWorkspaceManifest,
  SshWorkspaceRemovedOnOtherDevice,
} from '../../shared/types/ssh-workspace-manifest';

// Re-export types for consumers that import from this module
export type { TerminalStatus, Terminal, Workspace, CreateWorkspaceParams };

const logger = createLogger('WorkspaceService');

/** The SSH workspace copies last seen on their hosts, which merges after a restart start from. */
function sshWorkspaceSyncPath(): string {
  return join(getKomlaBasePath(), 'ssh-workspace-sync.json');
}

/** The Action a workspace's run button starts on: the most recently run one its project has. */
function lastUsedActionId(projectId: string | null): string | undefined {
  let lastUsed: { id: string; lastUsedAt: number } | undefined;
  for (const action of actionService.list()) {
    const inProject =
      !action.projectIds?.length || (projectId !== null && action.projectIds.includes(projectId));
    if (inProject && action.lastUsedAt && action.lastUsedAt > (lastUsed?.lastUsedAt ?? 0)) {
      lastUsed = { id: action.id, lastUsedAt: action.lastUsedAt };
    }
  }
  return lastUsed?.id;
}

/** Whether this installation shares an SSH host's workspaces with other installations; on by default. */
function syncsSshWorkspaces(hostId: string): boolean {
  return !configService.get().workspaceSyncDisabledHostIds?.includes(hostId);
}

/** The workspace's agent commands, for the host's CLI to start new workspaces while Komla is disconnected. */
function sshWorkspaceLaunch(workspace: Workspace): SshWorkspaceLaunch | undefined {
  const preset = agentPresetService.getPresetForWorkspace?.(workspace.presetId);
  const template =
    preset && agentPresetService.resolvePosixPromptTemplate?.(preset, workspace.launchModeId);
  if (!template) return undefined;
  const continueCommand = agentPresetService.resolvePosixContinueCommand?.(
    preset,
    workspace.launchModeId
  );
  return { agentName: preset.name, ...template, ...(continueCommand ? { continueCommand } : {}) };
}

worktreeWatcherService.onObservation = (snapshot) =>
  workspaceStatusService.change({ kind: 'snapshot-observed', snapshot });

// Debounce delay for workspace persistence
const SAVE_DEBOUNCE_MS = 500;

const AUTO_BRANCH_RANDOM_RETRIES = 4;
const AUTO_BRANCH_MAX_ATTEMPTS = 25;
const MAX_UTILITY_TITLE_LENGTH = 50;
const MAX_PROMPT_SUBMITS_PER_WORKSPACE = 1_000;
// How long workspace.created hooks wait for a new workspace's name before running without it.
const CREATED_HOOK_NAMING_WAIT_MS = 15_000;
// Agent hooks arrive with every tool call; a minute is precise enough for Recent and "x ago".
const AGENT_TURN_ACTIVITY_INTERVAL_MS = 60 * 1000;
// The first prompts usually state the workspace's task, so history limits keep them.
const PINNED_FIRST_PROMPT_SUBMITS = 3;
const AUTO_RENAME_PROMPT_SUBMIT_THRESHOLD = 20;
const AUTO_RENAME_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MAX_STORED_PROMPT_CHARS = 32_000;
// Final replies are mostly a short summary; their start and end say what the turn was about.
const MAX_STORED_AGENT_REPLY_CHARS = 2_000;
const MAX_STORED_PROMPT_HISTORY_CHARS = 256_000;
const MAX_RENAME_PROMPT_CONTEXT_CHARS = 256_000;

/**
 * The base branch as the workspace's target, absent a project target. A branch only the
 * host has can't be one, since target checks compare with origin's copy.
 */
function sshWorkspaceTargetBranch(params: CreateWorkspaceParams): string | undefined {
  return params.baseBranchOnHost ? undefined : normalizeSshTargetBranch(params.baseBranch);
}

function resolveSshTargetBranch(
  project: Project | undefined,
  workspaceBaseBranch: string | undefined
): string | undefined {
  return (
    normalizeSshTargetBranch(project?.baseBranch) || normalizeSshTargetBranch(workspaceBaseBranch)
  );
}

/** Branches an SSH host fetches from origin to start this workspace. */
async function sshBranchesToPublish(
  params: CreateWorkspaceParams,
  project: Project,
  repoPath: string
): Promise<string[]> {
  const targetBranch =
    resolveSshTargetBranch(project, normalizeSshTargetBranch(params.baseBranch)) ||
    (await gitService.getTargetBranch(repoPath).catch(() => undefined));
  const existingBranch = params.checkoutExistingBranch
    ? normalizeSshTargetBranch(params.branchName)
    : undefined;
  const branches = [targetBranch, normalizeSshTargetBranch(params.baseBranch), existingBranch];
  return [...new Set(branches.filter((branch): branch is string => !!branch))];
}

const RENAME_PROMPT_CONTEXT_SEPARATOR = '\n';
const PROMPT_TRUNCATED_MARKER = '\n\n[...PROMPT_TRUNCATED...]\n\n';
const INLINE_IMAGE_DATA_REGEX = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;
const TERMINAL_ID_RANDOM_BYTES = 9;

const WORKSPACE_VERSION = 1;
const WORKSPACE_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

// What we persist (including recoverable SSH terminal identities). A type alias, not an
// interface, so it converts to and from the Record that migrate() works on.
type PersistedWorkspace = {
  _version?: number;
  id: string;
  name: string;
  customName?: string;
  customDescription?: string;
  customNameSource?: WorkspaceCustomNameSource;
  customNameGeneratedAt?: number;
  promptSubmitsSinceCustomNameGeneration?: number;
  workingDirectory: string;
  backend?: WorkspaceBackend;
  lastKnownGitStatus?: WorkspaceGitStatusSnapshot;
  branchName?: string;
  isWorktree: boolean;
  projectId: string | null;
  repoName?: string;
  baseBranch?: string;
  branchedFrom?: string;
  primaryTerminalId?: string;
  lastDynamicTitle?: string;
  terminals?: Array<{
    id: string;
    name: string;
    dynamicTitle?: string;
    createdAt: number;
    layoutHint?: Terminal['layoutHint'];
    executionLocation?: TerminalExecutionLocation;
    remoteSessionActive?: boolean;
    attention?: WorkspaceAttention;
    activeAgentSources?: Record<string, number>;
    lastAcceptedHookDeliveryId?: string;
  }>;
  terminalLayout?: Workspace['terminalLayout'];
  windowId: string | null;
  categoryId: string | null;
  createdAt: number;
  lastActivityAt: number;
  lastStoppedAt?: number;
  order: number;
  unread?: Workspace['unread'];
  pinned?: boolean;
  tag?: string;
  tagSource?: Workspace['tagSource'];
  tagTooltip?: string;
  pullRequestState?: Workspace['pullRequestState'];
  snoozedUntil?: number;
  wakesOnNotification?: boolean;
  needsAttention?: boolean;
  attention?: WorkspaceAttention;
  status?: WorkspaceStatus;
  trashedAt?: number;
  promptSubmits?: Workspace['promptSubmits'];
  provisioning?: boolean;
  provisionStatus?: string;
  provisioningRepoPath?: string;
  provisioningBranchCreated?: boolean;
  provisioningWorktreeCreated?: boolean;
  presetId?: string | null;
  launchModeId?: string | null;
  reasoningLevelId?: string | null;
  linkedWorkspaceIds?: string[];
  browserPanes?: WorkspaceBrowserPane[];
  recentLinks?: WorkspaceRecentLink[];
  virtualDesktops?: WorkspaceVirtualDesktop[];
  color?: string | null;
  defaultActionId?: string;
  paneDefaultActionId?: string;
};

function normalizePersistedAttention(value: unknown): WorkspaceAttention | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const attention = value as Partial<WorkspaceAttention>;
  if (
    !['input-required', 'turn-complete', 'error', 'idle', 'generic'].includes(
      attention.kind ?? ''
    ) ||
    typeof attention.source !== 'string' ||
    typeof attention.updatedAt !== 'number' ||
    !Number.isFinite(attention.updatedAt)
  ) {
    return undefined;
  }
  return {
    kind: attention.kind as WorkspaceAttention['kind'],
    source: attention.source,
    updatedAt: attention.updatedAt,
    ...(typeof attention.title === 'string' ? { title: attention.title } : {}),
    ...(typeof attention.body === 'string' ? { body: attention.body } : {}),
    ...(typeof attention.color === 'string' ? { color: attention.color } : {}),
    ...(typeof attention.badge === 'string' ? { badge: attention.badge } : {}),
    ...(typeof attention.icon === 'string' ? { icon: attention.icon } : {}),
    ...(typeof attention.iconColor === 'string' ? { iconColor: attention.iconColor } : {}),
    ...(typeof attention.message === 'string' ? { message: attention.message } : {}),
    ...(typeof attention.terminalId === 'string' ? { terminalId: attention.terminalId } : {}),
    ...(attention.seen === true ? { seen: true } : {}),
  };
}

function normalizePersistedSshTerminals(value: PersistedWorkspace['terminals']): Terminal[] {
  if (!Array.isArray(value)) return [];
  const terminals: Terminal[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      isLocalTerminalLocation(item.executionLocation) ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) ||
      seen.has(item.id) ||
      typeof item.name !== 'string' ||
      typeof item.createdAt !== 'number'
    ) {
      continue;
    }
    seen.add(item.id);
    terminals.push({
      id: item.id,
      name: item.name,
      status: 'stopped',
      createdAt: item.createdAt,
      dynamicTitle: typeof item.dynamicTitle === 'string' ? item.dynamicTitle : undefined,
      layoutHint:
        item.layoutHint === 'tab' ||
        item.layoutHint === 'split-right' ||
        item.layoutHint === 'split-bottom'
          ? item.layoutHint
          : undefined,
      executionLocation: 'workspace',
      ...encodeTerminalExecution({ kind: 'restored', persistedActive: item.remoteSessionActive }),
      attention: normalizePersistedAttention(item.attention),
      lastAcceptedHookDeliveryId:
        typeof item.lastAcceptedHookDeliveryId === 'string'
          ? item.lastAcceptedHookDeliveryId
          : undefined,
    });
  }
  return terminals;
}

function normalizePersistedActiveAgentSources(
  value: unknown
): Map<WorkspaceAttentionSource, number> {
  const sources = new Map<WorkspaceAttentionSource, number>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sources;
  for (const [source, count] of Object.entries(value)) {
    if (
      source.length < 1 ||
      source.length > 64 ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      continue;
    }
    sources.set(source, count);
  }
  return sources;
}

const GIT_FILE_STATUSES = new Set(['added', 'modified', 'deleted', 'renamed', 'untracked']);

function hasFieldsOfType(
  value: unknown,
  keys: readonly string[],
  type: 'boolean' | 'number' | 'string'
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    keys.every((key) => typeof (value as Record<string, unknown>)[key] === type)
  );
}

function normalizeLastKnownGitStatus(value: unknown): WorkspaceGitStatusSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = value as Record<string, unknown>;
  const branchNumberKeys = [
    'behindTargetBranch',
    'aheadTargetBranch',
    'unpushedCommits',
    'behindRemote',
    'targetBranchAheadRemote',
    'targetBranchBehindRemote',
  ] as const;
  const branch = snapshot['branch'];
  if (
    typeof snapshot['updatedAt'] !== 'number' ||
    (snapshot['lastConfirmedAt'] !== undefined &&
      snapshot['lastConfirmedAt'] !== null &&
      (typeof snapshot['lastConfirmedAt'] !== 'number' ||
        !Number.isFinite(snapshot['lastConfirmedAt']))) ||
    !hasFieldsOfType(branch, branchNumberKeys, 'number') ||
    !hasFieldsOfType(branch, ['mainBranch', 'defaultBranch', 'currentBranch'], 'string') ||
    !hasFieldsOfType(branch, ['hasRemote', 'hasOriginRemote', 'targetBranchHasRemote'], 'boolean')
  ) {
    return undefined;
  }

  const diff = snapshot['diff'] as Record<string, unknown> | undefined;
  const files = diff?.['files'];
  const summary = diff?.['summary'];
  if (
    !Array.isArray(files) ||
    !hasFieldsOfType(summary, ['additions', 'deletions', 'filesChanged'], 'number') ||
    !files.every(
      (file) =>
        hasFieldsOfType(file, ['path', 'status'], 'string') &&
        GIT_FILE_STATUSES.has(file['status'] as string) &&
        hasFieldsOfType(file, ['staged'], 'boolean') &&
        hasFieldsOfType(file, ['additions', 'deletions'], 'number') &&
        (file['originalPath'] === undefined || typeof file['originalPath'] === 'string') &&
        (file['isDirectory'] === undefined || typeof file['isDirectory'] === 'boolean')
    )
  ) {
    return undefined;
  }

  return value as WorkspaceGitStatusSnapshot;
}

function isValidPersistedWorkspace(obj: unknown): obj is PersistedWorkspace {
  if (typeof obj !== 'object' || obj === null) return false;
  const w = obj as Record<string, unknown>;
  return (
    typeof w['id'] === 'string' &&
    typeof w['name'] === 'string' &&
    typeof w['workingDirectory'] === 'string' &&
    typeof w['isWorktree'] === 'boolean' &&
    (typeof w['projectId'] === 'string' || w['projectId'] === null) &&
    (typeof w['windowId'] === 'string' || w['windowId'] === null) &&
    (typeof w['categoryId'] === 'string' || w['categoryId'] === null) &&
    typeof w['createdAt'] === 'number' &&
    typeof w['lastActivityAt'] === 'number' &&
    typeof w['order'] === 'number'
  );
}

function normalizeWorkspaceBackend(value: unknown): WorkspaceBackend | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const backend = value as Record<string, unknown>;
  if (backend.kind === 'local') return { kind: 'local' };
  if (
    backend.kind === 'ssh' &&
    typeof backend.hostId === 'string' &&
    typeof backend.remoteDirectory === 'string' &&
    typeof backend.remoteRepoPath === 'string' &&
    typeof backend.remoteProjectRoot === 'string' &&
    typeof backend.gitUrl === 'string'
  ) {
    const baseBranch =
      typeof backend.baseBranch === 'string'
        ? normalizeSshTargetBranch(backend.baseBranch)
        : undefined;
    return {
      kind: 'ssh',
      hostId: backend.hostId,
      remoteDirectory: backend.remoteDirectory,
      remoteRepoPath: backend.remoteRepoPath,
      remoteProjectRoot: backend.remoteProjectRoot,
      gitUrl: backend.gitUrl,
      ...(typeof backend.projectId === 'string' ? { projectId: backend.projectId } : {}),
      ...(typeof backend.projectName === 'string' ? { projectName: backend.projectName } : {}),
      ...(typeof backend.branchName === 'string' ? { branchName: backend.branchName } : {}),
      ...(backend.checkoutExistingBranch === true ? { checkoutExistingBranch: true } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(typeof backend.defaultBranch === 'string'
        ? { defaultBranch: backend.defaultBranch }
        : {}),
      ...(typeof backend.startPoint === 'string' ? { startPoint: backend.startPoint } : {}),
    };
  }
  return undefined;
}

function normalizePromptSubmits(value: unknown): Workspace['promptSubmits'] | undefined {
  if (!Array.isArray(value)) return undefined;

  const prompts = value
    .filter(
      (
        entry
      ): entry is { prompt: string; submittedAt: number; terminalId?: unknown; reply?: unknown } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['prompt'] === 'string' &&
        typeof (entry as Record<string, unknown>)['submittedAt'] === 'number'
    )
    .map((entry) => ({
      prompt: truncatePromptForStorage(entry.prompt),
      submittedAt: entry.submittedAt,
      ...(typeof entry.terminalId === 'string' && { terminalId: entry.terminalId }),
      ...(typeof entry.reply === 'string' && { reply: truncateReplyForStorage(entry.reply) }),
    }));

  return compactPromptSubmits(prompts);
}

function normalizeCustomNameSource(value: unknown): WorkspaceCustomNameSource | undefined {
  return value === 'generated' || value === 'manual' ? value : undefined;
}

function wrapRenamePrompt(prompt: string): string {
  return `<prompt>\n${prompt}\n</prompt>`;
}

function wrapRenameReply(reply: string): string {
  return `<agent_reply>\n${reply}\n</agent_reply>`;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= PROMPT_TRUNCATED_MARKER.length) return value.slice(0, maxChars);

  const remaining = maxChars - PROMPT_TRUNCATED_MARKER.length;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  return `${value.slice(0, headLength)}${PROMPT_TRUNCATED_MARKER}${value.slice(-tailLength)}`;
}

function truncatePromptForStorage(prompt: string): string {
  return truncateMiddle(omitInlineImageData(prompt), MAX_STORED_PROMPT_CHARS);
}

function truncateReplyForStorage(reply: string): string {
  return truncateMiddle(omitInlineImageData(reply), MAX_STORED_AGENT_REPLY_CHARS);
}

function promptSubmitLength(entry: WorkspacePromptSubmit): number {
  return entry.prompt.length + (entry.reply?.length ?? 0);
}

function omitInlineImageData(prompt: string): string {
  return prompt.replace(INLINE_IMAGE_DATA_REGEX, '[IMAGE_DATA_OMITTED]');
}

function compactPromptSubmits(
  promptSubmits: NonNullable<Workspace['promptSubmits']>
): Workspace['promptSubmits'] | undefined {
  const compacted =
    promptSubmits.length > MAX_PROMPT_SUBMITS_PER_WORKSPACE
      ? [
          ...promptSubmits.slice(0, PINNED_FIRST_PROMPT_SUBMITS),
          ...promptSubmits.slice(PINNED_FIRST_PROMPT_SUBMITS - MAX_PROMPT_SUBMITS_PER_WORKSPACE),
        ]
      : [...promptSubmits];

  let totalLength = compacted.reduce((total, entry) => total + promptSubmitLength(entry), 0);
  while (compacted.length > 1 && totalLength > MAX_STORED_PROMPT_HISTORY_CHARS) {
    // Drop the oldest unpinned prompt, but never the newest one to keep a pinned one.
    const removeIndex =
      compacted.length > PINNED_FIRST_PROMPT_SUBMITS + 1 ? PINNED_FIRST_PROMPT_SUBMITS : 0;
    const [removed] = compacted.splice(removeIndex, 1);
    totalLength -= removed ? promptSubmitLength(removed) : 0;
  }

  if (compacted.length === 1 && totalLength > MAX_STORED_PROMPT_HISTORY_CHARS) {
    compacted[0] = {
      ...compacted[0],
      prompt: truncateMiddle(compacted[0].prompt, MAX_STORED_PROMPT_HISTORY_CHARS),
    };
  }

  return compacted.length > 0 ? compacted : undefined;
}

function isLocalTerminalLocation(location: TerminalExecutionLocation | undefined): boolean {
  return isLocalTerminalExecutionLocation(location);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// Records the worktree start point as workspace metadata only when it differs
// from the project's default — used for the "Branched from <branch>" badge on
// the workspace card. Has no effect on diffs or PR target (those use baseBranch).
function computeBranchedFrom(params: CreateWorkspaceParams, project: Project): string | undefined {
  if (!params.baseBranch) return undefined;
  if (params.baseBranch === project.baseBranch) return undefined;
  return params.baseBranch;
}

class WorkspaceService {
  private workspacesPath: string;
  private workspaces: Map<string, Workspace> = new Map();
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private pendingSave = false;
  private writePromise: Promise<void> = Promise.resolve();
  private persistenceTransactionActive = false;
  private readonly persistenceTransactionWaiters: Array<() => void> = [];
  // SSH workspaces being created or started; only they count toward the free plan's limit.
  private pendingRemoteCreates = 0;
  private pendingRemoteStarts = 0;
  // The workspaces each window shows a browser or note pane of, by window id.
  private paneSurfaceWorkspaceIdsByWindow = new Map<string, ReadonlySet<string>>();
  private deferredTerminalLaunches = new Map<
    string,
    { token: symbol; mayHaveRemoteSession: boolean; onCancel: () => void }
  >();
  private autoNamingControllers: Map<string, AbortController> = new Map();
  private branchNamingControllers: Map<string, AbortController> = new Map();
  private provisioningControllers: Map<string, AbortController> = new Map();
  private provisioningCancelled: Set<string> = new Set();
  private deletingWorkspaceIds = new Set<string>();
  readonly sshSync: SshWorkspaceSync;
  private readonly sshHostSyncedListeners = new Set<(hostId: string) => void>();
  // Origin URL per local repository, looked up once per session to match SSH workspaces to projects.
  private readonly gitRemoteUrls = new Map<string, Promise<string | null>>();
  readonly attention: TerminalAttention;
  private readonly snoozeAlarm = new WorkspaceSnoozeAlarm({
    workspaces: () => this.workspaces.values(),
    woke: (workspaces) => {
      this.saveWorkspaces();
      for (const workspace of workspaces) this.broadcastWorkspaceUpdate(workspace);
      this.attention.workspaceStatusChanged();
    },
  });
  private pendingTerminalHookDeliveryIds = new Set<string>();
  private workspaceUpdateListeners = new Set<(workspace: Workspace) => void>();
  private attentionListeners = new Set<(event: WorkspaceAttentionEvent) => void>();
  private beginDeferredTerminalLaunch(
    terminalId: string,
    mayHaveRemoteSession: boolean,
    onCancel: () => void
  ): symbol {
    this.cancelDeferredTerminalLaunch(terminalId);
    const token = Symbol(terminalId);
    this.deferredTerminalLaunches.set(terminalId, {
      token,
      mayHaveRemoteSession,
      onCancel,
    });
    return token;
  }

  private isDeferredTerminalLaunchCurrent(terminalId: string, token: symbol): boolean {
    return this.deferredTerminalLaunches.get(terminalId)?.token === token;
  }

  private finishDeferredTerminalLaunch(terminalId: string, token: symbol): void {
    if (this.isDeferredTerminalLaunchCurrent(terminalId, token)) {
      this.deferredTerminalLaunches.delete(terminalId);
    }
  }

  private cancelDeferredTerminalLaunch(
    terminalId: string
  ): { mayHaveRemoteSession: boolean } | undefined {
    const pending = this.deferredTerminalLaunches.get(terminalId);
    if (!pending) return undefined;
    this.deferredTerminalLaunches.delete(terminalId);
    pending.onCancel();
    return { mayHaveRemoteSession: pending.mayHaveRemoteSession };
  }

  private cancelDeferredWorkspaceLaunches(workspace: Workspace): Set<string> {
    const terminalsWithoutRemoteSessions = new Set<string>();
    for (const terminal of workspace.terminals) {
      const pending = this.cancelDeferredTerminalLaunch(terminal.id);
      if (pending) terminal.status = 'stopped';
      if (pending && !pending.mayHaveRemoteSession) {
        terminalsWithoutRemoteSessions.add(terminal.id);
      }
    }
    return terminalsWithoutRemoteSessions;
  }

  constructor() {
    const komlaPath = ensureKomlaBasePath();
    this.workspacesPath = join(komlaPath, 'workspaces.json');
    this.sshSync = new SshWorkspaceSync({
      host: sshWorkspaceSyncHost,
      store: {
        workspaces: () => this.workspaces.values(),
        get: (workspaceId) => this.workspaces.get(workspaceId),
        isDeleting: (workspaceId) => this.isDeleting(workspaceId),
        projectLookup: async () => {
          const projectsByRemote = await this.projectsByGitRemote();
          return (repository) =>
            this.sshRepositoryProject(repository, projectsByRemote)?.id ?? null;
        },
        add: (hostId, manifest, placement) =>
          this.addAdoptedSshWorkspace(hostId, manifest, placement),
        deleteHere: (workspaceId) =>
          this.delete(workspaceId, true, false, { skipBackendCleanup: true }),
        hostSynced: (hostId) => {
          for (const listener of this.sshHostSyncedListeners) listener(hostId);
          return this.findSshSessionsOnHost(hostId).catch((error) => {
            logger.warn('Could not check which SSH workspace sessions run on their host', {
              hostId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
        applyMerged: (workspaceId, merged) => this.applyMergedSshWorkspace(workspaceId, merged),
        changeStatus: (workspaceId, status) =>
          this.applySshWorkspaceStatusFromOtherDevice(workspaceId, status),
        removeTerminal: (workspaceId, terminalId) => this.removeTerminal(workspaceId, terminalId),
        save: () => this.saveWorkspaces(),
        changed: (workspaceId) => {
          const workspace = this.workspaces.get(workspaceId);
          if (workspace) this.broadcastWorkspaceUpdate(workspace);
        },
        layoutChanged: (workspaceId, { addedTerminalIds, arranged }) => {
          for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            window.webContents.send(IPC.WORKSPACE_LAYOUT_CHANGED_ON_OTHER_DEVICE, {
              workspaceId,
              terminalIds: addedTerminalIds,
              arranged,
            });
          }
        },
        markMissing: (workspaceId) => this.markSshWorkspaceRemoved(workspaceId),
        markFound: (workspaceId) => this.markSshWorkspaceFound(workspaceId),
        removeDeletedElsewhere: (workspaceId) =>
          this.removeSshWorkspaceDeletedElsewhere(workspaceId),
      },
      now: () => Date.now(),
      deviceId: () => configService.getWorkspaceSyncDeviceId(),
      syncsWith: (hostId) => syncsSshWorkspaces(hostId),
      launch: sshWorkspaceLaunch,
      inUse: () => BrowserWindow.getFocusedWindow() !== null,
      hostCopies: {
        read: () => {
          const path = sshWorkspaceSyncPath();
          return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
        },
        write: (content) => writeFileAtomic(sshWorkspaceSyncPath(), content),
      },
    });
    this.attention = new TerminalAttention({
      store: {
        workspaces: () => this.workspaces.values(),
        get: (workspaceId) => this.workspaces.get(workspaceId),
        broadcast: (workspace) => this.broadcastWorkspaceUpdate(workspace),
        save: () => this.saveWorkspaces(),
        saveNow: (workspaceId) => this.persistSshAttention(workspaceId),
      },
      windows: {
        ...electronAttentionWindows,
        attentionRaised: (raised) => {
          this.wakeSnoozedForAttention(raised.workspaceId, raised.attention);
          // Decided here, after the wake: the windows have the workspace's new snooze already.
          const workspace = this.workspaces.get(raised.workspaceId);
          const event = { ...raised, snoozed: !!workspace && isWorkspaceSnoozed(workspace) };
          electronAttentionWindows.attentionRaised(event);
          publishAttentionHookEvent(event);
          this.notifyListeners(this.attentionListeners, event);
        },
      },
      relay: {
        interrupted: (workspace, terminalId, sources) =>
          this.relayInterrupt(workspace, terminalId, sources),
      },
      promptSubmitted: (workspaceId, prompt, terminalId) => {
        this.recordPromptSubmit(workspaceId, prompt, terminalId);
        publishHookEvent({
          event: 'agent.prompt',
          workspaceId,
          ...(terminalId && { terminalId }),
          message: prompt,
        });
      },
      agentReplied: (workspaceId, reply, terminalId) =>
        this.recordAgentReply(workspaceId, reply, terminalId),
      turnActivity: (workspaceId) => this.recordAgentTurnActivity(workspaceId),
      milestone: (name, properties) => telemetryService.sendIntegrationMilestone(name, properties),
    });
    onTerminalTitle((terminalId, title) => {
      if (title === null) this.attention.attachmentEnded(terminalId);
      else this.attention.titleChanged(terminalId, title);
    });
    onTerminalProgramStatus((terminalId, status) =>
      this.attention.programStatusChanged(terminalId, status)
    );
    onTerminalOscNotification((alert) => this.attention.alertRaised(alert));
    configureSshWorkspaceProvisioning({
      listWorkspaces: () => Array.from(this.workspaces.values()),
      saveWorkspaces: () => this.saveWorkspaces(),
      persistWorkspaces: () => this.saveWorkspacesImmediateChecked(),
      broadcastWorkspaceUpdate: (workspace) => this.broadcastWorkspaceUpdate(workspace),
      maxAttempts: AUTO_BRANCH_MAX_ATTEMPTS,
      nextBranchName: (base, prefix, attempt, exact) =>
        this.createAutoBranchCandidate(base, prefix, attempt, exact),
      workspaceName: (branch, prefix) =>
        branchSuffixToName(this.deriveBranchSuffixForName(branch, prefix)),
      branchConflictError: (branch, workspace) => this.createBranchConflictError(branch, workspace),
      installCompanion: (backend) =>
        remoteCompanionService.ensureInstalled(
          sshWorkspaceService.getHost(backend.hostId),
          pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot))
        ),
      ssh: sshWorkspaceService,
    });
    gitService.setManagedWorktreeLookup((path) => this.managedWorktree(path));
    this.loadWorkspaces();
    this.snoozeAlarm.check({ startup: true });
    configureWorkspaceSetup({
      getWorkspace: (workspaceId) => this.workspaces.get(workspaceId),
      broadcastWorkspaceUpdate: (workspace) => this.broadcastWorkspaceUpdate(workspace),
      addTerminal: (...args) => this.addTerminal(...args),
      resolvePreset: (presetId, workspace) => this.resolvePreset(presetId, workspace),
      resolveAgentCommand: (preset, prompt, launchModeId, reasoningLevelId) =>
        this.resolveAgentCommand(preset, prompt, launchModeId, undefined, reasoningLevelId),
      locations: executionLocations,
      prepareLocalMirror: (workspaceId) => this.prepareLocalMirror(workspaceId),
      projects: projectService,
      actions: actionService,
      presets: agentPresetService,
      hosts: sshHostService,
      ssh: sshWorkspaceService,
      background: backgroundProcessService,
      notifyActionRunFinished: (workspace, run) =>
        this.notifyWorkspace(workspace, backgroundActionNotification(run)),
    });
    configureWorkspaceStatus({
      getWorkspace: (workspaceId) => this.workspaces.get(workspaceId),
      listWorkspaces: () => Array.from(this.workspaces.values()),
      saveWorkspaces: () => this.saveWorkspaces(),
      broadcastWorkspaceUpdate: (workspace) => this.broadcastWorkspaceUpdate(workspace),
      publishWorkingTreeChange: (workspaceId, changeTypes, activityAt, remoteChange) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            // SSH workspaces push no file or git status here; the observation carries it.
            window.webContents.send(
              IPC.GIT_STATUS_WORKTREE_CHANGED,
              workspaceId,
              changeTypes,
              activityAt,
              undefined,
              undefined,
              remoteChange
            );
          }
        }
      },
      requestLocalCopySync: (workspaceId) => this.requestSshLocalMirrorSync(workspaceId),
      isLocalCopyCurrent: (workspaceId) => localMirrorService.isCurrent(workspaceId),
      getSshSnapshot: (backend, targetBranch) => sshWorkspaceGit.getSnapshot(backend, targetBranch),
      restartLocalWatcher: (workspaceId, workingDirectory) =>
        worktreeWatcherService.restartWatching(workspaceId, workingDirectory),
      now: () => Date.now(),
    });
    void workspaceStatusService.change({ kind: 'restore' });
    configureRemoteWorkspaceObservation({
      listWorkspaces: () => Array.from(this.workspaces.values()),
      waitForKomlaPort: () => httpServerService.waitForActualPort(),
      ensureKomlaDataTunnel: (hostId, localPort, onConnected) =>
        sshPortForwardService.ensureKomlaDataTunnel(hostId, localPort, onConnected),
      stopKomlaDataTunnelsExcept: (activeHostIds) =>
        sshPortForwardService.stopKomlaDataTunnelsExcept(activeHostIds),
      getHost: (hostId) => sshWorkspaceService.getHost(hostId),
      ensureRemoteNotificationScript: (backend) =>
        sshWorkspaceService.ensureRemoteNotificationScript(backend),
      ensureRemoteCompanion: (host, options) =>
        remoteCompanionService.ensureRunning(host, {
          ...options,
          turnedOffCommands: turnedOffQueuedCommands(configService.get()),
        }),
      invalidateRemoteCompanion: (hostId) => remoteCompanionService.invalidateHost(hostId),
      companionInstallationId: (hostId) => sshCompanionInstallationId(hostId),
      resolveCompanionRuntime: (remoteBasePath, installationId) =>
        resolveRemoteCompanionRuntime(remoteBasePath, installationId),
      markRemoteDisconnected: (workspaceIds) =>
        workspaceStatusService.change({ kind: 'remote-source-unreachable', workspaceIds }),
      refreshWorkspaceStatus: (workspaceId, reason) =>
        workspaceStatusService.change({ kind: 'refresh-requested', workspaceId, reason }),
      isWorkspaceDeleting: (workspaceId) => this.deletingWorkspaceIds.has(workspaceId),
      hostConnected: (hostId) => {
        this.attention.hostConnected(hostId);
        void this.sshSync.syncSoon(hostId, { now: true });
        remoteControlHostAccessService.hostConnected(hostId);
      },
    });
    configureHostLaunch({
      projectIdsOnHost: (hostId) =>
        new Set(
          Array.from(this.workspaces.values()).flatMap((workspace) =>
            workspace.backend?.kind === 'ssh' &&
            workspace.backend.hostId === hostId &&
            workspace.projectId
              ? [workspace.projectId]
              : []
          )
        ),
    });
    configureManagedRemoteTerminalLifecycle({
      findTerminal: (terminalId) => {
        const workspace = this.findWorkspaceByTerminalId(terminalId);
        const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
        if (
          !workspace ||
          !terminal ||
          !isSshWorkspace(workspace) ||
          !executionLocations.managesSession(workspace, terminal.executionLocation)
        ) {
          return undefined;
        }
        return {
          workspaceId: workspace.id,
          backend: workspace.backend,
          terminal,
          companion: remoteWorkspaceObservationService.companionForWorkspace(workspace.backend),
        };
      },
      findWorkspace: (workspaceId) => {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace || !isSshWorkspace(workspace)) return undefined;
        return {
          workspaceId,
          backend: workspace.backend,
          terminals: workspace.terminals.filter((terminal) =>
            executionLocations.managesSession(workspace, terminal.executionLocation)
          ),
        };
      },
      changed: (workspaceId) => {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace) return;
        this.saveWorkspaces();
        try {
          this.broadcastWorkspaceUpdate(workspace);
        } catch (error) {
          logger.warn('Failed to publish Managed Remote Terminal lifecycle state', {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      prepareObservationBestEffort: async (workspaceId) => {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace || !isSshWorkspace(workspace)) return;
        await remoteWorkspaceObservationService.reconcile();
      },
      prepareObservationInBackground: (workspaceId) => {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace || !isSshWorkspace(workspace)) return;
        void remoteWorkspaceObservationService.reconcileAfterReconnect().catch((error) => {
          logger.debug('Could not prepare SSH observation after reconnecting', {
            workspaceId: workspace.id,
            error,
          });
        });
      },
      reconcileObservation: () => {
        void remoteWorkspaceObservationService.reconcile();
      },
    });
    // Watchers are now started lazily when git status is requested

    // Keep workspace snapshots in sync with the live PTY state. Renderers also
    // receive these events directly, but a later workspace recovery must not
    // overwrite that newer status with stale main-process metadata.
    ptyService.onStatus((terminalId, status) => {
      this.updateTerminalStatus(terminalId, status);
    });

    ptyService.onSshTerminalPoolAssignment((terminalId, assignment) => {
      sshWorkspaceService.recordTerminalPoolAssignment(terminalId, assignment);
    });

    localMirrorService.onSyncStatus((status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC.WORKSPACE_LOCAL_MIRROR_SYNC_STATUS, status);
        }
      }
    });

    // Remove stale workspaces whose directories no longer exist (e.g. crash mid-delete).
    // Snapshot IDs now so we only check workspaces that were loaded from disk,
    // not ones created after startup.
    const loadedIds = Array.from(this.workspaces.keys());
    setImmediate(() => this.cleanupStaleWorkspaces(loadedIds));

    // Clear only the aborted terminal's spinner when user sends an abort
    // signal (Ctrl-C, Ctrl-D, Esc). Other agent tabs in the workspace may
    // still be processing. Its late activity is held back, longer when the
    // agent's title confirmed the interrupt: an Esc may just have closed a menu.
    ptyService.onAbort((terminalId, confirmed) => this.attention.aborted(terminalId, confirmed));
    ptyService.onAnswerKey((terminalId) => this.attention.answerKeyPressed(terminalId));

    ptyService.onManagedRemoteTerminalSessionReplaced((terminalId) => {
      const workspace = this.findWorkspaceByTerminalId(terminalId);
      const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
      if (
        !workspace ||
        !terminal ||
        !executionLocations.managesSession(workspace, terminal.executionLocation)
      ) {
        return;
      }
      this.attention.replaced(terminalId);
      terminal.dynamicTitle = undefined;
    });

    // Clear only the exited terminal's spinner.
    ptyService.onExit((terminalId, exit) => {
      sshWorkspaceService.releaseTerminalPoolAssignment(terminalId);
      const workspace = this.findWorkspaceByTerminalId(terminalId);
      if (workspace) {
        const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
        if (terminal && executionLocations.managesSession(workspace, terminal.executionLocation)) {
          // Set before the lifecycle publishes the exit, so the pane says why along with it.
          terminal.connectionError = exit && sshConnectionFailure(exit.exitCode, exit.output);
          if (isResumable(workspace, terminal)) {
            void managedRemoteTerminalLifecycleService.attachmentExited(terminalId).then(() => {
              if (sessionEndedHere(workspace, terminal)) this.attention.ended(terminalId);
            });
          } else {
            this.attention.ended(terminalId);
            void managedRemoteTerminalLifecycleService.attachmentExited(terminalId);
          }
        } else {
          this.attention.ended(terminalId);
        }
      }
    });
  }

  private generateTerminalId(): string {
    let terminalId: string;
    do {
      terminalId = randomBytes(TERMINAL_ID_RANDOM_BYTES).toString('base64url');
    } while (this.findWorkspaceByTerminalId(terminalId));
    return terminalId;
  }

  private async cleanupStaleWorkspaces(ids: string[]): Promise<void> {
    let changed = false;
    for (const id of ids) {
      const ws = this.workspaces.get(id);
      if (!ws) continue;

      if (ws.provisioning && isSshWorkspace(ws)) {
        if ((await sshWorkspaceProvisioningService.recover(ws, 'interrupted')) === 'remove') {
          this.workspaces.delete(id);
          this.attention.workspaceDeleted(id);
        }
        changed = true;
        continue;
      }

      // Remove workspaces that were mid-provisioning when app quit. If a worktree
      // already exists, delete it before dropping the orphaned workspace record.
      if (ws.provisioning) {
        if (ws.workingDirectory && ws.provisioningRepoPath && existsSync(ws.workingDirectory)) {
          try {
            await gitService.deleteWorktree(ws.provisioningRepoPath, ws.workingDirectory, true, {
              deleteBranch: ws.provisioningBranchCreated === true,
              branchName: ws.branchName,
            });
          } catch (error) {
            logger.warn(`Failed to clean up stale provisioning workspace ${id}:`, error);
          }
        }
        await this.unlinkStaleWorkspace(id, ws);
        logger.info(`Removing stale provisioning workspace ${id}`, { name: ws.name });
        this.workspaces.delete(id);
        this.attention.workspaceDeleted(id);
        changed = true;
        continue;
      }
      if (isSshWorkspace(ws)) continue;
      if (ws.isWorktree && !existsSync(ws.workingDirectory)) {
        await this.unlinkStaleWorkspace(id, ws);
        logger.info(`Removing stale workspace ${id} (directory missing)`, { name: ws.name });
        this.workspaces.delete(id);
        this.attention.workspaceDeleted(id);
        this.trashNotes(id);
        changed = true;
      }
    }
    const linksChanged = await workspaceLinksService.reconcileAllFromDisk();
    if (changed || linksChanged) {
      await this.saveWorkspacesImmediate();
      this.broadcastWorkspacesChanged();
    }
  }

  // When the parent folder is gone too (say, an unmounted drive), git can't match the path to
  // its worktree record, and deleteWorktree's fallback prune would drop every worktree there.
  private canCleanUpMissingWorktree(worktreePath: string): boolean {
    return existsSync(dirname(worktreePath));
  }

  private async unlinkStaleWorkspace(id: string, _workspace: Workspace): Promise<void> {
    // Run unconditionally — stale on-disk symlinks pointing at this workspace
    // can exist even when its own metadata is empty.
    try {
      await workspaceLinksService.unlinkAll(id);
    } catch (error) {
      logger.warn(`Failed to unlink stale workspace ${id}:`, error);
    }
  }

  /**
   * Ensure a file watcher is running for a workspace.
   * Called lazily when git status is requested for the workspace.
   * This improves startup time by not starting all watchers upfront.
   */
  ensureWatcherStarted(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (
      !workspace ||
      workspace.status !== 'active' ||
      workspace.lastStoppedAt ||
      isSshWorkspace(workspace)
    ) {
      return;
    }

    // Only start if not already watching
    if (!worktreeWatcherService.isWatching(workspaceId)) {
      worktreeWatcherService.startWatching(workspaceId, workspace.workingDirectory).catch((err) => {
        logger.error(`Failed to start watcher for workspace ${workspaceId}:`, err);
      });
    }
  }

  private getSshWorkspaceMode(workspace: Workspace) {
    const project = workspace.projectId ? projectService.get(workspace.projectId) : undefined;
    return resolveSshWorkspaceMode(
      configService.get().defaultSshWorkspaceMode,
      project?.sshWorkspaceMode
    );
  }

  async prepareLocalMirror(workspaceId: string): Promise<string> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) {
      throw new Error('Local copies are only available for SSH workspaces');
    }
    return localMirrorService.prepare(workspace.id, workspace.backend);
  }

  async initializeLocalMirror(workspaceId: string): Promise<string> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) {
      throw new Error('Local copies are only available for SSH workspaces');
    }
    return localMirrorService.initialize(workspace.id, workspace.backend);
  }

  private requestSshLocalMirrorSync(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (
      workspace &&
      isSshWorkspace(workspace) &&
      localMirrorService.hasMirror(workspace.id, workspace.backend)
    ) {
      localMirrorService.requestSync(workspace.id, workspace.backend);
    }
  }

  retryLocalMirrorSync(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) {
      throw new Error('Local copies are only available for SSH workspaces');
    }
    localMirrorService.requestSync(workspace.id, workspace.backend, 'retry');
  }

  private loadWorkspaces(): void {
    try {
      const workspacesList = this.readPersistedWorkspaces();
      if (workspacesList === null) return;

      for (const rawPersisted of workspacesList) {
        const { workspace, agentSources } = this.hydrateWorkspace(rawPersisted);
        this.workspaces.set(workspace.id, workspace);
        this.attention.restored(workspace, agentSources);
      }
      // Give workspaces that share a position their own; dragging between them does nothing.
      const ordered = [...this.workspaces.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      ordered.forEach((workspace, index) => (workspace.order = index));
      if (this.moveFoldersIntoProjects()) this.saveWorkspaces();
      this.sshSync.restored(this.workspaces.values());

      this.registerBaseBranches();
    } catch (error) {
      logger.error('Failed to load workspaces:', error);
    }
  }

  /**
   * Folders opened before folders became folder projects join one, in the color they had.
   * Ones in the Trash join when they're restored, so old folders add no projects.
   */
  private moveFoldersIntoProjects(): boolean {
    let moved = false;
    for (const workspace of this.workspaces.values()) {
      if (workspace.status === 'active' && this.moveFolderIntoProject(workspace)) moved = true;
    }
    return moved;
  }

  private moveFolderIntoProject(workspace: Workspace): boolean {
    if (workspace.projectId || workspace.isWorktree || isSshWorkspace(workspace)) return false;
    if (!workspace.workingDirectory) return false;
    try {
      const project = projectService.findOrCreateDirectoryProject(
        workspace.workingDirectory,
        workspace.color ?? undefined
      );
      workspace.projectId = project.id;
      workspace.repoName = project.name;
      return true;
    } catch {
      // A folder that's gone, such as one on an unplugged drive, joins once it's back.
      return false;
    }
  }

  private readPersistedWorkspaces(): PersistedWorkspace[] | null {
    if (!existsSync(this.workspacesPath)) return null;
    const data = readFileSync(this.workspacesPath, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      logger.error('Workspaces file is not an array, resetting to empty list');
      return null;
    }
    const workspacesList: PersistedWorkspace[] = [];
    for (const item of parsed) {
      if (isValidPersistedWorkspace(item)) {
        workspacesList.push(item);
      } else {
        logger.warn('Skipping invalid workspace entry in workspaces.json', {
          id: (item as Record<string, unknown>)?.['id'],
        });
      }
    }
    return workspacesList;
  }

  private hydrateWorkspace(rawPersisted: PersistedWorkspace): {
    workspace: Workspace;
    /** Saved spinner sources by Terminal id, restored once the workspace is in the store. */
    agentSources: Map<string, Map<WorkspaceAttentionSource, number>>;
  } {
    const persisted = migrate(
      rawPersisted,
      WORKSPACE_VERSION,
      WORKSPACE_MIGRATIONS
    ) as PersistedWorkspace;

    const backend = normalizeWorkspaceBackend(persisted.backend);
    const terminals =
      backend?.kind === 'ssh' ? normalizePersistedSshTerminals(persisted.terminals) : [];
    const persistedPrimaryTerminalId = terminals.some(
      (terminal) => terminal.id === persisted.primaryTerminalId
    )
      ? persisted.primaryTerminalId
      : terminals[0]?.id;
    const persistedAttention =
      backend?.kind === 'ssh' ? normalizePersistedAttention(persisted.attention) : undefined;
    const inTrash = persisted.status === 'trashed';
    const workspace: Workspace = {
      ...persisted,
      promptSubmits: normalizePromptSubmits(persisted.promptSubmits),
      tag:
        typeof persisted.tag === 'string'
          ? normalizeWorkspaceTagName(persisted.tag) || undefined
          : undefined,
      tagSource: persisted.tagSource === 'pull-request' ? 'pull-request' : undefined,
      tagTooltip:
        persisted.tag && typeof persisted.tagTooltip === 'string'
          ? persisted.tagTooltip.slice(0, MAX_WORKSPACE_TAG_TOOLTIP) || undefined
          : undefined,
      pullRequestState: PULL_REQUEST_TAG_STATES.includes(
        persisted.pullRequestState as PullRequestTagState
      )
        ? persisted.pullRequestState
        : undefined,
      backend,
      lastKnownGitStatus:
        backend?.kind === 'ssh'
          ? normalizeLastKnownGitStatus(persisted.lastKnownGitStatus)
          : undefined,
      attention: persistedAttention,
      customNameSource: normalizeCustomNameSource(persisted.customNameSource),
      // The IPC schema checks panes already; this scrubs a hand-edited file.
      browserPanes: normalizeBrowserPanes(persisted.browserPanes),
      recentLinks: normalizeRecentLinks(persisted.recentLinks),
      virtualDesktops: normalizeVirtualDesktops(persisted.virtualDesktops),
      // Only a workspace saved in the Trash is in it, so a hand-edited status never deletes one.
      status: inTrash ? 'trashed' : 'active',
      trashedAt: inTrash ? (persisted.trashedAt ?? Date.now()) : undefined,
      terminals,
      terminalLayout:
        backend?.kind === 'ssh'
          ? normalizePersistedTerminalLayout(
              persisted.terminalLayout,
              new Set(terminals.map((terminal) => terminal.id))
            )
          : undefined,
      primaryTerminalId: persistedPrimaryTerminalId,
      lastDynamicTitle: persisted.lastDynamicTitle,
      defaultActionId: persisted.defaultActionId,
      paneDefaultActionId: persisted.paneDefaultActionId,
      windowId: null, // Reset on startup - windows get new UUIDs each launch
      agentActive: false,
    };
    const terminalIds = new Set(terminals.map((terminal) => terminal.id));
    const agentSources = new Map<string, Map<WorkspaceAttentionSource, number>>();
    for (const terminal of persisted.terminals ?? []) {
      if (!terminalIds.has(terminal.id)) continue;
      agentSources.set(
        terminal.id,
        normalizePersistedActiveAgentSources(terminal.activeAgentSources)
      );
    }
    return { workspace, agentSources };
  }

  /** The local worktree workspace at `path`, with the repositories its worktree may come from. */
  private managedWorktree(path: string): { worktreePath: string; repoPaths: string[] } | undefined {
    const target = resolve(path);
    for (const workspace of this.workspaces.values()) {
      if (!workspace.isWorktree || !workspace.projectId || isSshWorkspace(workspace)) continue;
      if (resolve(workspace.workingDirectory) !== target) continue;
      const project = projectService.get(workspace.projectId);
      if (!project) return undefined;
      const repoPaths = [project.managedRepoPath, project.repositoryPath].filter(
        (repoPath): repoPath is string => Boolean(repoPath)
      );
      return { worktreePath: workspace.workingDirectory, repoPaths };
    }
    return undefined;
  }

  private registerBaseBranches(): void {
    // Register configured target branches with git service
    const projectIdsNeedingFallback = new Set<string>();
    for (const workspace of this.workspaces.values()) {
      if (isSshWorkspace(workspace)) continue;
      if (workspace.baseBranch) {
        gitService.registerTargetBranch(workspace.workingDirectory, workspace.baseBranch);
      } else if (workspace.projectId) {
        // For workspaces without their own baseBranch, fall back to project baseBranch
        projectIdsNeedingFallback.add(workspace.projectId);
      }
    }
    for (const projectId of projectIdsNeedingFallback) {
      this.propagateProjectBaseBranch(projectId);
    }
  }

  private saveWorkspaces(): void {
    publishRemoteWorkspaceChange();
    // Debounce saves to avoid excessive disk writes
    this.pendingSave = true;
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      void this.doSaveWorkspaces();
    }, SAVE_DEBOUNCE_MS);
  }

  // Immediate save for existing best-effort callers such as cleanup and deletion.
  saveWorkspacesImmediate(): Promise<void> {
    publishRemoteWorkspaceChange();
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    return this.doSaveWorkspaces();
  }

  // Checked immediate save for transactions that must roll back when persistence fails.
  saveWorkspacesImmediateChecked(): Promise<void> {
    publishRemoteWorkspaceChange();
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    return this.doSaveWorkspaces(true);
  }

  async withPersistenceTransaction<T>(
    transaction: (save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    return this.withPersistenceLock(() =>
      transaction(() => {
        publishRemoteWorkspaceChange();
        if (this.saveDebounceTimer) {
          clearTimeout(this.saveDebounceTimer);
          this.saveDebounceTimer = null;
        }
        return this.doSaveWorkspacesUnlocked(true);
      })
    );
  }

  // Always snapshot last-known SSH session activity before the app quits,
  // even when no other workspace metadata is waiting to be persisted.
  async dispose(): Promise<void> {
    this.sshSync.dispose();
    for (const workspace of this.workspaces.values()) {
      this.cancelDeferredWorkspaceLaunches(workspace);
      if (isSshWorkspace(workspace)) {
        managedRemoteTerminalLifecycleService.cancelPendingLaunches({
          workspaceId: workspace.id,
        });
      }
    }
    await workspaceSetupService.dispose();
    await this.saveWorkspacesImmediate();
  }

  private doSaveWorkspaces(propagateError = false): Promise<void> {
    return this.withPersistenceLock(() => this.doSaveWorkspacesUnlocked(propagateError));
  }

  private async withPersistenceLock<T>(transaction: () => Promise<T>): Promise<T> {
    if (this.persistenceTransactionActive) {
      await new Promise<void>((resolve) => this.persistenceTransactionWaiters.push(resolve));
    } else {
      this.persistenceTransactionActive = true;
    }
    try {
      return await transaction();
    } finally {
      const next = this.persistenceTransactionWaiters.shift();
      if (next) next();
      else this.persistenceTransactionActive = false;
    }
  }

  private doSaveWorkspacesUnlocked(propagateError = false): Promise<void> {
    this.pendingSave = false;
    this.sshSync.saved(this.workspaces.values());
    try {
      // Local terminals are ephemeral. SSH terminal identities are durable because
      // their managed tmux sessions can outlive the local Komla process.
      const workspacesList: PersistedWorkspace[] = Array.from(this.workspaces.values()).map((w) => {
        const persistedTerminals = isSshWorkspace(w)
          ? w.terminals.filter((terminal) => isResumable(w, terminal))
          : [];
        const persistedTerminalIds = new Set(persistedTerminals.map((terminal) => terminal.id));
        return {
          _version: WORKSPACE_VERSION,
          id: w.id,
          name: w.name,
          customName: w.customName,
          customDescription: w.customDescription,
          customNameSource: w.customNameSource,
          customNameGeneratedAt: w.customNameGeneratedAt,
          promptSubmitsSinceCustomNameGeneration: w.promptSubmitsSinceCustomNameGeneration,
          workingDirectory: w.workingDirectory,
          backend: w.backend,
          lastKnownGitStatus: isSshWorkspace(w) ? w.lastKnownGitStatus : undefined,
          branchName: w.branchName,
          isWorktree: w.isWorktree,
          projectId: w.projectId,
          repoName: w.repoName,
          baseBranch: w.baseBranch,
          branchedFrom: w.branchedFrom,
          primaryTerminalId: persistedTerminalIds.has(w.primaryTerminalId ?? '')
            ? w.primaryTerminalId
            : persistedTerminals[0]?.id,
          lastDynamicTitle: w.lastDynamicTitle,
          terminals: isSshWorkspace(w)
            ? persistedTerminals.map((terminal) => ({
                id: terminal.id,
                name: terminal.name,
                dynamicTitle: terminal.dynamicTitle,
                createdAt: terminal.createdAt,
                layoutHint: terminal.layoutHint,
                executionLocation: 'workspace',
                remoteSessionActive: persistedRemoteSessionActive(terminal),
                attention: terminal.attention,
                lastAcceptedHookDeliveryId: terminal.lastAcceptedHookDeliveryId,
                activeAgentSources: this.attention.persistedSources(w.id, terminal.id),
              }))
            : undefined,
          terminalLayout: isSshWorkspace(w)
            ? normalizePersistedTerminalLayout(w.terminalLayout, persistedTerminalIds)
            : undefined,
          windowId: w.windowId,
          categoryId: w.categoryId,
          createdAt: w.createdAt,
          lastActivityAt: w.lastActivityAt,
          lastStoppedAt: w.lastStoppedAt,
          order: w.order,
          unread: w.unread,
          pinned: w.pinned,
          tag: w.tag,
          tagSource: w.tag ? w.tagSource : undefined,
          tagTooltip: w.tag ? w.tagTooltip : undefined,
          pullRequestState: w.pullRequestState,
          snoozedUntil: w.snoozedUntil,
          wakesOnNotification: w.wakesOnNotification,
          needsAttention: isSshWorkspace(w) && w.needsAttention ? true : undefined,
          attention: isSshWorkspace(w) ? w.attention : undefined,
          status: w.status,
          trashedAt: w.trashedAt,
          promptSubmits:
            w.promptSubmits && w.promptSubmits.length > 0 ? w.promptSubmits : undefined,
          provisioning: w.provisioning || undefined,
          provisionStatus: w.provisioning ? w.provisionStatus : undefined,
          provisioningRepoPath: w.provisioningRepoPath,
          provisioningBranchCreated: w.provisioningBranchCreated,
          provisioningWorktreeCreated: w.provisioningWorktreeCreated,
          presetId: w.presetId,
          launchModeId: w.launchModeId,
          reasoningLevelId: w.reasoningLevelId || undefined,
          linkedWorkspaceIds:
            w.linkedWorkspaceIds && w.linkedWorkspaceIds.length > 0
              ? w.linkedWorkspaceIds
              : undefined,
          browserPanes: w.browserPanes && w.browserPanes.length > 0 ? w.browserPanes : undefined,
          recentLinks: w.recentLinks && w.recentLinks.length > 0 ? w.recentLinks : undefined,
          virtualDesktops:
            w.virtualDesktops && w.virtualDesktops.length > 0 ? w.virtualDesktops : undefined,
          color: w.color,
          defaultActionId: w.defaultActionId,
          paneDefaultActionId: w.paneDefaultActionId,
        };
      });

      // Serialize async writes to prevent concurrent writes racing on the same .tmp file
      const data = JSON.stringify(workspacesList, null, 2);
      const write = this.writePromise.then(() => writeFileAtomic(this.workspacesPath, data));
      this.writePromise = write.catch((error) => {
        logger.error('Failed to save workspaces:', error);
      });
      return propagateError ? write : this.writePromise;
    } catch (error) {
      logger.error('Failed to save workspaces:', error);
      return propagateError ? Promise.reject(error) : this.writePromise;
    }
  }

  /**
   * Enforce workspace limit after license revocation.
   * Stops terminals in excess running SSH workspaces (keeps all workspaces loaded).
   */
  async enforceWorkspaceLimit(): Promise<void> {
    const running = Array.from(this.workspaces.values()).filter(isRunningOnSshHost);

    if (running.length <= FREE_WORKSPACE_LIMIT) return;

    const sorted = running.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

    const toStop = sorted.slice(FREE_WORKSPACE_LIMIT);
    const failures: string[] = [];
    let stoppedCount = 0;
    for (const workspace of toStop) {
      try {
        const stopping = executionLocations.stopSessions(workspace);
        if (stopping) await stopping;
      } catch (error) {
        failures.push(`${workspace.name}: ${String(error)}`);
        logger.error('Failed to stop remote agents while enforcing workspace limit', error, {
          workspaceId: workspace.id,
        });
        continue;
      }
      executionLocations.stopAttached(workspace);
      worktreeWatcherService.stopWatching(workspace.id).catch(() => {});
      stoppedCount++;
    }

    if (toStop.length > 0) {
      this.saveWorkspaces();
      this.broadcastWorkspacesChanged();
      void remoteWorkspaceObservationService.reconcile();
    }

    logger.warn(
      `License revoked: stopped terminals in ${stoppedCount} workspace(s) — free plan limit of ${FREE_WORKSPACE_LIMIT} running SSH workspaces reached.`
    );
    if (failures.length > 0) {
      throw new Error(`Could not stop all remote agents: ${failures.join('; ')}`);
    }
  }

  private findBranchConflict(
    projectId: string,
    branchName: string,
    excludeWorkspaceId?: string
  ): Workspace | undefined {
    return Array.from(this.workspaces.values()).find(
      (workspace) =>
        workspace.isWorktree &&
        workspace.projectId === projectId &&
        workspace.branchName === branchName &&
        workspace.id !== excludeWorkspaceId
    );
  }

  /** The prefix new branches in `project` start with, the app-wide one when it has none. */
  private branchPrefix(project: Project | undefined): string {
    return resolveBranchPrefix(project, configService.get().gitDefaults);
  }

  private withBranchPrefix(branchName: string, prefix: string): string {
    if (!prefix) return branchName;
    // Case-insensitive check to prevent double-prefixing (e.g. "claude/claude/feature")
    if (branchName.toLowerCase().startsWith(prefix.toLowerCase())) {
      return `${prefix}${branchName.slice(prefix.length)}`;
    }
    return `${prefix}${branchName}`;
  }

  private async resolveLocalWorkspaceTarget(
    params: CreateWorkspaceParams,
    project: Project,
    repoPath: string
  ): Promise<{ startPoint: string | undefined; baseBranch: string | undefined }> {
    const projectTarget = project.baseBranch?.trim() || undefined;
    const requestedStartPoint = params.baseBranch?.trim() || undefined;
    const detectedTarget =
      projectTarget || requestedStartPoint
        ? undefined
        : await gitService.getMainBranch(repoPath).catch(() => undefined);

    const localStartPoint = requestedStartPoint || projectTarget || detectedTarget;
    // New branches off the target start from origin's copy, so a stale local target doesn't
    // leave them behind. Exact names usually open an existing branch, which needs no start point.
    const startFromOrigin =
      params.startFromOrigin ??
      (!params.useExactBranchName &&
        (!requestedStartPoint || requestedStartPoint === projectTarget));
    const originStartPoint =
      startFromOrigin && localStartPoint && !/^(?:origin\/|refs\/)/.test(localStartPoint)
        ? await gitService.fetchOriginStartPoint(repoPath, localStartPoint)
        : undefined;

    return {
      startPoint: originStartPoint || localStartPoint,
      baseBranch: projectTarget || requestedStartPoint || detectedTarget,
    };
  }

  private toSafeWorktreePath(projectName: string, branchName: string): string {
    // Branch names are already sanitized upstream by sanitizeBranchName; the
    // local sanitizer here is defense-in-depth for the path layer.
    const sanitizeBranch = (s: string, fallback: string) =>
      s
        .replaceAll('\u0000', '')
        .replace(/\.\./g, '--')
        .replace(/[/\\]/g, '-')
        .replace(/^\./, '_') || fallback;

    const safeProject = sanitizeWorktreeProjectSegment(projectName);
    const safeBranch = sanitizeBranch(branchName, 'branch');

    const base = join(getKomlaBasePath(), 'worktrees');
    const target = join(base, safeProject, safeBranch);

    // Defense in depth: ensure the resolved path stays within the worktrees directory
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(
        `Unsafe worktree path derived from project "${projectName}" branch "${branchName}"`
      );
    }

    return target;
  }

  private createAutoBranchCandidate(
    baseBranchName: string,
    prefix: string,
    attempt: number,
    useExactName?: boolean
  ): string {
    // For meaningful names (user-provided or AI-generated), always use numeric
    // suffixes to preserve intent. Random retries only make sense when the
    // original name was already random.
    if (attempt <= AUTO_BRANCH_RANDOM_RETRIES && !useExactName) {
      return this.withBranchPrefix(generateBranchSuffix(), prefix);
    }

    const numericSuffix = useExactName ? attempt : attempt - AUTO_BRANCH_RANDOM_RETRIES + 1;
    // Always append the suffix to the original base name. Do NOT strip
    // trailing digits — names like "release-2026" must stay intact.
    if (useExactName) {
      return `${baseBranchName}-${numericSuffix}`;
    }

    const branchWithoutPrefix = baseBranchName.toLowerCase().startsWith(prefix.toLowerCase())
      ? baseBranchName.slice(prefix.length)
      : baseBranchName;
    return this.withBranchPrefix(`${branchWithoutPrefix}-${numericSuffix}`, prefix);
  }

  private createBranchConflictError(branchName: string, workspace?: Workspace): Error {
    if (workspace) {
      const workspaceLabel = workspace.customName?.trim() || workspace.name;
      return new Error(
        `Branch "${branchName}" is already open in workspace "${workspaceLabel}". Open that workspace or choose a different branch.`
      );
    }

    return new Error(
      `Branch "${branchName}" already has an active worktree. Choose a different branch or remove the existing worktree first.`
    );
  }

  private getInvalidReference(error: unknown): string | undefined {
    const message = (error as Error)?.message || String(error);
    const lowerMessage = message.toLowerCase();

    if (!lowerMessage.includes('invalid reference')) return undefined;

    const refMatch = message.match(/invalid reference:\s*(\S+)/i);
    return refMatch?.[1] || 'unknown';
  }

  private async recoverMissingProjectBaseBranch(
    error: unknown,
    project: Project,
    repoPath: string,
    requestedStartPoint: string | undefined
  ): Promise<string | undefined> {
    const missingRef = this.getInvalidReference(error);
    if (!missingRef || !requestedStartPoint || missingRef !== requestedStartPoint) {
      return undefined;
    }

    const detectedBaseBranch = await gitService.getMainBranch(repoPath).catch(() => undefined);
    if (!detectedBaseBranch || detectedBaseBranch === requestedStartPoint) {
      return undefined;
    }

    logger.warn('Project base branch no longer resolves; using detected branch instead', {
      projectId: project.id,
      projectName: project.name,
      missingRef,
      detectedBaseBranch,
    });

    try {
      // Before setting it here, so the update sees the change and tells its listeners.
      await projectService.update(project.id, { baseBranch: detectedBaseBranch });
    } catch (updateError) {
      logger.warn('Failed to persist recovered project base branch', {
        projectId: project.id,
        detectedBaseBranch,
        error: (updateError as Error).message,
      });
    }
    project.baseBranch = detectedBaseBranch;

    return detectedBaseBranch;
  }

  private normalizeCreateWorktreeError(error: unknown, branchName: string): Error {
    const message = (error as Error)?.message || String(error);
    const lowerMessage = message.toLowerCase();

    if (
      lowerMessage.includes('already checked out at') ||
      lowerMessage.includes('already used by worktree') ||
      lowerMessage.includes('worktree already exists') ||
      lowerMessage.includes('already exists at') ||
      lowerMessage.includes('already exists')
    ) {
      return this.createBranchConflictError(branchName);
    }

    // Invalid reference: the base branch doesn't resolve to a commit.
    // This typically means the project's target branch is misconfigured.
    const invalidRef = this.getInvalidReference(error);
    if (invalidRef) {
      return new Error(
        `Could not create branch "${branchName}": the base branch "${invalidRef}" does not exist in this repository. Try updating the project's target branch in project settings.`
      );
    }

    return error instanceof Error ? error : new Error(message);
  }

  private resolvePreset(presetId?: string | null, workspace?: Workspace) {
    const id = presetId ?? workspace?.presetId;
    if (id) {
      const preset = agentPresetService.get?.(id);
      if (preset) return preset;
    }
    return agentPresetService.getFirstActive?.() ?? agentPresetService.getActive();
  }

  private resolveLaunchModeId(
    preset: AgentPreset | null | undefined,
    launchModeId?: string | null
  ): string | null {
    return launchModeId && preset?.launchModes.some((mode) => mode.id === launchModeId)
      ? launchModeId
      : null;
  }

  private resolveReasoningLevelId(
    preset: AgentPreset | null | undefined,
    reasoningLevelId?: string | null
  ): string | null {
    return reasoningLevelId &&
      preset?.reasoningLevels?.some((level) => level.id === reasoningLevelId)
      ? reasoningLevelId
      : null;
  }

  /** The Action a new workspace's run button starts on: the one that launches it, else the
   *  last used one its project has. */
  private resolveInitialDefaultActionId(
    params: CreateWorkspaceParams,
    projectId: string | null
  ): string | undefined {
    return params.defaultActionId ?? lastUsedActionId(projectId);
  }

  /** Normalize new environment intent and legacy fields before creation branches. */
  private resolveWorkspaceCreationParams(params: CreateWorkspaceParams): CreateWorkspaceParams {
    const config = configService.get();
    const configuredSshHosts = sshHostService.list();
    // The agent launch gate reads placement the same way, to know where an agent would start.
    let environment = requestedWorkspaceEnvironment(params);

    if (!environment) {
      const decision = resolveWorkspaceCreationEnvironment({
        ...config,
        sshHosts: configuredSshHosts,
      });
      // SSH hosts only run worktrees, so a folder opens locally instead.
      if (params.mode === 'directory' && decision.environment.kind === 'ssh') {
        decision.environment = { kind: 'local' };
        decision.issue = undefined;
      }
      if (decision.issue === 'missing-ssh-host') {
        throw new Error('The SSH host new workspaces start on is no longer configured.');
      }
      environment = decision.environment;
    }

    if (environment.kind === 'ssh') {
      const shouldValidateConfiguredHost =
        params.environment !== undefined || params.location?.kind !== 'ssh';
      if (shouldValidateConfiguredHost && !sshHostService.has(environment.hostId)) {
        throw new Error('The selected SSH host is no longer configured.');
      }
      const sourceWorkspace = params.sourceWorkspaceId
        ? this.workspaces.get(params.sourceWorkspaceId)
        : undefined;
      const matchingSourceBackend =
        sourceWorkspace &&
        isSshWorkspace(sourceWorkspace) &&
        sourceWorkspace.backend.hostId === environment.hostId &&
        sourceWorkspace.projectId === (params.projectId ?? null)
          ? sourceWorkspace.backend
          : undefined;
      const existingLocation =
        params.location?.kind === 'ssh' && params.location.hostId === environment.hostId
          ? params.location
          : undefined;
      return {
        ...params,
        environment,
        location: matchingSourceBackend
          ? {
              kind: 'ssh',
              hostId: environment.hostId,
              gitUrl: matchingSourceBackend.gitUrl,
              sourceBackend: matchingSourceBackend,
            }
          : (existingLocation ?? { kind: 'ssh', hostId: environment.hostId }),
      };
    }

    return {
      ...params,
      environment: { kind: 'local' },
      location: { kind: 'local' },
    };
  }

  async recoverSshSessions(workspaceId: string): Promise<Workspace | undefined> {
    const workspace = this.workspaces.get(workspaceId);
    // Opening a workspace picks up what other devices changed on its host.
    if (workspace && isSshWorkspace(workspace)) {
      void this.sshSync.syncSoon(workspace.backend.hostId);
    }
    return this.recoverSshSessionsOnce(workspaceId);
  }

  /**
   * Marks an SSH workspace whose files are gone from its host although no Komla
   * installation recorded deleting it, so the user decides what to do with it.
   */
  markSshWorkspaceRemoved(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace) || this.deletingWorkspaceIds.has(workspaceId)) {
      return;
    }
    // provisionError keeps Komla from reconnecting or restarting it; removedFromHost names why.
    workspace.removedFromHost = true;
    workspace.provisionError = 'This workspace’s files are no longer on its SSH host.';
    this.saveWorkspaces();
    this.broadcastWorkspacesChanged();
  }

  /** Clears the mark on an SSH workspace whose files are on its host again. */
  markSshWorkspaceFound(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace?.removedFromHost) return;
    workspace.removedFromHost = undefined;
    workspace.provisionError = undefined;
    this.saveWorkspaces();
    this.broadcastWorkspacesChanged();
  }

  /** Removes an SSH workspace another installation deleted from its host; the host is left alone. */
  async removeSshWorkspaceDeletedElsewhere(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace) || this.isDeleting(workspaceId)) return;
    const event: SshWorkspaceRemovedOnOtherDevice = {
      workspaceId,
      name: workspace.customName || workspace.name,
    };
    await this.delete(workspaceId, true, false, { skipBackendCleanup: true });
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.WORKSPACE_REMOVED_ON_OTHER_DEVICE, event);
      }
    }
  }

  /**
   * Notes which tabs not attached here have a tmux session on the host, such
   * as those another device runs, so the sidebar shows them running, their
   * changes are observed, and selecting the workspace or its pane reattaches
   * to them rather than starting their agents again. Limits don't count them.
   * A tab last seen running whose session is gone, e.g. one another device
   * stopped, is ended through the lifecycle: it shows stopped and selecting
   * the workspace starts its agents again.
   */
  private async findSshSessionsOnHost(hostId: string): Promise<void> {
    const checked = (workspace: Workspace) =>
      this.workspaces.get(workspace.id) === workspace &&
      workspace.status === 'active' &&
      !workspace.removedFromHost &&
      !this.isDeleting(workspace.id);
    const changed = new Set<Workspace>();
    let ended = false;
    const checks: Array<{
      workspace: Workspace & { backend: SshWorkspaceBackend };
      terminal: Terminal;
      stamp: string;
      hooks: HookMark;
      /** Finding no session means it ended. */
      endsIfGone: boolean;
      tracked: ManagedRemoteTerminalState | undefined;
    }> = [];
    for (const workspace of this.workspaces.values()) {
      if (!isSshWorkspace(workspace) || workspace.backend.hostId !== hostId) continue;
      if (this.isDeleting(workspace.id)) continue;
      if (!checked(workspace)) {
        // In the Trash or gone from the host: what an earlier check saw no longer holds.
        if (this.forgetSshSessionsOnHost(workspace)) changed.add(workspace);
        continue;
      }
      for (const terminal of workspace.terminals) {
        if (!needsHostCheck(workspace, terminal)) continue;
        checks.push({
          workspace,
          terminal,
          stamp: hostCheckStamp(terminal),
          hooks: this.attention.hookMark(terminal.id),
          endsIfGone: endsIfGoneFromHost(workspace, terminal),
          tracked: managedRemoteTerminalLifecycleService.hostCheckBaseline(terminal.id),
        });
      }
    }
    const [first] = checks;
    const running = first
      ? await sshWorkspaceService.findTerminalSessions(
          first.workspace.backend,
          checks.map(({ terminal }) => terminal.id),
          { background: true }
        )
      : new Set<string>();
    for (const { workspace, terminal, ...seen } of checks) {
      // The workspace, or this device's own view of the session, changed while the host was checked.
      if (
        !checked(workspace) ||
        terminal.status !== 'stopped' ||
        hostCheckStamp(terminal) !== seen.stamp ||
        !workspace.terminals.includes(terminal)
      ) {
        continue;
      }
      const onHost = running.has(terminal.id);
      // A hook copied during the check means its session may have started after the host was read.
      const copiedSince = this.attention.hookArrivedSince(terminal.id, seen.hooks);
      // Kept on by copies of hooks from a session that has since ended.
      if (!onHost && !copiedSince) this.attention.sessionGone(terminal.id);
      if (!onHost && seen.endsIfGone) {
        // Gone after it was seen running, e.g. stopped elsewhere: selecting it restarts the
        // agent, where reconnecting would open a shell in a new, empty session. If that can't
        // be settled now, it stays as it was for the next sync: "missing" would never end.
        if (
          !copiedSince &&
          managedRemoteTerminalLifecycleService.sessionGoneFromHost(terminal.id, seen.tracked)
        ) {
          ended = true;
          changed.add(workspace);
        }
        continue;
      }
      Object.assign(terminal, encodeTerminalExecution({ kind: 'host-checked', onHost }));
      if (hostCheckStamp(terminal) !== seen.stamp) changed.add(workspace);
    }
    if (changed.size === 0) return;
    if (ended) this.saveWorkspaces();
    // Each workspace's own update would make every window reload them all again.
    publishRemoteWorkspaceChange();
    this.broadcastWorkspacesChanged();
    void remoteWorkspaceObservationService.reconcile();
  }

  /** Clears what host checks saw for a workspace's tabs; returns whether any had been checked. */
  private forgetSshSessionsOnHost(workspace: Workspace): boolean {
    let forgot = false;
    for (const terminal of workspace.terminals) {
      const stamp = hostCheckStamp(terminal);
      Object.assign(terminal, encodeTerminalExecution({ kind: 'host-checked', onHost: undefined }));
      if (hostCheckStamp(terminal) !== stamp) forgot = true;
    }
    return forgot;
  }

  /**
   * Takes the names, tabs and layout of a manifest merged with another device's,
   * and returns the ids of the tabs it added.
   */
  private applyMergedSshWorkspace(workspaceId: string, merged: SshWorkspaceManifest): string[] {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return [];
    workspace.name = merged.name;
    workspace.customName = merged.customName;
    workspace.customDescription = merged.customDescription;
    workspace.customNameSource = merged.customNameSource;
    const addedTerminalIds = this.takeSshTerminalsFromOtherDevice(workspace, merged.terminals);
    const terminalIds = new Set(workspace.terminals.map((terminal) => terminal.id));
    workspace.terminalLayout = normalizePersistedTerminalLayout(merged.terminalLayout, terminalIds);
    if (!terminalIds.has(workspace.primaryTerminalId ?? '')) {
      workspace.primaryTerminalId = workspace.terminals[0]?.id;
    }
    return addedTerminalIds;
  }

  /** Adds the tabs another device opened and applies its renames; returns the new tabs' ids. */
  private takeSshTerminalsFromOtherDevice(
    workspace: Workspace,
    merged: SshWorkspaceManifest['terminals']
  ): string[] {
    const terminals = new Map(workspace.terminals.map((terminal) => [terminal.id, terminal]));
    const added: string[] = [];
    for (const terminal of merged) {
      const existing = terminals.get(terminal.id);
      if (existing) {
        existing.name = terminal.name;
        continue;
      }
      workspace.terminals.push(
        ...normalizePersistedSshTerminals([{ ...terminal, executionLocation: 'workspace' }])
      );
      added.push(terminal.id);
    }
    return added;
  }

  /**
   * Mirrors another device moving a workspace to the Trash or restoring it, which
   * ended its sessions. Like the Trash here, it never hides a workspace while
   * its agents may run: if they can't be stopped, it rejects and the status stays.
   */
  private async applySshWorkspaceStatusFromOtherDevice(
    workspaceId: string,
    status: Workspace['status']
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    const previous = workspace.status;
    if (previous === 'active' && status !== 'active') await this.stop(workspace.id);
    workspace.status = status;
    // The days count from when this device saw the move.
    if (status !== 'trashed') workspace.trashedAt = undefined;
    else if (previous !== 'trashed') workspace.trashedAt = Date.now();
    this.attention.workspaceStatusChanged();
    if (status === 'trashed') workspace.setupActivities = undefined;
    if (status !== 'trashed' || previous === 'trashed' || !isSshWorkspace(workspace)) return;
    void localMirrorService.remove(workspace.id, workspace.backend).catch((error) => {
      logger.warn(
        'Could not remove the local copy of a workspace another device moved to the Trash',
        {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    });
  }

  /** Gives SSH workspaces without a project here the local project for their repository, if any. */
  async assignSshWorkspaceProjects(): Promise<void> {
    const unassigned = () =>
      Array.from(this.workspaces.values()).filter(
        (workspace) => isSshWorkspace(workspace) && !this.workspaceProject(workspace)
      );
    if (unassigned().length === 0) return;
    const projectsByRemote = await this.projectsByGitRemote();
    let assigned = false;
    for (const workspace of unassigned()) {
      if (!isSshWorkspace(workspace)) continue;
      const project = this.sshRepositoryProject(workspace.backend, projectsByRemote);
      if (!project) continue;
      workspace.projectId = project.id;
      assigned = true;
    }
    if (!assigned) return;
    this.saveWorkspaces();
    this.broadcastWorkspacesChanged();
  }

  /**
   * Puts an SSH workspace in a project the user chose, along with workspaces
   * without a project that use the same clone on its host.
   */
  linkSshWorkspaceToProject(workspaceId: string, projectId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) {
      throw new Error(`SSH workspace ${workspaceId} not found`);
    }
    const project = projectService.get(projectId);
    if (!project || project.kind === 'directory') {
      throw new Error(`Git project ${projectId} not found`);
    }
    for (const other of this.workspaces.values()) {
      const sameClone =
        isSshWorkspace(other) &&
        other.backend.hostId === workspace.backend.hostId &&
        other.backend.remoteRepoPath === workspace.backend.remoteRepoPath;
      if (other === workspace || (sameClone && !this.workspaceProject(other))) {
        other.projectId = project.id;
      }
    }
    this.saveWorkspaces();
    this.broadcastWorkspacesChanged();
  }

  private workspaceProject(workspace: Workspace): Project | undefined {
    return workspace.projectId ? projectService.get(workspace.projectId) : undefined;
  }

  /** Calls `listener` each time SSH Workspace Sync has read a host. */
  onSshHostSynced(listener: (hostId: string) => void): () => void {
    this.sshHostSyncedListeners.add(listener);
    return () => this.sshHostSyncedListeners.delete(listener);
  }

  /** Resolves to a lookup of this installation's git project for a repository origin. */
  async gitRemoteProjectLookup(): Promise<(gitUrl: string) => Project | undefined> {
    const projectsByRemote = await this.projectsByGitRemote();
    return (gitUrl) => projectsByRemote.get(gitRemoteIdentity(gitUrl));
  }

  /** This installation's git projects by the identity of their origin remote. */
  private async projectsByGitRemote(): Promise<Map<string, Project>> {
    const projects = projectService.list().filter((project) => project.kind !== 'directory');
    const remotes = await Promise.all(
      projects.map((project) => {
        const path =
          project.managed && project.managedRepoPath
            ? project.managedRepoPath
            : project.repositoryPath;
        let remote = this.gitRemoteUrls.get(path);
        if (!remote) {
          remote = gitService.getRemoteUrl(path).catch(() => {
            this.gitRemoteUrls.delete(path);
            return null;
          });
          this.gitRemoteUrls.set(path, remote);
        }
        return remote;
      })
    );
    const byRemote = new Map<string, Project>();
    projects.forEach((project, index) => {
      const identity = remotes[index] ? gitRemoteIdentity(remotes[index]) : undefined;
      if (identity && !byRemote.has(identity)) byRemote.set(identity, project);
    });
    return byRemote;
  }

  /** Matches repositories on an SSH host to local projects, as SSH Workspace Sync does. */
  async sshRepositoryProjectLookup(): Promise<
    (
      backend: Pick<SshWorkspaceBackend, 'hostId' | 'remoteRepoPath' | 'gitUrl'>
    ) => string | undefined
  > {
    const projectsByRemote = await this.projectsByGitRemote();
    return (backend) => this.sshRepositoryProject(backend, projectsByRemote)?.id;
  }

  /**
   * The local project for an SSH workspace's repository: that of another
   * workspace using the same clone on the host, else a git project whose
   * origin is the same repository.
   */
  private sshRepositoryProject(
    backend: Pick<SshWorkspaceBackend, 'hostId' | 'remoteRepoPath' | 'gitUrl'>,
    projectsByRemote: ReadonlyMap<string, Project>
  ): Project | undefined {
    for (const other of this.workspaces.values()) {
      if (
        !isSshWorkspace(other) ||
        other.backend.hostId !== backend.hostId ||
        other.backend.remoteRepoPath !== backend.remoteRepoPath
      ) {
        continue;
      }
      const project = this.workspaceProject(other);
      if (project) return project;
    }
    return projectsByRemote.get(gitRemoteIdentity(backend.gitUrl));
  }

  /** Adds an SSH workspace adopted from its manifest, placed where SSH Workspace Sync says. */
  private addAdoptedSshWorkspace(
    hostId: string,
    manifest: SshWorkspaceManifest,
    { projectId, sibling }: SshWorkspacePlacement
  ): Workspace {
    const { workspace, agentSources } = this.hydrateWorkspace({
      _version: WORKSPACE_VERSION,
      id: manifest.workspaceId,
      name: manifest.name,
      customName: manifest.customName,
      customDescription: manifest.customDescription,
      customNameSource: manifest.customNameSource,
      workingDirectory: `ssh://${hostId}${manifest.backend.remoteDirectory}`,
      backend: {
        kind: 'ssh',
        hostId,
        ...manifest.backend,
        ...(sibling?.backend.projectId ? { projectId: sibling.backend.projectId } : {}),
      },
      branchName: manifest.branchName,
      isWorktree: true,
      projectId,
      repoName: manifest.repoName,
      baseBranch: manifest.baseBranch,
      ...(sibling ? { presetId: sibling.presetId, launchModeId: sibling.launchModeId } : {}),
      primaryTerminalId: manifest.primaryTerminalId,
      terminals: manifest.terminals.map((terminal) => ({
        ...terminal,
        executionLocation: 'workspace',
      })),
      terminalLayout: manifest.terminalLayout,
      windowId: null,
      categoryId: null,
      createdAt: manifest.createdAt,
      // When it last changed there, e.g. a new tab or name, rather than when it arrived. Activity
      // this device sees on the host moves it up later, as it does on the device running it.
      lastActivityAt: Math.max(manifest.createdAt, manifest.updatedAt),
      order: 0,
      status: manifest.status,
    });
    // Hydrating clears the window, as on startup, and windows list only their own workspaces.
    workspace.windowId =
      sibling?.windowId ??
      this.windowWithMostWorkspacesOf(workspace.projectId) ??
      windowService.getMainWindowId();
    // It goes on top, like a workspace created here.
    for (const existingWorkspace of this.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }
    this.workspaces.set(workspace.id, workspace);
    this.attention.restored(workspace, agentSources);
    this.saveWorkspaces();
    this.broadcastWorkspacesChanged();
    return workspace;
  }

  /** The window that shows the most of a project's active workspaces, if any shows one. */
  private windowWithMostWorkspacesOf(projectId: string | null): string | null {
    if (!projectId) return null;
    const counts = new Map<string, number>();
    let most: string | null = null;
    let mostCount = 0;
    for (const workspace of this.workspaces.values()) {
      if (workspace.projectId !== projectId || workspace.status !== 'active') continue;
      if (!workspace.windowId) continue;
      const count = (counts.get(workspace.windowId) ?? 0) + 1;
      counts.set(workspace.windowId, count);
      if (count > mostCount) {
        most = workspace.windowId;
        mostCount = count;
      }
    }
    return most;
  }

  private async recoverSshSessionsOnce(workspaceId: string): Promise<Workspace | undefined> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return workspace;
    if (!sshWorkspaceService.hasHost(workspace.backend.hostId)) {
      const recovery = managedRemoteTerminalLifecycleService.recover(workspaceId).catch((error) => {
        logger.warn('Could not reconcile Managed Remote Terminal Sessions for a removed host', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
      workspace.provisionError = 'This workspace’s SSH host is no longer configured.';
      this.saveWorkspaces();
      this.broadcastWorkspacesChanged();
      logger.warn('Skipping SSH session recovery for workspace with missing host', {
        workspaceId: workspace.id,
        hostId: workspace.backend.hostId,
      });
      await recovery;
      return workspace;
    }
    if (workspace.status !== 'active') return workspace;

    const recovery = await managedRemoteTerminalLifecycleService
      .recover(workspaceId)
      .catch((error) => {
        logger.warn('Could not check Managed Remote Terminal Sessions after workspace selection', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    if (recovery.hostMissing) {
      workspace.provisionError = 'This workspace’s SSH host is no longer configured.';
      this.saveWorkspaces();
      this.broadcastWorkspacesChanged();
      logger.warn('Skipping SSH session recovery for workspace with missing host', {
        workspaceId: workspace.id,
        hostId: workspace.backend.hostId,
      });
      return workspace;
    }
    const inactiveTerminalIds = recovery.endedTerminalIds;
    if (inactiveTerminalIds.size > 0) {
      for (const terminalId of inactiveTerminalIds) this.attention.sessionGone(terminalId);
      workspace.terminals = workspace.terminals.filter(
        (terminal) => !inactiveTerminalIds.has(terminal.id)
      );
      const remainingTerminalIds = new Set(workspace.terminals.map((terminal) => terminal.id));
      workspace.terminalLayout = normalizePersistedTerminalLayout(
        workspace.terminalLayout,
        remainingTerminalIds
      );
      if (!remainingTerminalIds.has(workspace.primaryTerminalId ?? '')) {
        workspace.primaryTerminalId = workspace.terminals[0]?.id;
      }
    }
    if (recovery.states.size > 0 || inactiveTerminalIds.size > 0) {
      this.saveWorkspaces();
      this.broadcastWorkspaceUpdate(workspace);
    }
    return workspace;
  }

  reconcilePersistedSshSessions(): void {
    for (const workspace of this.workspaces.values()) {
      if (!isSshWorkspace(workspace) || workspace.status !== 'active') continue;
      if (sshWorkspaceService.hasHost(workspace.backend.hostId)) continue;
      void this.recoverSshSessions(workspace.id).catch((error) => {
        logger.warn('Could not reconcile removed SSH host during startup', error, {
          workspaceId: workspace.id,
          hostId: workspace.backend.hostId,
        });
      });
    }
    // Restore mailbox delivery for persisted remote sessions even when their workspace is
    // never selected. Terminal probing and attachment remain lazy.
    void remoteWorkspaceObservationService.reconcileAfterReconnect().catch((error) => {
      logger.warn('Could not restore SSH observation during startup', error);
    });
  }

  saveSshTerminalLayouts(layouts: Record<string, unknown>): void {
    let changed = false;
    for (const [workspaceId, layout] of Object.entries(layouts)) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace || !isSshWorkspace(workspace)) continue;
      const normalized = normalizePersistedTerminalLayout(
        layout as Workspace['terminalLayout'],
        new Set(workspace.terminals.map((terminal) => terminal.id))
      );
      if (!normalized) {
        if (workspace.terminalLayout) {
          workspace.terminalLayout = undefined;
          changed = true;
        }
        continue;
      }
      if (isDeepStrictEqual(workspace.terminalLayout, normalized)) continue;
      workspace.terminalLayout = normalized;
      changed = true;
    }
    if (changed) this.saveWorkspaces();
  }

  private countWorkspaces(predicate: (workspace: Workspace) => boolean): number {
    let count = 0;
    for (const ws of this.workspaces.values()) {
      if (predicate(ws)) count++;
    }
    return count;
  }

  getRunningWorkspaceCount(): number {
    return this.countWorkspaces(isRunningHere);
  }

  /** SSH workspaces running on their hosts, the ones the free plan limits. */
  getRunningRemoteWorkspaceCount(): number {
    return this.countWorkspaces(isRunningOnSshHost);
  }

  /**
   * Throws, and reports the hit, when the free plan has no SSH workspace slot
   * left for a launch that finds `checkedCount` slots taken.
   */
  private assertFreeSshSlot(
    source: 'create_workspace' | 'start_workspace',
    runningCount: number,
    checkedCount = runningCount
  ): void {
    const check = licenseService.canStartWorkspace(checkedCount);
    if (check.allowed) return;
    telemetryService.sendMonetizationEvent('free_limit_hit', {
      source,
      limit: FREE_WORKSPACE_LIMIT,
      runningCount,
    });
    throw new Error(check.reason);
  }

  /**
   * Reserve a pending-start slot when a terminal starting at `executionLocation`
   * puts this SSH workspace on its host, enforcing the free-tier limit. Throws if
   * the limit is hit. Returns whether it reserved; the caller then decrements
   * pendingRemoteStarts.
   */
  private reserveWorkspaceStartSlot(
    workspace: Workspace,
    executionLocation: TerminalExecutionLocation | undefined
  ): boolean {
    if (
      !executionLocations.managesSession(workspace, executionLocation) ||
      isRunningOnSshHost(workspace)
    ) {
      return false;
    }
    this.assertFreeSshSlot(
      'start_workspace',
      this.getRunningRemoteWorkspaceCount() + this.pendingRemoteStarts
    );
    this.pendingRemoteStarts++;
    return true;
  }

  async create(params: CreateWorkspaceParams): Promise<Workspace> {
    params = this.resolveWorkspaceCreationParams(params);
    const remote = params.location?.kind === 'ssh';
    if (remote) this.reserveWorkspaceCreateSlots(1);
    try {
      return await this.createReserved(params);
    } finally {
      if (remote) this.pendingRemoteCreates--;
    }
  }

  async createBatch(params: CreateWorkspaceParams[]): Promise<Workspace[]> {
    if (params.length === 0) return [];
    params = params.map((entry) => this.resolveWorkspaceCreationParams(entry));
    const remoteCount = params.filter((entry) => entry.location?.kind === 'ssh').length;
    if (remoteCount > 0) this.reserveWorkspaceCreateSlots(remoteCount);
    const results = await Promise.allSettled(
      params.map(async (entry) => {
        try {
          return await this.createReserved(entry);
        } finally {
          if (entry.location?.kind === 'ssh') this.pendingRemoteCreates--;
        }
      })
    );
    const workspaces: Workspace[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      workspaces.push(result.value);
    }
    return workspaces;
  }

  private reserveWorkspaceCreateSlots(workspaceCount: number): void {
    const runningCount = this.countWorkspaces(takesFreeSshSlot) + this.pendingRemoteCreates;
    this.assertFreeSshSlot('create_workspace', runningCount, runningCount + workspaceCount - 1);
    this.pendingRemoteCreates += workspaceCount;
  }

  /** Creates from params `resolveWorkspaceCreationParams` already resolved. */
  private async createReserved(params: CreateWorkspaceParams): Promise<Workspace> {
    await this.assertPromptAttachmentsExist(params);
    let workingDirectory: string;
    let branchName: string | undefined;
    let isWorktree: boolean;
    let projectId: string | null;
    let repoName: string | undefined;
    let baseBranch: string | undefined;
    let branchedFrom: string | undefined;
    let backend: WorkspaceBackend | undefined;
    let prepareCreatedSshWorkspace: ((workspace: Workspace) => Promise<void>) | undefined;

    if (params.location?.kind === 'ssh') {
      if (params.mode !== 'worktree') {
        throw new Error('SSH workspaces only support worktree mode');
      }
      const project = params.projectId ? projectService.get(params.projectId) : undefined;
      if (params.projectId && !project) {
        throw new Error(`Project ${params.projectId} not found`);
      }
      if (project?.kind === 'directory') {
        throw new Error('Directory projects cannot create SSH worktree workspaces');
      }
      const repoPath =
        project?.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project?.repositoryPath;
      if (!project && !params.location.gitUrl) {
        throw new Error('A git project is required for SSH workspaces');
      }
      // Don't wait behind a background fetch of the project; creation fetches what it needs.
      if (repoPath) gitService.stopBackgroundWork(repoPath);
      const remoteUrl = repoPath ? await gitService.getRemoteUrl(repoPath).catch(() => null) : null;
      const gitUrl = params.location.gitUrl?.trim() || remoteUrl;
      if (!gitUrl) {
        if (!project || !repoPath) {
          throw new Error('SSH workspaces require a Git remote URL.');
        }
        throw new SshProjectNeedsRemoteError({
          projectId: project.id,
          branches: await sshBranchesToPublish(params, project, repoPath),
        });
      }
      this.startSshHostPreparation(params.location.hostId, !params.location.sourceBackend);
      if (project && params.deferBranchNaming) {
        return this.createDeferredSshWorkspace(params, project, gitUrl);
      }
      const workspaceStartPoint = normalizeSshStartPoint(params.baseBranch);
      const workspaceBaseBranch = sshWorkspaceTargetBranch(params);
      const sshProjectBaseBranch = resolveSshTargetBranch(project, workspaceBaseBranch);
      const requestedStartPoint = workspaceStartPoint || sshProjectBaseBranch;
      const startsFromProjectTarget =
        !!sshProjectBaseBranch &&
        normalizeSshTargetBranch(requestedStartPoint) === sshProjectBaseBranch;
      // The host resolves its own branches, which origin doesn't have.
      const startPoint = !requestedStartPoint
        ? undefined
        : startsFromProjectTarget || params.baseBranchOnHost
          ? requestedStartPoint
          : project && repoPath && !params.location.sourceBackend
            ? await gitService.resolvePublishedCommit(repoPath, requestedStartPoint || 'HEAD')
            : requestedStartPoint;
      const requestedBranch = params.branchName?.trim() || generateBranchSuffix();
      branchName = params.useExactBranchName
        ? requestedBranch
        : this.withBranchPrefix(requestedBranch, this.branchPrefix(project));
      const resolvedBasePath = params.location.sourceBackend
        ? undefined
        : await sshWorkspaceService.resolveWorkspaceBasePath(params.location.hostId);
      const sshLocation = params.location;
      const createSshPlan = (candidate: string) =>
        sshWorkspaceService.createWorkspacePlan({
          hostId: sshLocation.hostId,
          gitUrl,
          projectId: project?.id,
          projectName: project?.name ?? branchSuffixToName(requestedBranch),
          branchName: candidate,
          checkoutExistingBranch: params.checkoutExistingBranch,
          baseBranch: sshProjectBaseBranch,
          startPoint,
          resolvedBasePath,
          sourceBackend: sshLocation.sourceBackend,
        });
      const sshPlan = sshWorkspaceProvisioningService.plan({
        initialBranchName: branchName,
        params,
        branchPrefix: this.branchPrefix(project),
        createPlan: createSshPlan,
      });
      const { remote } = sshPlan;
      branchName = sshPlan.branchName;
      workingDirectory = remote.workingDirectory;
      backend = remote.backend;
      baseBranch = sshProjectBaseBranch;
      branchedFrom = project ? computeBranchedFrom(params, project) : undefined;
      isWorktree = true;
      projectId = project?.id ?? null;
      repoName = project?.name ?? remote.repoName;
      prepareCreatedSshWorkspace = async (workspace) => {
        await sshWorkspaceProvisioningService.prepare(workspace, {
          initialBranchName: sshPlan.branchName,
          params,
          branchPrefix: this.branchPrefix(project),
          createPlan: createSshPlan,
        });
      };
    } else if (params.mode === 'worktree') {
      if (!params.projectId) {
        throw new Error('Project ID is required for worktree mode');
      }
      const project = projectService.get(params.projectId);
      if (!project) {
        throw new Error(`Project ${params.projectId} not found`);
      }
      if (project.kind === 'directory') {
        throw new Error('Directory projects cannot create worktree workspaces');
      }
      // Don't wait behind a background fetch of the project; creation fetches what it needs.
      gitService.stopBackgroundWork(projectRepoPath(project));

      if (params.deferBranchNaming) {
        return this.createDeferredWorkspace(params, project);
      }

      const result = await this.createWorktreeWithRetries(params, project);
      workingDirectory = result.workingDirectory;
      branchName = result.branchName;
      baseBranch = result.baseBranch;
      branchedFrom = computeBranchedFrom(params, project);

      this.applyAutoNameFromBranch(params, project, branchName);

      isWorktree = true;
      projectId = params.projectId;
      repoName = project.name;
    } else {
      workingDirectory = this.resolveDirectoryWorkingDirectory(params);
      isWorktree = false;
      projectId = params.projectId ?? null;
      repoName = params.projectId ? projectService.get(params.projectId)?.name : undefined;
    }

    const workspace = this.buildWorkspaceObject({
      params,
      workingDirectory,
      branchName,
      isWorktree,
      projectId,
      repoName,
      baseBranch,
      branchedFrom,
      backend,
    });

    const activePreset = this.resolvePreset(params.presetId);
    workspace.presetId = activePreset?.id ?? null;
    workspace.launchModeId = this.resolveLaunchModeId(activePreset, params.launchModeId);
    workspace.reasoningLevelId = this.resolveReasoningLevelId(
      activePreset,
      params.reasoningLevelId
    );
    if (prepareCreatedSshWorkspace) {
      await prepareCreatedSshWorkspace(workspace);
    }
    const command = this.resolveInitialCommand(
      params,
      activePreset,
      workspace,
      await this.importPromptAttachments(workspace, params, activePreset)
    );
    if (activePreset && !params.skipRecordUsage) {
      agentPresetService.recordPresetUsage?.(
        activePreset.id,
        params.launchModeId,
        params.reasoningLevelId
      );
    }

    // Only publish the workspace after initial SSH preparation succeeds.
    for (const existingWorkspace of this.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }
    this.workspaces.set(workspace.id, workspace);
    this.saveWorkspaces();
    this.armProjectIconPrompt(workspace);

    if (workspace.baseBranch && !isSshWorkspace(workspace)) {
      gitService.registerTargetBranch(workspace.workingDirectory, workspace.baseBranch);
    }

    if (!isSshWorkspace(workspace)) {
      worktreeWatcherService
        .startWatching(workspace.id, workspace.workingDirectory)
        .catch((err) => {
          logger.error(`Failed to start watcher for workspace ${workspace.id}:`, err);
        });
    }

    return this.spawnPrimaryTerminal(workspace, params, command);
  }

  // Its files, here or on its SSH host, are where the project's icons are found.
  private armProjectIconPrompt(workspace: Workspace): void {
    if (workspace.projectId) projectService.armIconPrompt(workspace.projectId, workspace.id);
  }

  /** Construct the new Workspace record from resolved create() inputs. */
  private buildWorkspaceObject(args: {
    params: CreateWorkspaceParams;
    workingDirectory: string;
    branchName: string | undefined;
    isWorktree: boolean;
    projectId: string | null;
    repoName: string | undefined;
    baseBranch: string | undefined;
    branchedFrom: string | undefined;
    backend?: WorkspaceBackend;
  }): Workspace {
    const {
      params,
      workingDirectory,
      branchName,
      isWorktree,
      projectId,
      repoName,
      baseBranch,
      branchedFrom,
      backend,
    } = args;
    const appConfig = configService.get();
    return {
      id: createWorkspaceId(),
      name: params.name || 'Workspace',
      customName: params.customName,
      customDescription: params.customDescription,
      customNameSource: params.customName ? 'manual' : undefined,
      workingDirectory,
      ...(backend ? { backend } : {}),
      branchName,
      isWorktree,
      projectId,
      ...(repoName ? { repoName } : {}),
      baseBranch,
      ...(branchedFrom ? { branchedFrom } : {}),
      windowId: params.windowId || null,
      categoryId: params.categoryId || null,
      fileTreeOpen: appConfig.defaultFileTreeOpen,
      fileTreeMode: appConfig.defaultFileTreeMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      order: 0,
      status: 'active',
      terminals: [],
      defaultActionId: this.resolveInitialDefaultActionId(params, projectId),
    };
  }

  /**
   * Spawn the workspace's primary terminal. Worktree-mode workspaces get a
   * chance to apply project setup steps first; if those produced a terminal,
   * we use that as the primary instead of opening a new one.
   */
  private async spawnPrimaryTerminal(
    workspace: Workspace,
    params: CreateWorkspaceParams,
    command: string | null
  ): Promise<Workspace> {
    if (params.mode === 'worktree' && params.projectId) {
      const primaryTerminal = workspaceSetupService.start(workspace, command, 'create');
      if (primaryTerminal) {
        this.publishCreated(workspace, this.maybeAutoName(workspace, params));
        return workspace;
      }
    }
    const terminal = await this.addTerminal(workspace.id, workspace.name, command);
    workspace.primaryTerminalId = terminal.id;
    this.publishCreated(workspace, this.maybeAutoName(workspace, params));
    return workspace;
  }

  /**
   * Build a placeholder workspace and kick off background provisioning.
   * Used when the caller passes deferBranchNaming so the UI gets an immediate
   * workspace row while branch naming + worktree creation run async.
   */
  private createDeferredWorkspace(params: CreateWorkspaceParams, project: Project): Workspace {
    const appConfig = configService.get();

    // When the caller already knows the branch name, include it on the
    // placeholder so the renderer can show accurate provisioning status.
    const placeholderBranch = params.branchName
      ? params.useExactBranchName
        ? params.branchName
        : this.withBranchPrefix(params.branchName, this.branchPrefix(project))
      : undefined;

    // Fail fast on branch conflicts when the caller didn't opt into auto-resolve.
    // This lets API callers get an immediate error instead of a silent provisionError.
    if (placeholderBranch && params.autoResolveBranchConflicts !== true) {
      const conflict = this.findBranchConflict(params.projectId!, placeholderBranch);
      if (conflict) {
        throw this.createBranchConflictError(placeholderBranch, conflict);
      }
    }

    for (const existingWorkspace of this.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }

    // Resolve the preset once so the placeholder and the later
    // finishProvisioning pass resolve to the same preset, even if the
    // preset changes during async provisioning.
    const placeholderPreset = this.resolvePreset(params.presetId);

    const placeholderBranchedFrom = computeBranchedFrom(params, project);
    const workspace: Workspace = {
      id: createWorkspaceId(),
      name: params.name || 'Workspace',
      customName: params.customName,
      customDescription: params.customDescription,
      customNameSource: params.customName ? 'manual' : undefined,
      workingDirectory: '',
      branchName: placeholderBranch,
      isWorktree: true,
      projectId: project.id,
      repoName: project.name,
      baseBranch: project.baseBranch || undefined,
      ...(placeholderBranchedFrom ? { branchedFrom: placeholderBranchedFrom } : {}),
      windowId: params.windowId || null,
      categoryId: params.categoryId || null,
      fileTreeOpen: appConfig.defaultFileTreeOpen,
      fileTreeMode: appConfig.defaultFileTreeMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      order: 0,
      status: 'active',
      terminals: [],
      defaultActionId: this.resolveInitialDefaultActionId(params, params.projectId ?? null),
      ...(placeholderPreset
        ? {
            presetId: placeholderPreset.id,
            launchModeId: this.resolveLaunchModeId(placeholderPreset, params.launchModeId),
            reasoningLevelId: this.resolveReasoningLevelId(
              placeholderPreset,
              params.reasoningLevelId
            ),
          }
        : {}),
      provisioning: true,
      provisioningRepoPath:
        project.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project.repositoryPath,
    };

    this.workspaces.set(workspace.id, workspace);
    this.saveWorkspaces();
    metricsCollectorService.increment('workspacesCreated');
    this.armProjectIconPrompt(workspace);

    // Fire-and-forget: finish provisioning in the background. The outer catch
    // is a safety net — finishProvisioning has its own try/catch, but if an
    // error escapes (e.g., broadcastWorkspaceUpdate throws inside the inner
    // catch), we must still clean up the provisioning state.
    this.finishProvisioning(workspace.id, params, project).catch((err) => {
      logger.error(`Provisioning failed for workspace ${workspace.id}:`, err);
      const ws = this.workspaces.get(workspace.id);
      if (ws?.provisioning) {
        ws.provisioning = false;
        ws.provisionStatus = undefined;
        ws.provisionError = err instanceof Error ? err.message : 'Workspace setup failed';
        ws.provisioningRepoPath = undefined;
        this.saveWorkspaces();
        try {
          this.broadcastWorkspaceUpdate(ws);
        } catch (broadcastErr) {
          logger.warn('Failed to broadcast provisioning error update:', broadcastErr);
        }
      }
    });

    return workspace;
  }

  /**
   * Starts the host work SSH workspace creation waits on: the remote base path, the platform
   * the Remote Companion install needs, and the connections worktree setup and the first
   * terminal run on. Their handshakes then overlap each other and branch naming instead of
   * running one by one.
   */
  private startSshHostPreparation(hostId: string, resolveBasePath: boolean): void {
    let host: SshHost;
    try {
      host = sshWorkspaceService.getHost(hostId);
    } catch {
      return;
    }
    // The platform check reuses the connection the base path opens, so a host that asks for a
    // password asks once.
    if (resolveBasePath) {
      void sshWorkspaceService
        .resolveWorkspaceBasePath(hostId)
        .then(() => remoteCompanionService.detectPlatform(host))
        .catch(() => undefined);
    }
    sshWorkspaceService.warmConnections(host);
  }

  private createDeferredSshWorkspace(
    params: CreateWorkspaceParams,
    project: Project,
    gitUrl: string
  ): Workspace {
    const appConfig = configService.get();
    const providedBranch = params.branchName && sanitizeBranchName(params.branchName);
    const placeholderSuffix = providedBranch || generateBranchSuffix();
    const placeholderBranch = params.useExactBranchName
      ? placeholderSuffix
      : this.withBranchPrefix(placeholderSuffix, this.branchPrefix(project));

    const placeholderPreset = this.resolvePreset(params.presetId);
    const sshLocation = params.location?.kind === 'ssh' ? params.location : undefined;
    if (!sshLocation) throw new Error('SSH workspace location is required');
    const workspaceStartPoint = normalizeSshStartPoint(params.baseBranch);
    const workspaceBaseBranch = sshWorkspaceTargetBranch(params);
    const sshProjectBaseBranch = resolveSshTargetBranch(project, workspaceBaseBranch);
    const initialPlan = sshWorkspaceProvisioningService.plan({
      initialBranchName: placeholderBranch,
      params,
      branchPrefix: this.branchPrefix(project),
      createPlan: (candidate) =>
        sshWorkspaceService.createWorkspacePlan({
          hostId: sshLocation.hostId,
          gitUrl,
          projectId: project.id,
          projectName: project.name,
          branchName: candidate,
          checkoutExistingBranch: params.checkoutExistingBranch,
          baseBranch: sshProjectBaseBranch,
          startPoint: workspaceStartPoint || sshProjectBaseBranch,
          sourceBackend: sshLocation.sourceBackend,
        }),
    });
    const { remote } = initialPlan;

    for (const existingWorkspace of this.workspaces.values()) {
      existingWorkspace.order = (existingWorkspace.order ?? 0) + 1;
    }

    const workspace: Workspace = {
      id: createWorkspaceId(),
      name:
        params.name || (providedBranch ? branchSuffixToName(initialPlan.branchName) : 'Workspace'),
      customName: params.customName,
      customDescription: params.customDescription,
      customNameSource: params.customName ? 'manual' : undefined,
      workingDirectory: remote.workingDirectory,
      backend: remote.backend,
      branchName: providedBranch ? initialPlan.branchName : undefined,
      isWorktree: true,
      projectId: project.id,
      repoName: project.name,
      baseBranch: sshProjectBaseBranch,
      branchedFrom: computeBranchedFrom(params, project),
      windowId: params.windowId || null,
      categoryId: params.categoryId || null,
      fileTreeOpen: false,
      fileTreeMode: appConfig.defaultFileTreeMode,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      order: 0,
      status: 'active',
      terminals: [],
      defaultActionId: this.resolveInitialDefaultActionId(params, project.id),
      ...(placeholderPreset
        ? {
            presetId: placeholderPreset.id,
            launchModeId: this.resolveLaunchModeId(placeholderPreset, params.launchModeId),
            reasoningLevelId: this.resolveReasoningLevelId(
              placeholderPreset,
              params.reasoningLevelId
            ),
          }
        : {}),
      provisioning: true,
      provisionStatus: providedBranch ? 'Checking remote branch' : 'Generating branch name',
    };

    this.workspaces.set(workspace.id, workspace);
    this.saveWorkspaces();
    metricsCollectorService.increment('workspacesCreated');
    this.armProjectIconPrompt(workspace);

    this.finishSshProvisioning(workspace.id, params, project, gitUrl).catch((err) => {
      void this.recordProvisioningError(workspace.id, err);
    });

    return workspace;
  }

  private async finishSshProvisioning(
    workspaceId: string,
    params: CreateWorkspaceParams,
    project: Project,
    gitUrl: string
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    const sshLocation = params.location?.kind === 'ssh' ? params.location : undefined;
    if (!workspace || !sshLocation) return;

    try {
      const repoPath =
        project.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project.repositoryPath;
      const providedBranch = params.branchName && sanitizeBranchName(params.branchName);
      let aiTitle: string | undefined;
      let aiDescription: string | undefined;
      let branchSuffix = providedBranch;

      if (!branchSuffix) {
        const aiResult = await this.generateAIBranchSuffix(workspaceId, params, repoPath);
        if (aiResult.cancelled) return;
        branchSuffix = aiResult.branchSuffix || generateBranchSuffix();
        aiTitle = aiResult.aiTitle;
        aiDescription = aiResult.aiDescription;
      }
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      const initialBranch = params.useExactBranchName
        ? branchSuffix
        : this.withBranchPrefix(branchSuffix, this.branchPrefix(project));
      this.updateProvisionStatus(workspaceId, 'Checking remote branch');
      const workspaceStartPoint = normalizeSshStartPoint(params.baseBranch);
      const workspaceBaseBranch = sshWorkspaceTargetBranch(params);
      const sshProjectBaseBranch = resolveSshTargetBranch(project, workspaceBaseBranch);
      const requestedStartPoint = workspaceStartPoint || sshProjectBaseBranch;
      const startsFromProjectTarget =
        !!sshProjectBaseBranch &&
        normalizeSshTargetBranch(requestedStartPoint) === sshProjectBaseBranch;
      const startPoint = !requestedStartPoint
        ? undefined
        : sshLocation.sourceBackend || startsFromProjectTarget || params.baseBranchOnHost
          ? requestedStartPoint
          : await gitService.resolvePublishedCommit(repoPath, requestedStartPoint || 'HEAD');
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      this.updateProvisionStatus(workspaceId, 'Connecting to SSH host');
      const resolvedBasePath = sshLocation.sourceBackend
        ? undefined
        : await sshWorkspaceService.resolveWorkspaceBasePath(sshLocation.hostId);
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      if (aiTitle && !params.customName) {
        workspace.customName = aiTitle;
        workspace.customNameSource = 'generated';
        workspace.customNameGeneratedAt = Date.now();
        workspace.promptSubmitsSinceCustomNameGeneration = 0;
        if (aiDescription) workspace.customDescription = aiDescription;
      }
      this.updateProvisionStatus(workspaceId, 'Creating remote worktree');

      await sshWorkspaceProvisioningService.prepare(workspace, {
        initialBranchName: initialBranch,
        params,
        branchPrefix: this.branchPrefix(project),
        createPlan: (candidate) =>
          sshWorkspaceService.createWorkspacePlan({
            hostId: sshLocation.hostId,
            gitUrl,
            projectId: project.id,
            projectName: project.name,
            branchName: candidate,
            checkoutExistingBranch: params.checkoutExistingBranch,
            baseBranch: sshProjectBaseBranch,
            startPoint,
            resolvedBasePath,
            sourceBackend: sshLocation.sourceBackend,
          }),
      });
      if (!this.workspaces.has(workspaceId) || this.provisioningCancelled.has(workspaceId)) {
        await sshWorkspaceProvisioningService.recover(workspace, 'cancelled');
        this.provisioningCancelled.delete(workspaceId);
        return;
      }

      await this.startProvisionedTerminals(workspace, params, aiTitle);
      sshWorkspaceProvisioningService.complete(workspace);
      this.saveWorkspaces();
      this.broadcastWorkspaceUpdate(workspace);
    } catch (err) {
      await this.recordProvisioningError(workspaceId, err);
    }
  }

  /**
   * Run the worktree-creation loop, retrying with auto-renamed branches on
   * Komla-side or git-level conflicts when autoResolveBranchConflicts is on.
   * Returns the created working directory and the final branch name used.
   */
  private async createWorktreeWithRetries(
    params: CreateWorkspaceParams,
    project: Project
  ): Promise<{ workingDirectory: string; branchName: string; baseBranch: string | undefined }> {
    // Auto-generate branch name if not provided; sanitize user input.
    // Fall back to a random suffix if sanitization strips everything.
    const inputBranchName =
      (params.branchName && sanitizeBranchName(params.branchName)) || generateBranchSuffix();
    const initialBranchName = params.useExactBranchName
      ? inputBranchName
      : this.withBranchPrefix(inputBranchName, this.branchPrefix(project));

    const projectName = project.name;
    // For managed projects, create worktree from the bare clone.
    // This allows worktrees on any branch including main/master.
    const repoPath =
      project.managed && project.managedRepoPath ? project.managedRepoPath : project.repositoryPath;
    const target = await this.resolveLocalWorkspaceTarget(params, project, repoPath);
    let worktreeStartPoint = target.startPoint;
    let baseBranch = target.baseBranch;
    await this.fastForwardManagedProjectTargetBeforeCreation(
      params,
      project,
      repoPath,
      target.baseBranch
    );
    const shouldAutoResolveBranchConflict = params.autoResolveBranchConflicts === true;
    let branchName = initialBranchName;
    const nextCandidate = (attempt: number): string =>
      this.createAutoBranchCandidate(
        initialBranchName,
        this.branchPrefix(project),
        attempt,
        params.useExactBranchName
      );

    for (let attempt = 1; attempt <= AUTO_BRANCH_MAX_ATTEMPTS; attempt++) {
      const existingWorkspace = this.findBranchConflict(params.projectId!, branchName);
      if (existingWorkspace) {
        if (!shouldAutoResolveBranchConflict) {
          throw this.createBranchConflictError(branchName, existingWorkspace);
        }
        branchName = nextCandidate(attempt);
        continue;
      }

      const worktreeDestination = this.toSafeWorktreePath(projectName, branchName);
      try {
        const { path: workingDirectory } = await gitService.createWorktree(
          repoPath,
          branchName,
          worktreeDestination,
          worktreeStartPoint,
          { fetchRemote: params.fetchRemote }
        );
        return { workingDirectory, branchName, baseBranch };
      } catch (error) {
        if (!params.baseBranch) {
          const recoveredBaseBranch = await this.recoverMissingProjectBaseBranch(
            error,
            project,
            repoPath,
            worktreeStartPoint
          );
          if (recoveredBaseBranch) {
            worktreeStartPoint = recoveredBaseBranch;
            baseBranch = recoveredBaseBranch;
            // Retry the same branch candidate; base-branch recovery is not a name conflict.
            attempt--;
            continue;
          }
        }

        const normalizedError = this.normalizeCreateWorktreeError(error, branchName);
        const isConflict =
          normalizedError.message.includes('already has an active worktree') ||
          normalizedError.message.includes('already open in workspace');

        if (!isConflict || !shouldAutoResolveBranchConflict) {
          throw normalizedError;
        }
        branchName = nextCandidate(attempt);
      }
    }

    throw new Error(
      `Could not find an available branch name after ${AUTO_BRANCH_MAX_ATTEMPTS} attempts. Please try again.`
    );
  }

  /**
   * Validate directory-mode params and return the resolved working directory.
   * Mutates params.name to fall back to the directory basename when blank, so
   * the caller's later `params.name || 'Workspace'` still reflects this.
   */
  private resolveDirectoryWorkingDirectory(params: CreateWorkspaceParams): string {
    let directoryPath = params.directoryPath;
    if (params.projectId) {
      const project = projectService.get(params.projectId);
      if (!project) {
        throw new Error(`Project ${params.projectId} not found`);
      }
      if (project.kind !== 'directory') {
        throw new Error('Directory mode requires a directory project');
      }
      directoryPath = project.repositoryPath;
    }

    if (!directoryPath) {
      throw new Error('Directory path is required for directory mode');
    }
    // A folder opens as its folder project, so it gets the project's color, icon and settings.
    if (!params.projectId) {
      params.projectId = projectService.findOrCreateDirectoryProject(directoryPath).id;
    }

    // Directory workspaces don't detect git — add as a project for git features
    if (!params.name) {
      params.name = basename(directoryPath);
    }
    return directoryPath;
  }

  /**
   * After auto-resolving a branch conflict, derive a friendlier workspace
   * name from the final branch suffix when the caller didn't supply one.
   */
  private applyAutoNameFromBranch(
    params: CreateWorkspaceParams,
    project: Project,
    branchName: string
  ): void {
    if (params.autoResolveBranchConflicts !== true || params.customName) return;
    const prefix = this.branchPrefix(project);
    const suffix = branchName.toLowerCase().startsWith(prefix.toLowerCase())
      ? branchName.slice(prefix.length)
      : branchName.includes('/')
        ? branchName.slice(branchName.lastIndexOf('/') + 1)
        : branchName;
    if (suffix) {
      params.name = branchSuffixToName(suffix);
    }
  }

  /**
   * Resolve the first terminal's command from initialCommand / preset /
   * launch mode / initialPrompt. initialCommand always wins; otherwise the
   * preset's launch mode (when matched) drives, falling back to the prompt
   * command, then the openCommand. Attachment references follow the prompt.
   */
  private resolveInitialCommand(
    params: CreateWorkspaceParams,
    activePreset: AgentPreset | null | undefined,
    workspace: Workspace,
    attachmentRefs: string[] = []
  ): string | null {
    if (params.initialCommand) return params.initialCommand;
    if (!activePreset) return null;
    const prompt =
      isSshWorkspace(workspace) && isProjectSetupPrompt(params.initialPrompt)
        ? buildProjectSetupPrompt()
        : params.initialPrompt;
    const initialPrompt =
      attachmentRefs.length > 0
        ? [prompt?.trim(), attachmentRefs.join(' ')].filter(Boolean).join('\n\n')
        : prompt;
    return this.resolveAgentCommand(
      activePreset,
      initialPrompt,
      params.launchModeId,
      isSshWorkspace(workspace) ? 'posix' : undefined,
      workspace.reasoningLevelId
    );
  }

  /**
   * Copies the files pasted into the new-workspace prompt into the workspace's
   * `.komla-files/`, on its SSH host for a remote one, and returns their `@path`
   * references. A file that can't be copied fails the launch rather than
   * starting the agent without it.
   */
  private async importPromptAttachments(
    workspace: Workspace,
    params: CreateWorkspaceParams,
    activePreset: AgentPreset | null | undefined
  ): Promise<string[]> {
    if (!activePreset || params.initialCommand || !params.attachments?.length) return [];
    return Promise.all(
      params.attachments.map(async (sourcePath) => {
        try {
          return `@${await workspaceFileService.importExternalFileInto(workspace, sourcePath)}`;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Couldn't attach ${basename(sourcePath)}: ${reason}`, { cause: err });
        }
      })
    );
  }

  /**
   * Fails a launch whose attachments have gone missing before anything is created,
   * so the dialog keeps them for a retry instead of leaving a half-made workspace.
   */
  private async assertPromptAttachmentsExist(params: CreateWorkspaceParams): Promise<void> {
    if (params.initialCommand || !params.attachments?.length) return;
    await Promise.all(
      params.attachments.map(async (sourcePath) => {
        let reason: string | undefined;
        try {
          if (!(await stat(sourcePath)).isFile()) reason = 'it isn’t a file';
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          reason = code === 'ENOENT' ? 'it no longer exists' : (err as Error).message;
        }
        if (reason) throw new Error(`Couldn't attach ${basename(sourcePath)}: ${reason}`);
      })
    );
  }

  /** Names the workspace from its prompt in the background; resolves once that has finished. */
  private maybeAutoName(
    workspace: Workspace,
    params: CreateWorkspaceParams
  ): Promise<void> | undefined {
    if (params.initialPrompt && !params.customName) {
      return this.generateWorkspaceName(workspace.id, params.initialPrompt, workspace.presetId)
        .then(() => {})
        .catch((err) => logger.debug('Auto-naming failed:', err));
    }
    return undefined;
  }

  /**
   * Tells hooks a workspace was created once its terminals have started and it has its name, so
   * they see the title the sidebar shows; naming that takes too long doesn't hold them back.
   */
  private publishCreated(workspace: Workspace, naming: Promise<void> | undefined): void {
    const publish = () =>
      publishHookEvent({ event: 'workspace.created', workspaceId: workspace.id });
    if (!naming) {
      publish();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      naming,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CREATED_HOOK_NAMING_WAIT_MS);
      }),
    ]).then(() => {
      clearTimeout(timer);
      publish();
    });
  }

  private async finishProvisioning(
    workspaceId: string,
    params: CreateWorkspaceParams,
    project: Project
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    // Check if this provisioning was cancelled (e.g., workspace was deleted)
    if (this.provisioningCancelled.has(workspaceId)) {
      this.provisioningCancelled.delete(workspaceId);
      return;
    }

    try {
      // 1. Resolve branch name: use provided name, generate via AI, or fall back to random
      const repoPath =
        project.managed && project.managedRepoPath
          ? project.managedRepoPath
          : project.repositoryPath;

      const prefix = this.branchPrefix(project);
      const hasProvidedBranch = !!params.branchName;
      let branchName: string;
      let aiTitle: string | undefined;
      let aiDescription: string | undefined;
      // Controls whether conflicts use numeric suffixes (true) or random retries (false)
      let preserveNameOnConflict: boolean;

      if (hasProvidedBranch) {
        // Branch name already provided — sanitize and use (with prefix if needed)
        // Fall back to a random suffix if sanitization strips everything
        const sanitized = sanitizeBranchName(params.branchName!) || generateBranchSuffix();
        branchName = params.useExactBranchName
          ? sanitized
          : this.withBranchPrefix(sanitized, this.branchPrefix(project));
        preserveNameOnConflict = true;

        logger.debug(`Provisioning ${workspaceId}: using provided branch name`, {
          branchName,
          exact: params.useExactBranchName,
        });
      } else {
        const aiResult = await this.generateAIBranchSuffix(workspaceId, params, repoPath);
        if (aiResult.cancelled) return;
        aiTitle = aiResult.aiTitle;
        aiDescription = aiResult.aiDescription;
        const suffix = aiResult.branchSuffix || generateBranchSuffix();
        branchName = this.withBranchPrefix(suffix, prefix);
        preserveNameOnConflict = !!aiResult.branchSuffix;
      }

      logger.debug(`Provisioning ${workspaceId}: resolved branch name: ${branchName}`);

      // Check workspace still exists (may have been deleted during AI generation)
      // Also check if provisioning was cancelled
      if (this.consumeBranchNamingCheckpoint(workspaceId)) return;

      // 2. Create worktree with conflict resolution
      const projectName = project.name;
      // A focus during branch naming may have started a background fetch since create().
      gitService.stopBackgroundWork(repoPath);
      const target = await this.resolveLocalWorkspaceTarget(params, project, repoPath);
      let baseBranch = target.baseBranch;
      const worktreeStartPoint = target.startPoint;
      await this.fastForwardManagedProjectTargetBeforeCreation(
        params,
        project,
        repoPath,
        target.baseBranch
      );
      logger.debug(
        `Provisioning ${workspaceId}: creating worktree in ${repoPath} from startPoint=${worktreeStartPoint ?? '(default)'} baseBranch=${baseBranch ?? '(none)'}`
      );
      // When the caller provided an explicit branch name, only auto-resolve
      // conflicts if they opted in. AI/random names always auto-resolve.
      const shouldAutoResolve = hasProvidedBranch
        ? params.autoResolveBranchConflicts === true
        : true;

      const worktreeResult = await this.createWorktreeWithConflictResolution(
        workspace,
        params,
        project,
        branchName,
        preserveNameOnConflict,
        shouldAutoResolve,
        worktreeStartPoint,
        baseBranch,
        repoPath,
        projectName
      );
      branchName = worktreeResult.resolvedBranchName;
      baseBranch = worktreeResult.resolvedBaseBranch;
      const workingDirectory = worktreeResult.workingDirectory;

      // Check workspace still exists after worktree creation (or was cancelled)
      if (
        await this.consumeWorktreeCheckpoint(
          workspaceId,
          repoPath,
          workingDirectory,
          branchName,
          worktreeResult.createdBranch
        )
      )
        return;

      // 3. Update workspace with resolved values
      logger.debug(`Provisioning ${workspaceId}: worktree created at ${workingDirectory}`);
      this.applyProvisionedWorkspaceState(
        workspace,
        workingDirectory,
        branchName,
        baseBranch,
        prefix,
        aiTitle,
        aiDescription,
        params
      );
      logger.info(`Provisioning ${workspaceId}: complete — branch=${branchName}`);

      // 4. Register target branch with git service
      if (workspace.baseBranch) {
        gitService.registerTargetBranch(workspace.workingDirectory, workspace.baseBranch);
      }

      // 5. Start file watcher (fire-and-forget)
      worktreeWatcherService
        .startWatching(workspace.id, workspace.workingDirectory)
        .catch((err) => {
          logger.error(`Failed to start watcher for workspace ${workspace.id}:`, err);
        });

      // 6. Create terminal(s) and trigger optional auto-naming
      await this.startProvisionedTerminals(workspace, params, aiTitle);
    } catch (err) {
      await this.recordProvisioningError(workspaceId, err);
    }
  }

  /**
   * Resolve a branch suffix and (optionally) workspace title/description via AI.
   * Returns `cancelled: true` when provisioning was cancelled between the
   * combined naming and branch-only fallback so the caller can bail before
   * issuing a second AI call. NOTE: this path does not consume the cancel flag
   * (matching pre-refactor behavior); finishProvisioning's early return then
   * skips the post-branch-naming checkpoint, so the entry persists in
   * `provisioningCancelled` for that one specific path. Acceptable in practice
   * because workspace IDs are UUIDs (no recycling).
   */
  private async generateAIBranchSuffix(
    workspaceId: string,
    params: CreateWorkspaceParams,
    repoPath: string
  ): Promise<{
    branchSuffix: string | null;
    aiTitle?: string;
    aiDescription?: string;
    cancelled: boolean;
  }> {
    const workspace = this.workspaces.get(workspaceId);
    const provisionConfig = configService.get();
    const resolvedPresetId = params.presetId ?? workspace?.presetId;
    const wantBranch = params.autoNameBranches ?? provisionConfig.autoNameBranches === true;
    const wantTitle = provisionConfig.autoNameWorkspaces !== 'off' && !params.customName;

    logger.debug(`Provisioning ${workspaceId}: starting AI name generation`, {
      hasPrompt: !!params.initialPrompt?.trim(),
      hasCustomName: !!params.customName,
      repoPath,
    });

    let branchSuffix: string | null = null;
    let aiTitle: string | undefined;
    let aiDescription: string | undefined;

    if (!params.initialPrompt?.trim()) {
      return { branchSuffix, aiTitle, aiDescription, cancelled: false };
    }

    const prompt = params.initialPrompt.trim();

    if (wantBranch && wantTitle) {
      try {
        const combined = await this.generateProvisioningNames(
          prompt,
          workspaceId,
          resolvedPresetId
        );
        if (combined) {
          branchSuffix = combined.branch;
          aiTitle = combined.title;
          aiDescription = combined.description;
          logger.debug(`Provisioning ${workspaceId}: combined naming succeeded`, {
            branch: combined.branch,
            title: combined.title,
          });
        } else {
          logger.debug(`Provisioning ${workspaceId}: combined naming returned null`);
        }
      } catch (err) {
        logger.debug(`Provisioning ${workspaceId}: combined naming failed:`, err);
      }

      if (!this.workspaces.has(workspaceId) || this.provisioningCancelled.has(workspaceId)) {
        logger.debug(`Provisioning ${workspaceId}: cancelled after combined naming`);
        return { branchSuffix, aiTitle, aiDescription, cancelled: true };
      }

      // If combined failed but we still want a branch name, try branch-only
      if (!branchSuffix) {
        try {
          branchSuffix = await this.generateBranchName(prompt, workspaceId, resolvedPresetId);
          logger.debug(`Provisioning ${workspaceId}: branch-only naming result: ${branchSuffix}`);
        } catch (err) {
          logger.debug(`Provisioning ${workspaceId}: branch-only naming failed:`, err);
        }
      }
    } else if (wantBranch) {
      // Only need branch name (title disabled or customName already set)
      try {
        branchSuffix = await this.generateBranchName(prompt, workspaceId, resolvedPresetId);
        logger.debug(`Provisioning ${workspaceId}: branch naming result: ${branchSuffix}`);
      } catch (err) {
        logger.debug(`Provisioning ${workspaceId}: branch naming failed:`, err);
      }
    }
    // If only wantTitle (!wantBranch): skip AI here — maybeAutoName handles it later

    return { branchSuffix, aiTitle, aiDescription, cancelled: false };
  }

  /**
   * Create the worktree, retrying with auto-generated branch-name candidates
   * when the chosen name conflicts with an existing workspace or worktree.
   * Mutates `workspace` so the in-progress repoPath is persisted before the
   * next cancellation checkpoint can run cleanup.
   */
  private async createWorktreeWithConflictResolution(
    workspace: Workspace,
    params: CreateWorkspaceParams,
    project: Project,
    initialBranchName: string,
    preserveNameOnConflict: boolean,
    shouldAutoResolve: boolean,
    worktreeStartPoint: string | undefined,
    baseBranch: string | undefined,
    repoPath: string,
    projectName: string
  ): Promise<{
    workingDirectory: string;
    resolvedBranchName: string;
    resolvedBaseBranch: string | undefined;
    createdBranch: boolean;
  }> {
    const triedBranchNames = new Set<string>();
    let branchName = initialBranchName;
    let workingDirectory: string | undefined;
    let effectiveWorktreeStartPoint = worktreeStartPoint;
    let effectiveBaseBranch = baseBranch;
    let createdBranch = false;

    for (let attempt = 1; attempt <= AUTO_BRANCH_MAX_ATTEMPTS; attempt++) {
      const existingWorkspace = this.findBranchConflict(
        params.projectId!,
        branchName,
        workspace.id
      );
      if (existingWorkspace) {
        if (!shouldAutoResolve) {
          throw this.createBranchConflictError(branchName, existingWorkspace);
        }
        branchName = this.createAutoBranchCandidate(
          initialBranchName,
          this.branchPrefix(project),
          attempt,
          preserveNameOnConflict
        );
        if (triedBranchNames.has(branchName)) continue;
        triedBranchNames.add(branchName);
        continue;
      }

      const worktreeDestination = this.toSafeWorktreePath(projectName, branchName);
      try {
        // Cancel cleanup may delete only a branch this attempt created.
        ({ path: workingDirectory, createdBranch } = await gitService.createWorktree(
          repoPath,
          branchName,
          worktreeDestination,
          effectiveWorktreeStartPoint,
          { fetchRemote: params.fetchRemote }
        ));
        workspace.workingDirectory = workingDirectory;
        workspace.branchName = branchName;
        workspace.baseBranch = effectiveBaseBranch;
        workspace.provisioningRepoPath = repoPath;
        workspace.provisioningBranchCreated = createdBranch;
        this.saveWorkspaces();
        break;
      } catch (error) {
        if (!params.baseBranch) {
          const recoveredBaseBranch = await this.recoverMissingProjectBaseBranch(
            error,
            project,
            repoPath,
            effectiveWorktreeStartPoint
          );
          if (recoveredBaseBranch) {
            effectiveWorktreeStartPoint = recoveredBaseBranch;
            effectiveBaseBranch = recoveredBaseBranch;
            // Retry the same branch candidate; base-branch recovery is not a name conflict.
            attempt--;
            continue;
          }
        }

        const normalizedError = this.normalizeCreateWorktreeError(error, branchName);
        const isConflict =
          normalizedError.message.includes('already has an active worktree') ||
          normalizedError.message.includes('already open in workspace');

        if (!isConflict || !shouldAutoResolve) throw normalizedError;

        branchName = this.createAutoBranchCandidate(
          initialBranchName,
          this.branchPrefix(project),
          attempt,
          preserveNameOnConflict
        );
        if (triedBranchNames.has(branchName)) continue;
        triedBranchNames.add(branchName);
      }
    }

    if (!workingDirectory) {
      throw new Error(
        `Could not find an available branch name after ${AUTO_BRANCH_MAX_ATTEMPTS} attempts.`
      );
    }

    return {
      workingDirectory,
      resolvedBranchName: branchName,
      resolvedBaseBranch: effectiveBaseBranch,
      createdBranch,
    };
  }

  private async fastForwardManagedProjectTargetBeforeCreation(
    params: CreateWorkspaceParams,
    project: Project,
    repoPath: string,
    resolvedTarget: string | undefined
  ): Promise<void> {
    if (!project.managed || !project.managedRepoPath || !resolvedTarget) return;

    const projectTarget = project.baseBranch?.trim() || undefined;
    const requestedStartPoint = params.baseBranch?.trim() || undefined;
    if (requestedStartPoint && requestedStartPoint !== projectTarget) return;

    await gitService.fastForwardBranchToRemoteIfSafe(repoPath, resolvedTarget);
  }

  /**
   * Checkpoint after AI branch naming: returns true if the workspace was
   * deleted or provisioning was cancelled and the caller should bail. Cancel
   * is checked first so the typical "delete during provisioning" path (which
   * sets the flag *and* removes the workspace) consumes the flag instead of
   * leaking an entry in `provisioningCancelled`.
   */
  private consumeBranchNamingCheckpoint(workspaceId: string): boolean {
    if (this.provisioningCancelled.has(workspaceId)) {
      logger.debug('Provisioning: cancelled after branch naming');
      this.provisioningCancelled.delete(workspaceId);
      return true;
    }
    if (!this.workspaces.has(workspaceId)) {
      logger.debug('Provisioning: workspace was deleted during branch naming');
      return true;
    }
    return false;
  }

  /**
   * Checkpoint after worktree creation: returns true if the caller should bail.
   * When cancelled or deleted, runs best-effort worktree cleanup so we don't
   * leave an orphan checkout on disk.
   */
  private async consumeWorktreeCheckpoint(
    workspaceId: string,
    repoPath: string,
    workingDirectory: string,
    branchName: string,
    createdBranch: boolean
  ): Promise<boolean> {
    if (!this.workspaces.has(workspaceId) || this.provisioningCancelled.has(workspaceId)) {
      await this.cleanupCancelledProvisioning(
        workspaceId,
        repoPath,
        workingDirectory,
        branchName,
        createdBranch
      );
      return true;
    }
    return false;
  }

  /**
   * Cancellation cleanup invoked after the worktree has been created but the
   * workspace was deleted (or cancellation flagged) before we could finalise.
   * Best-effort delete of the orphan worktree; never throws.
   */
  private async cleanupCancelledProvisioning(
    workspaceId: string,
    repoPath: string,
    workingDirectory: string,
    branchName: string,
    createdBranch: boolean
  ): Promise<void> {
    try {
      await gitService.deleteWorktree(repoPath, workingDirectory, true, {
        deleteBranch: createdBranch,
        branchName,
      });
    } catch {
      // Best-effort cleanup
    }
    if (this.provisioningCancelled.has(workspaceId)) {
      logger.debug('Provisioning: cancelled after worktree creation');
      this.provisioningCancelled.delete(workspaceId);
    }
  }

  /** Slice the prefix or path segment off a resolved branch name to derive a workspace label. */
  private deriveBranchSuffixForName(branchName: string, prefix: string): string {
    if (branchName.toLowerCase().startsWith(prefix.toLowerCase())) {
      return branchName.slice(prefix.length);
    }
    if (branchName.includes('/')) {
      return branchName.slice(branchName.lastIndexOf('/') + 1);
    }
    return branchName;
  }

  /**
   * Apply the resolved worktree + AI-generated values onto the in-memory workspace
   * and persist. Mutates `workspace`. Does not broadcast — the caller decides when
   * to surface the update to renderers.
   */
  private applyProvisionedWorkspaceState(
    workspace: Workspace,
    workingDirectory: string,
    branchName: string,
    baseBranch: string | undefined,
    prefix: string,
    aiTitle: string | undefined,
    aiDescription: string | undefined,
    params: CreateWorkspaceParams
  ): void {
    const branchSuffixForName = this.deriveBranchSuffixForName(branchName, prefix);

    workspace.workingDirectory = workingDirectory;
    workspace.branchName = branchName;
    workspace.baseBranch = baseBranch;
    workspace.name = branchSuffixToName(branchSuffixForName) || workspace.name;
    workspace.provisioning = false;
    workspace.provisionStatus = undefined;
    workspace.provisionError = undefined;
    workspace.provisioningRepoPath = undefined;
    // SSH provisioning clears its own ownership flags once the workspace is safely persisted.
    if (!isSshWorkspace(workspace)) workspace.provisioningBranchCreated = undefined;

    // Apply AI-generated title/description from the combined call
    if (aiTitle && !params.customName) {
      workspace.customName = aiTitle;
      workspace.customNameSource = 'generated';
      workspace.customNameGeneratedAt = Date.now();
      workspace.promptSubmitsSinceCustomNameGeneration = 0;
      if (aiDescription) {
        workspace.customDescription = aiDescription;
      }
    }

    this.saveWorkspaces();
  }

  /**
   * Pin the active preset, resolve the launch command, then either run setup
   * steps or spawn a single terminal. Triggers separate auto-naming only when
   * the combined AI call didn't already produce a title.
   */
  private async startProvisionedTerminals(
    workspace: Workspace,
    params: CreateWorkspaceParams,
    aiTitle: string | undefined
  ): Promise<void> {
    const activePreset = this.resolvePreset(params.presetId, workspace);
    workspace.presetId = activePreset?.id ?? null;
    workspace.launchModeId = this.resolveLaunchModeId(activePreset, params.launchModeId);
    workspace.reasoningLevelId = this.resolveReasoningLevelId(
      activePreset,
      params.reasoningLevelId
    );
    if (activePreset && !params.skipRecordUsage) {
      agentPresetService.recordPresetUsage?.(
        activePreset.id,
        params.launchModeId,
        params.reasoningLevelId
      );
    }
    const command = this.resolveInitialCommand(
      params,
      activePreset,
      workspace,
      await this.importPromptAttachments(workspace, params, activePreset)
    );

    if (params.projectId) {
      const primaryTerminal = workspaceSetupService.start(workspace, command, 'create');
      if (primaryTerminal) {
        this.broadcastWorkspaceUpdate(workspace);
        this.publishCreated(workspace, aiTitle ? undefined : this.maybeAutoName(workspace, params));
        return;
      }
    }

    const terminal = await this.addTerminal(workspace.id, workspace.name, command);
    workspace.primaryTerminalId = terminal.id;

    this.broadcastWorkspaceUpdate(workspace);
    this.publishCreated(workspace, aiTitle ? undefined : this.maybeAutoName(workspace, params));
  }

  /**
   * Persist provisioning failure on the workspace and surface it. When the
   * provisioning was cancelled (workspace deleted during AI/worktree work) the
   * error is swallowed — the cancel flag is consumed and no error state is set.
   */
  private async recordProvisioningError(workspaceId: string, err: unknown): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    const wasCancelled = this.provisioningCancelled.has(workspaceId);
    if (wasCancelled) {
      this.provisioningCancelled.delete(workspaceId);
      return;
    }
    if (ws) {
      ws.provisioning = false;
      ws.provisionStatus = undefined;
      ws.provisionError = err instanceof Error ? err.message : 'Workspace setup failed';
      ws.provisioningRepoPath = undefined;
      try {
        this.broadcastWorkspaceUpdate(ws);
      } catch (broadcastErr) {
        logger.warn('Failed to broadcast provisioning error update:', broadcastErr);
      }

      if (isSshWorkspace(ws)) {
        for (const terminal of ws.terminals) {
          ptyService.releaseTerminal(terminal.id);
        }
        ws.terminals = [];
        ws.primaryTerminalId = undefined;
        if ((await sshWorkspaceProvisioningService.recover(ws, 'failed')) === 'retain') {
          try {
            await this.saveWorkspacesImmediateChecked();
          } catch (saveError) {
            logger.error('Failed to persist recoverable SSH workspace', saveError, {
              workspaceId,
            });
            this.saveWorkspaces();
          }
          this.broadcastWorkspacesChanged();
          logger.error(`Provisioning failed for workspace ${workspaceId}:`, err);
          return;
        }
        this.workspaces.delete(workspaceId);
        this.attention.workspaceDeleted(workspaceId);
        for (const remainingWorkspace of this.workspaces.values()) {
          if ((remainingWorkspace.order ?? 0) > (ws.order ?? 0)) {
            remainingWorkspace.order = (remainingWorkspace.order ?? 0) - 1;
          }
        }
        void remoteWorkspaceObservationService.reconcile();
        try {
          await this.saveWorkspacesImmediateChecked();
        } catch (saveError) {
          logger.error('Failed to persist removal of failed SSH workspace', saveError, {
            workspaceId,
          });
          this.saveWorkspaces();
        }
        this.broadcastWorkspacesChanged();
      } else {
        this.saveWorkspaces();
      }
    }
    logger.error(`Provisioning failed for workspace ${workspaceId}:`, err);
  }

  private updateProvisionStatus(workspaceId: string, status: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !workspace.provisioning) return;
    workspace.provisionStatus = status;
    this.saveWorkspaces();
    try {
      this.broadcastWorkspaceUpdate(workspace);
    } catch (err) {
      logger.warn('Failed to broadcast provisioning status update:', err);
    }
  }

  private normalizePromptSubmit(prompt: string | undefined): string | null {
    const normalized = prompt?.trim().replace(/\r\n|\r/g, '\n');
    if (!normalized) return null;
    return truncatePromptForStorage(normalized);
  }

  recordPromptSubmit(workspaceId: string, prompt: string, terminalId?: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    const normalized = this.normalizePromptSubmit(prompt);
    if (!normalized) return;
    const isFirstPromptSubmit = !workspace.promptSubmits || workspace.promptSubmits.length === 0;
    const previousPrompt = workspace.promptSubmits?.[workspace.promptSubmits.length - 1]?.prompt;
    if (previousPrompt === normalized) return;

    const promptSubmits = compactPromptSubmits([
      ...(workspace.promptSubmits ?? []),
      { prompt: normalized, submittedAt: Date.now(), ...(terminalId && { terminalId }) },
    ]);

    workspace.promptSubmits = promptSubmits;
    if (
      workspace.customNameSource === 'generated' ||
      workspace.autoNaming ||
      this.autoNamingControllers.has(workspace.id)
    ) {
      workspace.promptSubmitsSinceCustomNameGeneration =
        (workspace.promptSubmitsSinceCustomNameGeneration ?? 0) + 1;
    }
    this.saveWorkspaces();
    this.broadcastWorkspaceUpdate(workspace);

    if (
      isFirstPromptSubmit &&
      !workspace.customName &&
      !workspace.autoNaming &&
      !this.autoNamingControllers.has(workspace.id)
    ) {
      this.generateWorkspaceName(workspace.id, normalized, workspace.presetId).catch((err) =>
        logger.debug('Auto-naming from prompt-submit failed:', err)
      );
    } else if (this.shouldRegenerateGeneratedWorkspaceName(workspace)) {
      const promptContext = this.buildPromptSubmitRenameContext(workspace);
      if (!promptContext) return;
      this.generateWorkspaceName(workspace.id, promptContext, workspace.presetId, {
        replaceCustomName: true,
        replaceCustomNameSource: 'generated',
      }).catch((err) => logger.debug('Auto-renaming from prompt-submit drift failed:', err));
    }
  }

  /** Tags the workspace for where its pull request stands, as `pullRequestTagUpdate` decides. */
  applyPullRequestTag(workspaceId: string, state: PullRequestTagState | undefined): void {
    const workspace = this.workspaces.get(workspaceId);
    const update =
      workspace &&
      pullRequestTagUpdate(
        workspace,
        state,
        normalizeWorkspaceTags(configService.get().workspaceTags)
      );
    if (!workspace || !update) return;
    Object.assign(workspace, update);
    this.saveWorkspaces();
    this.broadcastWorkspaceUpdate(workspace);
  }

  /**
   * Keeps an agent's final reply with the latest prompt sent in its Terminal, so labeling sees what
   * the prompt was about. Without a prompt there, the reply answers none Komla recorded.
   */
  recordAgentReply(workspaceId: string, reply: string, terminalId?: string): void {
    const workspace = this.workspaces.get(workspaceId);
    const promptSubmits = workspace?.promptSubmits;
    const normalized = truncateReplyForStorage(reply.trim().replace(/\r\n|\r/g, '\n'));
    if (!workspace || !promptSubmits || !normalized) return;
    const index = promptSubmits.findLastIndex((entry) => entry.terminalId === terminalId);
    // A later reply to the same prompt, such as one after background work, replaces the earlier one.
    if (index === -1 || promptSubmits[index].reply === normalized) return;

    workspace.promptSubmits = compactPromptSubmits(
      promptSubmits.map((entry, i) => (i === index ? { ...entry, reply: normalized } : entry))
    );
    this.saveWorkspaces();
  }

  private shouldRegenerateGeneratedWorkspaceName(workspace: Workspace): boolean {
    if (workspace.customNameSource !== 'generated') return false;
    if (!workspace.customName) return false;
    if (workspace.autoNaming || this.autoNamingControllers.has(workspace.id)) return false;

    const submitsSinceGeneration = workspace.promptSubmitsSinceCustomNameGeneration ?? 0;
    if (submitsSinceGeneration < AUTO_RENAME_PROMPT_SUBMIT_THRESHOLD) return false;

    const generatedAt = workspace.customNameGeneratedAt;
    if (!generatedAt) return false;

    return Date.now() - generatedAt >= AUTO_RENAME_MIN_INTERVAL_MS;
  }

  /**
   * An agent waiting on the user, or failing, ends its workspace's snooze early, as any
   * notification does for a snooze until notified.
   */
  private wakeSnoozedForAttention(workspaceId: string, attention: WorkspaceAttention): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    if (!attentionWakesSnooze(workspace, attention)) return;
    wakeWorkspace(workspace, attention.updatedAt);
    this.saveWorkspaces();
    this.broadcastWorkspaceUpdate(workspace);
    this.snoozeAlarm.check();
    this.attention.workspaceStatusChanged();
  }

  /** Calls `listener` with each workspace update broadcast to the windows, until unsubscribed. */
  onWorkspaceUpdated(listener: (workspace: Workspace) => void): () => void {
    this.workspaceUpdateListeners.add(listener);
    return () => this.workspaceUpdateListeners.delete(listener);
  }

  /** Calls `listener` with each attention a Terminal or workspace raises, until unsubscribed. */
  onAttentionRaised(listener: (event: WorkspaceAttentionEvent) => void): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  private notifyListeners<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        logger.warn('Workspace listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Broadcast a workspace update to all renderer windows. */
  broadcastWorkspaceUpdate(workspace: Workspace): void {
    publishRemoteWorkspaceChange();
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.WORKSPACE_UPDATED, workspace);
      }
    }
    this.notifyListeners(this.workspaceUpdateListeners, workspace);
  }

  private broadcastWorkspacesChanged(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.WORKSPACES_CHANGED);
      }
    }
  }

  private normalizeUtilityTitle(title: string): string | null {
    const normalized = title.trim().slice(0, MAX_UTILITY_TITLE_LENGTH);
    const capitalized = normalized.replace(/^\p{Ll}/u, (match) => match.toUpperCase());
    return capitalized || null;
  }

  private buildPromptSubmitRenameContext(workspace: Workspace): string | null {
    const promptSubmits = workspace.promptSubmits ?? [];
    if (promptSubmits.length === 0) return null;

    const pinnedCount = Math.min(PINNED_FIRST_PROMPT_SUBMITS, promptSubmits.length);
    const pinnedChunks: string[] = [];
    const latestChunks: string[] = [];
    let totalLength = 0;

    // Neutralize closing tags so prompt or reply text cannot end its block or the
    // <prompts> wrapper the inference provider adds.
    const neutralize = (text: string): string =>
      text.replace(/<\/(prompts?|agent_reply)\b/gi, '<\\/$1');

    const takeBlock = (entry: (typeof promptSubmits)[number]): string | null => {
      const prompt = neutralize(entry.prompt);
      const separatorLength =
        pinnedChunks.length + latestChunks.length > 0 ? RENAME_PROMPT_CONTEXT_SEPARATOR.length : 0;
      const available =
        MAX_RENAME_PROMPT_CONTEXT_CHARS -
        totalLength -
        separatorLength -
        wrapRenamePrompt('').length;
      if (available <= 0) return null;

      let block = wrapRenamePrompt(
        prompt.length > available ? prompt.slice(0, available).trimEnd() : prompt
      );
      if (entry.reply) {
        const reply = RENAME_PROMPT_CONTEXT_SEPARATOR + wrapRenameReply(neutralize(entry.reply));
        // A reply is only worth its room in full.
        if (
          totalLength + separatorLength + block.length + reply.length <=
          MAX_RENAME_PROMPT_CONTEXT_CHARS
        ) {
          block += reply;
        }
      }
      totalLength += separatorLength + block.length;
      return block;
    };

    // Keep the first prompts, then fill the remaining room with the newest of the rest.
    for (let index = 0; index < pinnedCount; index++) {
      const block = takeBlock(promptSubmits[index]);
      if (!block) break;
      pinnedChunks.push(block);
    }
    for (let index = promptSubmits.length - 1; index >= pinnedCount; index--) {
      const block = takeBlock(promptSubmits[index]);
      if (!block) break;
      latestChunks.unshift(block);
    }

    const chunks = [...pinnedChunks, ...latestChunks];
    return chunks.length > 0 ? chunks.join(RENAME_PROMPT_CONTEXT_SEPARATOR) : null;
  }

  async regenerateWorkspaceName(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (workspace.autoNaming) return workspace;

    const promptContext = this.buildPromptSubmitRenameContext(workspace);
    if (!promptContext) {
      throw new Error('No recorded prompts for this workspace');
    }

    try {
      await this.generateWorkspaceName(workspaceId, promptContext, workspace.presetId, {
        ignoreAutoNameSetting: true,
        throwOnFailure: true,
        replaceCustomName: true,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }

    const updated = this.workspaces.get(workspaceId);
    if (!updated) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    return updated;
  }

  /** Apply an auto-generated name to a workspace if it still exists. Returns true if applied. */
  private applyAutoName(
    workspaceId: string,
    name: string,
    description?: string,
    options: {
      replaceCustomName?: boolean;
      replaceCustomNameSource?: WorkspaceCustomNameSource;
      promptSubmitsAtRequestStart?: number;
    } = {}
  ): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      logger.debug('Auto-naming: workspace no longer exists');
      return false;
    }
    if (workspace.customName && !options.replaceCustomName) {
      logger.debug('Auto-naming: workspace already has a custom name, skipping');
      workspace.autoNaming = false;
      this.broadcastWorkspaceUpdate(workspace);
      return false;
    }
    if (
      options.replaceCustomNameSource &&
      workspace.customNameSource !== options.replaceCustomNameSource
    ) {
      logger.debug('Auto-naming: workspace custom name source changed, skipping');
      workspace.autoNaming = false;
      this.broadcastWorkspaceUpdate(workspace);
      return false;
    }

    const normalizedName = this.normalizeUtilityTitle(name);
    if (!normalizedName) {
      logger.warn('Auto-naming: generated title normalized to empty value');
      workspace.autoNaming = false;
      this.broadcastWorkspaceUpdate(workspace);
      return false;
    }

    workspace.customName = normalizedName;
    workspace.customNameSource = 'generated';
    workspace.customNameGeneratedAt = Date.now();
    workspace.promptSubmitsSinceCustomNameGeneration =
      options.promptSubmitsAtRequestStart === undefined
        ? 0
        : Math.max(
            0,
            (workspace.promptSubmitsSinceCustomNameGeneration ?? 0) -
              options.promptSubmitsAtRequestStart
          );
    if (description) {
      workspace.customDescription = description;
    } else if (options.replaceCustomName) {
      workspace.customDescription = undefined;
    }
    workspace.autoNaming = false;
    this.saveWorkspaces();

    logger.info(`Auto-named workspace ${workspaceId}: "${normalizedName}"`);

    this.broadcastWorkspaceUpdate(workspace);
    return true;
  }

  /** Clear the auto-naming flag on a workspace (e.g. on failure). */
  private clearAutoNaming(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && workspace.autoNaming) {
      workspace.autoNaming = false;
      this.broadcastWorkspaceUpdate(workspace);
    }
  }

  private async generateWorkspaceName(
    workspaceId: string,
    initialPrompt: string,
    _presetId?: string | null,
    options: {
      ignoreAutoNameSetting?: boolean;
      replaceCustomName?: boolean;
      replaceCustomNameSource?: WorkspaceCustomNameSource;
      throwOnFailure?: boolean;
    } = {}
  ): Promise<void> {
    const config = configService.get();
    if (config.autoNameWorkspaces === 'off' && !options.ignoreAutoNameSetting) {
      logger.debug('Auto-naming skipped: disabled in settings');
      return;
    }
    // Only a request someone made says why it can't run; automatic naming just skips.
    if (!options.throwOnFailure && !utilityInferenceService.isAvailable()) {
      logger.debug('Auto-naming skipped: no AI helper available in this build');
      return;
    }

    const controller = new AbortController();
    try {
      logger.info(`Auto-naming workspace ${workspaceId}: using utility inference`);

      // Signal to the renderer that auto-naming is in progress
      const workspace = this.workspaces.get(workspaceId);
      const promptSubmitsAtRequestStart = workspace?.promptSubmitsSinceCustomNameGeneration ?? 0;
      if (workspace) {
        workspace.autoNaming = true;
        this.broadcastWorkspaceUpdate(workspace);
      }

      this.autoNamingControllers.set(workspaceId, controller);

      const result = await utilityInferenceService.labelWorkspace(initialPrompt, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!result.title) {
        logger.debug(`Auto-naming skipped for workspace ${workspaceId}: insufficient context`);
        this.clearAutoNaming(workspaceId);
        if (options.throwOnFailure) {
          throw new Error('Utility inference returned no workspace title');
        }
        return;
      }
      const applied = this.applyAutoName(
        workspaceId,
        result.title,
        result.description ?? undefined,
        { ...options, promptSubmitsAtRequestStart }
      );
      if (!applied && options.throwOnFailure) {
        throw new Error('Unable to apply generated workspace title');
      }
    } catch (err) {
      if (this.autoNamingControllers.get(workspaceId) === controller) {
        this.clearAutoNaming(workspaceId);
      }
      if (isAbortError(err)) {
        logger.debug(`Auto-naming aborted for workspace ${workspaceId}`);
        if (options.throwOnFailure) {
          throw err;
        }
        return;
      }
      logger.warn('Auto-naming failed:', err);
      if (options.throwOnFailure) {
        throw err;
      }
    } finally {
      if (this.autoNamingControllers.get(workspaceId) === controller) {
        this.autoNamingControllers.delete(workspaceId);
      }
    }
  }

  /**
   * Combined AI call: generate workspace title, description, AND branch name in one shot.
   * Used during deferred provisioning to avoid two separate AI calls.
   */
  private async generateProvisioningNames(
    promptText: string,
    provisioningWorkspaceId?: string,
    _presetId?: string | null
  ): Promise<{ title: string; description?: string; branch: string } | null> {
    if (!utilityInferenceService.isAvailable()) return null;
    const requestId = provisioningWorkspaceId ?? `provision-${Date.now()}`;
    const controller = new AbortController();
    this.provisioningControllers.set(requestId, controller);

    try {
      logger.info('Generating workspace title + branch name with utility inference');

      const result = await utilityInferenceService.labelWorkspaceAndBranch(promptText, {
        signal: controller.signal,
      });
      if (!result.title) {
        logger.debug('Combined naming: title is null (insufficient context)', {
          provisioningWorkspaceId,
        });
        return null;
      }
      const title = this.normalizeUtilityTitle(result.title);
      if (!title) {
        logger.warn('Combined naming returned an invalid title', {
          title: result.title,
          provisioningWorkspaceId,
        });
        return null;
      }
      if (!result.branchName) {
        logger.debug('Combined naming: branchName is null (insufficient context)', {
          provisioningWorkspaceId,
        });
        return null;
      }
      const branch = sanitizeBranchSuffix(result.branchName);
      if (branch.length < 3) {
        logger.warn('Combined naming returned an invalid branch suffix', {
          branchName: result.branchName,
          sanitizedBranch: branch,
          provisioningWorkspaceId,
        });
        return null;
      }

      return {
        title,
        description: result.description ?? undefined,
        branch,
      };
    } catch (err) {
      if (isAbortError(err)) {
        logger.debug(
          `Combined naming aborted for workspace ${provisioningWorkspaceId ?? 'unknown'}`
        );
        return null;
      }
      logger.debug(`Combined naming failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (this.provisioningControllers.get(requestId) === controller) {
        this.provisioningControllers.delete(requestId);
      }
    }
  }

  /** Generate an AI-powered branch name suffix from a prompt. Returns the sanitized suffix or null on failure. */
  async generateBranchName(
    promptText: string,
    provisioningWorkspaceId?: string,
    _presetId?: string | null
  ): Promise<string | null> {
    if (!utilityInferenceService.isAvailable()) return null;
    const requestId = `branch-${Date.now()}-${Math.random()}`;
    const controller = new AbortController();
    this.branchNamingControllers.set(requestId, controller);
    if (provisioningWorkspaceId) {
      this.provisioningControllers.set(provisioningWorkspaceId, controller);
    }

    try {
      logger.info('Generating branch name with utility inference');

      const result = await utilityInferenceService.nameBranch(promptText, {
        signal: controller.signal,
      });
      if (!result.branchName) {
        logger.debug('Branch naming returned null: insufficient context');
        return null;
      }
      const branchName = sanitizeBranchSuffix(result.branchName);
      if (branchName.length < 3) {
        logger.warn('Branch naming returned an invalid branch suffix', {
          branchName: result.branchName,
          sanitizedBranch: branchName,
          provisioningWorkspaceId,
        });
        return null;
      }

      logger.info(`Generated branch name: "${branchName}"`);
      return branchName;
    } catch (err) {
      if (isAbortError(err)) {
        logger.debug(`Branch naming aborted for workspace ${provisioningWorkspaceId ?? 'manual'}`);
        return null;
      }
      logger.debug(`Branch naming failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (this.branchNamingControllers.get(requestId) === controller) {
        this.branchNamingControllers.delete(requestId);
      }
      if (
        provisioningWorkspaceId &&
        this.provisioningControllers.get(provisioningWorkspaceId) === controller
      ) {
        this.provisioningControllers.delete(provisioningWorkspaceId);
      }
    }
  }

  /** Cancel an in-flight branch naming request. */
  cancelBranchNaming(): void {
    for (const [requestId, controller] of this.branchNamingControllers) {
      controller.abort();
      this.branchNamingControllers.delete(requestId);
    }
  }

  // Find the lowest available terminal number for a workspace
  private nextTerminalNumber(workspace: Workspace): number {
    const usedNumbers = new Set(
      workspace.terminals
        .map((t) => {
          const match = t.name.match(/^Terminal (\d+)$/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((n): n is number => n !== null)
    );
    let n = 1;
    while (usedNumbers.has(n)) n++;
    return n;
  }

  addTerminal(
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    commandKind: CommandKind = 'agent',
    executionLocation: TerminalExecutionLocation = 'workspace',
    prepareBeforeLaunch?: () => Promise<void>
  ): Terminal | Promise<Terminal> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (this.isDeleting(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} is being deleted`);
    }
    const location = executionLocations.resolve(workspace, executionLocation);

    const terminalId = this.generateTerminalId();

    // Resolve the spawn command FIRST — if this throws, we must not leave
    // behind a phantom terminal, inflated pendingRemoteStarts, or a saved
    // auto-activation that never actually started a PTY.
    const resolved = location.buildCommand(command ?? null, { commandKind, terminalId });

    // Check if the running workspace limit allows it (before auto-activating dormant state).
    const reservedStartSlot = this.reserveWorkspaceStartSlot(workspace, executionLocation);
    let startSlotReleased = false;
    const releaseStartSlot = () => {
      if (!reservedStartSlot || startSlotReleased) return;
      startSlotReleased = true;
      this.pendingRemoteStarts = Math.max(0, this.pendingRemoteStarts - 1);
    };

    // Auto-activate dormant workspaces when starting (after license check passes)
    if (workspace.status !== 'active') {
      workspace.status = 'active';
      this.moveFolderIntoProject(workspace);
      this.attention.workspaceStatusChanged();
      this.saveWorkspaces();
      // Restart watcher (was stopped when workspace was made dormant)
      if (!isSshWorkspace(workspace)) {
        worktreeWatcherService
          .startWatching(workspaceId, workspace.workingDirectory)
          .catch((err) => {
            logger.error(
              `Failed to start watcher for auto-activated workspace ${workspaceId}:`,
              err
            );
          });
      }
    }

    const terminalNumber = this.nextTerminalNumber(workspace);
    const terminalName = name || `Terminal ${terminalNumber}`;

    const terminal: Terminal = {
      id: terminalId,
      name: terminalName,
      status: 'starting',
      createdAt: Date.now(),
      executionLocation,
      ...(layoutHint ? { layoutHint } : {}),
    };

    workspace.terminals.push(terminal);

    const spawnRequest = {
      workspaceId,
      terminalId,
      command: resolved,
      keepShellOpenAfterCommand: commandKind === 'host',
      releaseStartSlot,
    };

    if (location.managesSession) {
      try {
        location.spawn(spawnRequest);
        return terminal;
      } catch (error) {
        const terminalIndex = workspace.terminals.indexOf(terminal);
        if (terminalIndex !== -1) workspace.terminals.splice(terminalIndex, 1);
        void remoteWorkspaceObservationService.reconcile();
        throw error;
      }
    }

    const failDeferredTerminal = (error: unknown): Terminal => {
      terminal.status = 'stopped';
      terminal.startupError = error instanceof Error ? error.message : String(error);
      void remoteWorkspaceObservationService.reconcile();
      this.saveWorkspaces();
      this.broadcastWorkspacesChanged();
      return terminal;
    };

    const launchTerminal = (keepOnFailure = false): Terminal => {
      // Spawn PTY — on synchronous failure (e.g. invalid cwd, native pty
      // failure) remove the terminal we just pushed so the workspace doesn't
      // end up with a permanently-'starting' ghost tab.
      try {
        location.spawn(spawnRequest);
      } catch (err) {
        if (keepOnFailure) {
          return failDeferredTerminal(err);
        }
        const idx = workspace.terminals.indexOf(terminal);
        if (idx !== -1) workspace.terminals.splice(idx, 1);
        void remoteWorkspaceObservationService.reconcile();
        throw err;
      }

      // A Local copy Terminal of an SSH workspace is persisted with it.
      if (isSshWorkspace(workspace)) {
        this.saveWorkspaces();
      }

      return terminal;
    };

    const deferredPreparation = prepareBeforeLaunch;

    if (deferredPreparation) {
      const launchToken = this.beginDeferredTerminalLaunch(terminal.id, false, releaseStartSlot);
      void deferredPreparation().then(
        () => {
          if (
            !this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken) ||
            this.workspaces.get(workspaceId) !== workspace ||
            !workspace.terminals.includes(terminal) ||
            terminal.status !== 'starting'
          ) {
            releaseStartSlot();
            return terminal;
          }
          this.finishDeferredTerminalLaunch(terminal.id, launchToken);
          return launchTerminal(true);
        },
        (error) => {
          releaseStartSlot();
          if (
            !this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken) ||
            this.workspaces.get(workspaceId) !== workspace ||
            !workspace.terminals.includes(terminal)
          ) {
            return terminal;
          }
          this.finishDeferredTerminalLaunch(terminal.id, launchToken);
          failDeferredTerminal(error);
          return terminal;
        }
      );
      return terminal;
    }

    return launchTerminal();
  }

  async addTerminalWithPreparation(
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    commandKind: CommandKind = 'agent',
    executionLocation: TerminalLaunchLocation = 'workspace'
  ): Promise<Terminal> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

    const effectiveLocation: TerminalExecutionLocation =
      executionLocation === 'remote'
        ? 'workspace'
        : isSshWorkspace(workspace) &&
            (executionLocation === 'local-mirror' ||
              (this.getSshWorkspaceMode(workspace) === 'local-mirror-actions' &&
                commandKind === 'host'))
          ? 'local-mirror'
          : executionLocation;
    const localCopyPreparation =
      effectiveLocation === 'local-mirror'
        ? () => {
            const location = executionLocations.resolve(workspace, effectiveLocation);
            return location.managesSession
              ? Promise.resolve()
              : (location.prepare?.(command ?? null) ?? Promise.resolve());
          }
        : undefined;
    return this.addTerminal(
      workspaceId,
      name,
      command,
      layoutHint,
      commandKind,
      effectiveLocation,
      localCopyPreparation
    );
  }

  /**
   * Resolve the spawn command for an agent tab from a preset + optional
   * launchMode + optional prompt. The non-obvious bit: when `launchModeId`
   * is supplied but doesn't match any mode on the preset (stale id from a
   * removed launch mode), we silently fall through to the no-mode path
   * rather than failing — the launch still produces a usable terminal.
   */
  private resolveAgentCommand(
    preset: ReturnType<WorkspaceService['resolvePreset']> | null,
    prompt: string | undefined,
    launchModeId: string | undefined,
    shellFamily?: 'posix',
    reasoningLevelId?: string | null
  ): string | null {
    if (!preset) return null;
    const resolve = (text: string | undefined) =>
      agentPresetService.resolvePresetCommand(
        preset,
        text ? 'prompt' : 'open',
        launchModeId,
        text,
        shellFamily,
        reasoningLevelId
      );
    // An agent that can't start with a prompt still opens.
    return resolve(prompt) || (prompt && resolve(undefined)) || null;
  }

  // Add an agent tab to a workspace, resolving the command from the active preset.
  // keepWorkspaceAgent leaves the workspace's agent and the last agent used as they were,
  // for a one-off tab such as agent setup.
  addAgentTab(
    workspaceId: string,
    prompt?: string,
    launchModeId?: string,
    presetId?: string,
    { keepWorkspaceAgent = false }: AddAgentTabOptions = {}
  ): Terminal | Promise<Terminal> {
    const workspace = this.workspaces.get(workspaceId);
    const resolvedPresetId = presetId ?? workspace?.presetId;
    const activePreset = this.resolvePreset(resolvedPresetId);
    const effectivePrompt =
      workspace && isSshWorkspace(workspace) && isProjectSetupPrompt(prompt)
        ? buildProjectSetupPrompt()
        : prompt;
    const command = this.resolveAgentCommand(
      activePreset,
      effectivePrompt,
      launchModeId,
      workspace && isSshWorkspace(workspace) ? 'posix' : undefined
    );

    // Apply the preset to the workspace BEFORE spawning. Stash the prior values
    // and restore them if spawn fails, otherwise a failed launch would
    // permanently corrupt the workspace's preset selection.
    const prevPresetId = workspace?.presetId;
    const prevLaunchModeId = workspace?.launchModeId;
    let persistChanges = false;
    if (workspace && !keepWorkspaceAgent) {
      if (activePreset && workspace.presetId !== activePreset.id) {
        workspace.presetId = activePreset.id;
        persistChanges = true;
      }
      const resolvedLaunchModeId = this.resolveLaunchModeId(activePreset, launchModeId);
      if (activePreset && (workspace.launchModeId ?? null) !== resolvedLaunchModeId) {
        workspace.launchModeId = resolvedLaunchModeId;
        persistChanges = true;
      }
    }

    const finish = (terminal: Terminal): Terminal => {
      if (persistChanges) {
        this.saveWorkspaces();
      }
      metricsCollectorService.increment('agentTabsCreated');

      if (activePreset && !keepWorkspaceAgent) {
        agentPresetService.recordPresetUsage?.(activePreset.id, launchModeId);
      }

      return terminal;
    };
    const rollback = (error: unknown): never => {
      if (workspace && persistChanges) {
        workspace.presetId = prevPresetId;
        workspace.launchModeId = prevLaunchModeId;
      }
      throw error;
    };

    try {
      const terminal = this.addTerminal(workspaceId, undefined, command);
      return terminal instanceof Promise ? terminal.then(finish, rollback) : finish(terminal);
    } catch (err) {
      return rollback(err);
    }
  }

  // Remove a terminal from a workspace
  async removeTerminal(workspaceId: string, terminalId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found in workspace ${workspaceId}`);
    }

    const pendingLaunch = this.cancelDeferredTerminalLaunch(terminal.id);
    if (pendingLaunch) terminal.status = 'stopped';
    // Permanently tear down the Terminal's execution (idempotent - safe if not running)
    const released = executionLocations
      .resolve(workspace, terminal.executionLocation)
      .release(terminalId);
    if (released) await released;
    this.attention.removed(workspaceId, terminalId);

    // Found again: session recovery can replace the list while the release runs.
    const terminalIndex = workspace.terminals.findIndex((t) => t.id === terminalId);
    if (terminalIndex !== -1) workspace.terminals.splice(terminalIndex, 1);

    // If the removed terminal was the primary, update to first remaining terminal
    if (workspace.primaryTerminalId === terminalId) {
      workspace.primaryTerminalId =
        workspace.terminals.length > 0 ? workspace.terminals[0].id : undefined;
    }
    this.saveWorkspaces();
    this.broadcastWorkspaceUpdate(workspace);
  }

  // Find which workspace a terminal belongs to
  findWorkspaceByTerminalId(terminalId: string): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.terminals.some((t) => t.id === terminalId)) {
        return workspace;
      }
    }
    return undefined;
  }

  // Get terminal by ID
  getTerminal(terminalId: string): Terminal | undefined {
    for (const workspace of this.workspaces.values()) {
      const terminal = workspace.terminals.find((t) => t.id === terminalId);
      if (terminal) {
        return terminal;
      }
    }
    return undefined;
  }

  async stop(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    // Stopping again, as moving to the Trash does, would kill the last stop's steps.
    const stopSteps = workspaceSetupService.stopStepsSettled(workspaceId);
    if (stopSteps) await stopSteps;
    const wasRunning = isRunningHere(workspace);
    await workspaceSetupService.cancel(workspaceId);
    workspaceSetupService.clearActive(workspace.id);
    if (isSshWorkspace(workspace)) {
      this.cancelDeferredWorkspaceLaunches(workspace);
    }
    try {
      const stopping = executionLocations.stopSessions(workspace);
      if (stopping) await stopping;
    } catch (error) {
      throw new Error(
        `Could not confirm all remote agents stopped; the workspace remains active. ${String(error)}`
      );
    }
    workspace.lastStoppedAt = Date.now();

    // Stop all terminals in the workspace (stopping is idempotent)
    for (const terminal of executionLocations.stopAttached(workspace)) {
      terminal.status = 'stopped';
    }
    workspaceSetupService.stopBackground(workspaceId);
    // Starting or deleting the workspace waits for them.
    if (wasRunning) void workspaceSetupService.runStopSteps(workspace);
    void remoteWorkspaceObservationService.reconcile();
    this.attention.workspaceStopped(workspaceId);

    // Stop file watcher — the renderer retains cached git status
    await worktreeWatcherService.stopWatching(workspaceId);
    await sshPortForwardService.stopPreviewForward(workspaceId);

    this.saveWorkspaces();
  }

  /** The workspace's running workspace-stop steps, if any. */
  stopStepsSettled(workspaceId: string): Promise<void> | undefined {
    return workspaceSetupService.stopStepsSettled(workspaceId);
  }

  /**
   * At quit, stops the local workspaces whose projects have workspace-stop steps and runs those
   * steps, waiting at most `timeLimitMs`. SSH workspaces keep running on their hosts, so theirs
   * don't run.
   */
  async runStopStepsBeforeQuit(timeLimitMs: number): Promise<void> {
    const runs = [...this.workspaces.values()].flatMap((workspace) => {
      const running = workspaceSetupService.stopStepsSettled(workspace.id);
      if (running) return [running];
      if (
        isSshWorkspace(workspace) ||
        !isRunningHere(workspace) ||
        !workspaceSetupService.hasStopSteps(workspace)
      ) {
        return [];
      }
      executionLocations.stopAttached(workspace);
      workspaceSetupService.stopBackground(workspace.id);
      return [workspaceSetupService.runStopSteps(workspace, timeLimitMs)];
    });
    if (runs.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(runs),
      new Promise((resolve) => (timer = setTimeout(resolve, timeLimitMs))),
    ]);
    clearTimeout(timer);
  }

  async stopTerminal(terminalId: string): Promise<void> {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (!workspace) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (terminal) {
      const pendingLaunch = this.cancelDeferredTerminalLaunch(terminal.id);
      if (pendingLaunch) terminal.status = 'stopped';
      const stopped = executionLocations
        .resolve(workspace, terminal.executionLocation)
        .stop(terminalId);
      if (stopped) await stopped;
      terminal.status = 'stopped';
      this.attention.ended(terminalId);
      void remoteWorkspaceObservationService.reconcile();
    }
  }

  restartTerminal(
    terminalId: string,
    presetId?: string,
    launchModeId?: string,
    cols?: number,
    rows?: number,
    options: Partial<RestartTerminalOptions> & {
      plainShell?: boolean;
      sshAction?: 'reconnect' | 'replace';
    } = {}
  ): Terminal | Promise<Terminal> {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (!workspace) {
      throw new Error(`Terminal ${terminalId} not found`);
    }
    if (this.isDeleting(workspace.id)) {
      throw new Error(`Workspace ${workspace.id} is being deleted`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`);
    }
    if (options.executionLocation === 'local-mirror') {
      return this.restartTerminalInLocalCopy(workspace, terminal, cols, rows);
    }
    // An agent always runs on the SSH host, so it moves a Local copy terminal back there, as
    // does a shell asked for there.
    if (
      isSshWorkspace(workspace) &&
      terminal.executionLocation === 'local-mirror' &&
      (options.executionLocation === 'workspace' ||
        (options.sshAction === 'replace' && !options.plainShell))
    ) {
      return this.restartTerminalOnHost(workspace, terminal, presetId, launchModeId, cols, rows, {
        ...options,
        // Asked only to move, it gets a shell there; a replacement without one starts an agent.
        plainShell: options.plainShell ?? options.sshAction !== 'replace',
        sshAction: 'replace',
      });
    }

    const replaceWithRemoteAgent =
      isSshWorkspace(workspace) && options.sshAction === 'replace' && !options.plainShell;
    if (replaceWithRemoteAgent) {
      terminal.executionLocation = 'workspace';
      terminal.startupError = undefined;
    }
    const location = executionLocations.resolve(workspace, terminal.executionLocation);

    const shouldCountAsStart = this.reserveWorkspaceStartSlot(
      workspace,
      terminal.executionLocation
    );
    let startSlotReleased = false;
    const releaseStartSlot = () => {
      if (!shouldCountAsStart || startSlotReleased) return;
      startSlotReleased = true;
      if (this.pendingRemoteStarts > 0) this.pendingRemoteStarts--;
    };
    const activePreset = options.plainShell
      ? null
      : options.command !== undefined && !presetId
        ? undefined
        : this.resolvePreset(presetId, workspace);
    const command =
      options?.command ?? this.resolveAgentCommand(activePreset, undefined, launchModeId);
    const resolved = location.buildCommand(command, {
      commandKind: options?.commandKind ?? 'agent',
      terminalId,
    });

    const applyRestartMetadata = (): void => {
      this.attention.replaced(terminalId);
      terminal.dynamicTitle = undefined;
    };
    if (!location.managesSession) {
      applyRestartMetadata();
      terminal.status = 'starting';
      terminal.startupError = undefined;
    }
    const completeRestart = (): Terminal => {
      let persistChanges = false;
      if (activePreset && workspace.presetId !== activePreset.id) {
        workspace.presetId = activePreset.id;
        persistChanges = true;
      }
      const resolvedLaunchModeId = this.resolveLaunchModeId(activePreset, launchModeId);
      if (activePreset && (workspace.launchModeId ?? null) !== resolvedLaunchModeId) {
        workspace.launchModeId = resolvedLaunchModeId;
        persistChanges = true;
      }
      if (persistChanges) this.saveWorkspaces();
      if (activePreset) agentPresetService.recordPresetUsage?.(activePreset.id, launchModeId);
      return terminal;
    };
    if (!location.managesSession) {
      const launchTerminal = (): Terminal => {
        try {
          location.restart({
            workspaceId: workspace.id,
            terminalId,
            command: resolved,
            cols,
            rows,
            releaseStartSlot,
          });
        } catch (error) {
          terminal.status = 'stopped';
          void remoteWorkspaceObservationService.reconcile();
          throw error;
        }
        return completeRestart();
      };

      if (location.prepare) {
        const launchToken = this.beginDeferredTerminalLaunch(terminal.id, false, releaseStartSlot);
        return location
          .prepare(resolved.command)
          .then(() => {
            if (
              !this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken) ||
              this.workspaces.get(workspace.id) !== workspace ||
              !workspace.terminals.includes(terminal) ||
              terminal.status !== 'starting'
            ) {
              releaseStartSlot();
              return terminal;
            }
            this.finishDeferredTerminalLaunch(terminal.id, launchToken);
            return launchTerminal();
          })
          .catch((error) => {
            if (this.isDeferredTerminalLaunchCurrent(terminal.id, launchToken)) {
              this.finishDeferredTerminalLaunch(terminal.id, launchToken);
              terminal.status = 'stopped';
              terminal.startupError = error instanceof Error ? error.message : String(error);
            }
            releaseStartSlot();
            throw error;
          });
      }
      return launchTerminal();
    }
    const managedRequest = {
      workspaceId: workspace.id,
      terminalId,
      command: resolved,
      keepShellOpenAfterCommand: options.commandKind === 'host',
      cols,
      rows,
      releaseStartSlot,
      onAuthorized: applyRestartMetadata,
    };
    const launch =
      options.sshAction === 'reconnect'
        ? location.reconnect(managedRequest)
        : location.replace({ ...managedRequest, explicit: options.sshAction === 'replace' });
    const finishManagedRestart = (result: { kind: 'ready' | 'superseded' }): Terminal =>
      result.kind === 'ready' ? completeRestart() : terminal;
    return launch instanceof Promise
      ? launch.then(finishManagedRestart)
      : finishManagedRestart(launch);
  }

  /** Replaces a Terminal's remote session with a plain shell in the workspace's Local copy. */
  private async restartTerminalInLocalCopy(
    workspace: Workspace,
    terminal: Terminal,
    cols?: number,
    rows?: number
  ): Promise<Terminal> {
    if (!isSshWorkspace(workspace)) {
      throw new Error('Local terminals require an SSH workspace');
    }
    if (executionLocations.managesSession(workspace, terminal.executionLocation)) {
      const isCurrent = () =>
        !this.isDeleting(workspace.id) &&
        this.workspaces.get(workspace.id) === workspace &&
        workspace.terminals.includes(terminal);
      // Prepare first so a Local copy that cannot start leaves the remote session running.
      const localCopy = executionLocations.resolve(workspace, 'local-mirror');
      if (!localCopy.managesSession) await localCopy.prepare?.(null);
      if (!isCurrent()) return terminal;
      await executionLocations.resolve(workspace, terminal.executionLocation).stop(terminal.id, {
        skipTrackedAbsentSession: true,
      });
      if (!isCurrent()) return terminal;
      terminal.executionLocation = 'local-mirror';
      Object.assign(terminal, encodeTerminalExecution({ kind: 'moved-to-local-copy' }));
      this.saveWorkspaces();
      void remoteWorkspaceObservationService.reconcile();
    }
    return this.restartTerminal(terminal.id, undefined, undefined, cols, rows, {
      plainShell: true,
      commandKind: 'host-shell',
    });
  }

  /**
   * Replaces a Local copy Terminal's shell with a session on the SSH host. The Local shell stops
   * first, so a host that can't be reached leaves the Terminal stopped on the host instead of
   * marked as on the host over a Local shell still running.
   */
  private async restartTerminalOnHost(
    workspace: Workspace,
    terminal: Terminal,
    presetId: string | undefined,
    launchModeId: string | undefined,
    cols: number | undefined,
    rows: number | undefined,
    options: Partial<RestartTerminalOptions> & { plainShell?: boolean; sshAction: 'replace' }
  ): Promise<Terminal> {
    const isCurrent = () =>
      !this.isDeleting(workspace.id) &&
      this.workspaces.get(workspace.id) === workspace &&
      workspace.terminals.includes(terminal);
    // A Local shell still waiting on its first sync must not start once the Terminal has moved.
    this.cancelDeferredTerminalLaunch(terminal.id);
    await executionLocations.resolve(workspace, terminal.executionLocation).stop(terminal.id);
    if (!isCurrent()) return terminal;
    terminal.executionLocation = 'workspace';
    terminal.startupError = undefined;
    this.saveWorkspaces();
    void remoteWorkspaceObservationService.reconcile();
    return this.restartTerminal(terminal.id, presetId, launchModeId, cols, rows, {
      ...options,
      executionLocation: undefined,
    });
  }

  reconnectSshTerminal(
    terminalId: string,
    cols?: number,
    rows?: number
  ): Terminal | Promise<Terminal> {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
    if (!workspace || !executionLocations.managesSession(workspace, terminal?.executionLocation)) {
      throw new Error(`SSH terminal ${terminalId} not found`);
    }
    return this.restartTerminal(terminalId, undefined, undefined, cols, rows, {
      plainShell: true,
      sshAction: 'reconnect',
    });
  }

  findInSshTerminal(terminalId: string, query: string): Promise<ManagedTmuxFindResult> {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    const terminal = workspace?.terminals.find((candidate) => candidate.id === terminalId);
    const backend = workspace?.backend;
    if (
      !workspace ||
      backend?.kind !== 'ssh' ||
      !executionLocations.managesSession(workspace, terminal?.executionLocation)
    ) {
      throw new Error(`SSH terminal ${terminalId} not found`);
    }
    return sshWorkspaceService.findInTerminalSession(backend, terminalId, query);
  }

  async delete(
    workspaceId: string,
    force = false,
    deleteBranch = false,
    options: { skipBackendCleanup?: boolean } = {}
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    if (this.isDeleting(workspaceId)) {
      throw new Error(`Workspace ${workspaceId} is being deleted`);
    }
    this.deletingWorkspaceIds.add(workspaceId);
    try {
      await this.deleteWorkspace(workspace, force, deleteBranch, options);
    } finally {
      this.deletingWorkspaceIds.delete(workspaceId);
    }
  }

  private async deleteWorkspace(
    workspace: Workspace,
    force: boolean,
    deleteBranch: boolean,
    options: { skipBackendCleanup?: boolean }
  ): Promise<void> {
    const workspaceId = workspace.id;
    // The renderer offers branch deletion only where this allows it; never delete the target branch.
    const deletesBranch =
      deleteBranch &&
      canDeleteWorkspaceBranch(workspace, this.workspaceProject(workspace)?.baseBranch);
    const wasRunning = isRunningHere(workspace);
    workspaceSetupService.cancel(workspace.id, 'pending');

    this.cancelDeferredWorkspaceLaunches(workspace);
    try {
      const releasing = executionLocations.releaseSessions(workspace, {
        skipRemoteConfirmation: options.skipBackendCleanup,
      });
      if (releasing) await releasing;
    } catch (error) {
      throw new Error(
        `Could not confirm all remote agents stopped; workspace deletion was cancelled. ${String(error)}`
      );
    }
    await workspaceSetupService.cancel(workspaceId);
    workspaceSetupService.cancel(workspaceId, 'updates');

    // Unregister target branch from git service
    if (workspace.workingDirectory && !isSshWorkspace(workspace)) {
      gitService.registerTargetBranch(workspace.workingDirectory, undefined);
    }

    // Stop watching for git status changes
    await worktreeWatcherService.stopWatching(workspaceId);

    // Kill background processes for this workspace. Await exit so live shells
    // don't outlive the worktree removal below (would emit shell-init: getcwd
    // warnings and break any in-flight git push from the PTY).
    await workspaceSetupService.stopBackground(workspaceId, { waitForExit: true });
    const stopPreviewForwardPromise = sshPortForwardService.stopPreviewForward(workspaceId);

    // Mark workspace as provisioning-cancelled so finishProvisioning will bail out early
    if (workspace.provisioning) {
      this.provisioningCancelled.add(workspaceId);
    }

    const autoNamingController = this.autoNamingControllers.get(workspaceId);
    if (autoNamingController) {
      autoNamingController.abort();
      this.autoNamingControllers.delete(workspaceId);
    }

    const provisioningController = this.provisioningControllers.get(workspaceId);
    if (provisioningController) {
      provisioningController.abort();
      this.provisioningControllers.delete(workspaceId);
    }

    // Permanently tear down all terminals and wait for their native processes
    // to exit before removing a worktree or local mirror containing their cwd.
    const releasingAttached = executionLocations.releaseAttached(workspace);
    if (releasingAttached) await releasingAttached;

    // Once its terminals are gone, a running workspace's stop steps, such as
    // `docker compose down`, run before its directory goes.
    const stopSteps =
      wasRunning && !options.skipBackendCleanup && workspaceSetupService.hasStopSteps(workspace)
        ? workspaceSetupService.runStopSteps(workspace)
        : workspaceSetupService.stopStepsSettled(workspaceId);
    if (stopSteps) await stopSteps;

    // Delete worktree if applicable (skip if provisioning never completed)
    if (options.skipBackendCleanup) {
      // Backend already gone or intentionally left in place, along with its manifest.
      await this.sshSync.deleted(workspace, { leftOnHost: true });
    } else if (isSshWorkspace(workspace)) {
      await sshWorkspaceService.deleteWorkspace(
        workspace.backend,
        deletesBranch,
        workspace.branchName,
        { allowBranchToRemain: true }
      );
      await this.sshSync.deleted(workspace, { leftOnHost: false });
    } else if (workspace.isWorktree && workspace.projectId && workspace.workingDirectory) {
      const project = projectService.get(workspace.projectId);
      // A missing directory still leaves git's worktree record (and maybe the branch) to clean
      // up, unless provisioning never got as far as creating it.
      if (
        project &&
        (existsSync(workspace.workingDirectory) ||
          (!workspace.provisioning && this.canCleanUpMissingWorktree(workspace.workingDirectory)))
      ) {
        // For managed projects, use the bare clone path
        const repoPath =
          project.managed && project.managedRepoPath
            ? project.managedRepoPath
            : project.repositoryPath;
        const worktreePath = workspace.workingDirectory;
        await deleteReleasingOpenCodeLocation(worktreePath, () =>
          gitService.deleteWorktree(repoPath, worktreePath, force, {
            deleteBranch: deletesBranch,
            branchName: workspace.branchName,
          })
        );
      }
    }

    // A workspace is not fully deleted until its local mirror is gone. Keep
    // the workspace record when this fails so deletion can be retried safely;
    // remote cleanup above is idempotent.
    if (isSshWorkspace(workspace)) {
      await localMirrorService.remove(workspaceId, workspace.backend);
    }

    // Tear down bidirectional links after worktree deletion succeeds so a
    // failed delete does not silently lose link state.
    try {
      await workspaceLinksService.unlinkAll(workspaceId);
    } catch (err) {
      logger.warn(`Failed to unlink workspace ${workspaceId} during delete:`, err);
    }

    this.workspaces.delete(workspaceId);
    this.attention.workspaceDeleted(workspaceId);
    this.trashNotes(workspaceId);
    void remoteWorkspaceObservationService.reconcile();
    await workspaceStatusService.change({ kind: 'workspace-removed', workspaceId });
    // Use immediate save for deletion to ensure consistency
    try {
      await this.saveWorkspacesImmediateChecked();
    } catch (error) {
      // Backend deletion cannot be rolled back. Keep the workspace deleted in
      // this session instead of reporting a retryable failure to the renderer.
      logger.warn(`Workspace ${workspaceId} was deleted but could not be persisted:`, error);
      this.saveWorkspaces();
    }
    await Promise.all([
      stopPreviewForwardPromise,
      isSshWorkspace(workspace) ? Promise.resolve() : localMirrorService.remove(workspaceId),
    ]);
  }

  /** Notes belong to their workspace; the trash keeps any still wanted. */
  private trashNotes(workspaceId: string): void {
    void notesService.trashAll(workspaceId).catch((error: unknown) => {
      logger.warn(`Could not move workspace ${workspaceId}'s notes to the trash:`, error);
    });
  }

  async deleteAll(): Promise<void> {
    const ids = Array.from(this.workspaces.keys());
    for (const id of ids) {
      try {
        await this.delete(id, true);
      } catch (err) {
        logger.error('Failed to delete workspace during deleteAll', err, { workspaceId: id });
      }
    }
  }

  async deleteSshHost(
    hostId: string,
    options: { deleteRemoteData?: boolean } = {}
  ): Promise<{ deletedWorkspaceIds: string[] }> {
    if (!sshHostService.has(hostId)) {
      throw new Error(`SSH host ${hostId} not found`);
    }

    const matchingWorkspaces = Array.from(this.workspaces.values()).filter(
      (workspace) => isSshWorkspace(workspace) && workspace.backend.hostId === hostId
    );

    if (options.deleteRemoteData) {
      await sshWorkspaceService.deleteHostData(hostId);
    } else {
      for (const workspace of matchingWorkspaces) {
        await executionLocations.stopSessions(workspace);
      }
    }

    for (const workspace of matchingWorkspaces) {
      await this.delete(workspace.id, true, false, {
        skipBackendCleanup: true,
      });
    }

    const lastEnvironment = configService.get().lastWorkspaceEnvironment;
    if (lastEnvironment?.kind === 'ssh' && lastEnvironment.hostId === hostId) {
      configService.update({ lastWorkspaceEnvironment: undefined });
    }
    if (configService.get().agentLaunchDefaultSshHostId === hostId) {
      configService.update({ agentLaunchDefaultSshHostId: undefined });
    }
    const syncDisabledHostIds = configService.get().workspaceSyncDisabledHostIds;
    if (syncDisabledHostIds?.includes(hostId)) {
      configService.update({
        workspaceSyncDisabledHostIds: syncDisabledHostIds.filter((id) => id !== hostId),
      });
    }
    sshWorkspaceService.forgetHost(hostId);
    sshHostService.delete(hostId);
    // Only now: a sync reading the host meanwhile could add them back. Adding the host back does.
    this.sshSync.hostForgotten(matchingWorkspaces.map((workspace) => workspace.id));
    void remoteWorkspaceObservationService.reconcile();
    return { deletedWorkspaceIds: matchingWorkspaces.map((workspace) => workspace.id) };
  }

  /**
   * A git project's clone on this computer, or on an SSH host where it has workspaces, its
   * target branch, and the branches leftover-branch cleanup leaves alone. A managed clone and
   * a host's clone are bare, with a local copy of every branch on origin.
   */
  async getBranchCleanupScope(projectId: string, hostId: string | null = null) {
    const project = projectService.get(projectId);
    if (!project) throw new Error('Project not found');
    if (project.kind === 'directory') throw new Error('Directory projects have no branches');
    const workspaces = this.getWorkspacesByProjectId(projectId);
    if (hostId) {
      const backend = workspaces
        .filter(isSshWorkspace)
        .map((workspace) => workspace.backend)
        .find((candidate) => candidate.hostId === hostId);
      if (!backend) throw new Error('The project has no workspaces on this host');
      // Empty: the host clone's HEAD, which is origin's default branch.
      const targetBranch = toLocalBranchName(project.baseBranch ?? '');
      // Another project can share the clone when it has the same name and origin.
      const sharing = [...this.workspaces.values()].filter(
        (workspace) =>
          isSshWorkspace(workspace) &&
          workspace.backend.hostId === hostId &&
          workspace.backend.remoteRepoPath === backend.remoteRepoPath
      );
      return {
        repo: sshWorkspaceGit.gitBatchRunner(hostId, backend.remoteRepoPath),
        targetBranch,
        keep: getBranchesInUse(targetBranch ? [targetBranch] : [], [...workspaces, ...sharing]),
        skipBranchesOnOrigin: true,
      };
    }
    const repoPath = projectRepoPath(project);
    const mainBranch = await gitService.getMainBranch(repoPath);
    const targetBranch = toLocalBranchName(project.baseBranch ?? '') || mainBranch;
    return {
      repo: localGitBatchRunner(repoPath),
      targetBranch,
      keep: getBranchesInUse([mainBranch, targetBranch], workspaces),
      skipBranchesOnOrigin: project.managed,
    };
  }

  /**
   * How each of the project's worktree workspaces stands against its target branch. Each
   * worktree's HEAD and uncommitted files are read in the worktree itself, on its SSH host for
   * an SSH workspace; whether HEAD landed is then checked once per repository and target branch,
   * in the project's repository the worktree belongs to. Workspaces in the Trash, or whose
   * files aren't ready, are left out.
   */
  async checkWorkspacesForCleanup(projectId: string): Promise<WorkspaceCleanupStatus[]> {
    const project = projectService.get(projectId);
    if (!project) throw new Error('Project not found');
    if (project.kind === 'directory') return [];
    const workspaces = this.getWorkspacesByProjectId(projectId).filter(
      (workspace) =>
        workspace.status === 'active' && workspace.isWorktree && hasWorkspaceFiles(workspace)
    );
    const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
      const loaded = cache.get(key) ?? load();
      cache.set(key, loaded);
      return loaded;
    };
    const gitDirOf = (path: string) =>
      gitService.getCommonGitDir(path).then((dir) => realpath(dir));
    // Where a local worktree may come from, as managedWorktree() allows.
    const localRepos = [...new Set([project.managedRepoPath, project.repositoryPath])].filter(
      (repoPath): repoPath is string => !!repoPath
    );
    const repoGitDirs = new Map<string, Promise<string | null>>();
    const mainBranches = new Map<string, Promise<string>>();
    /** The project repository whose Git directory the worktree shares, if any. */
    const localRepoOf = async (worktreePath: string) => {
      const gitDir = await gitDirOf(worktreePath);
      for (const repoPath of localRepos) {
        const repoGitDir = await once(repoGitDirs, repoPath, () =>
          gitDirOf(repoPath).catch(() => null)
        );
        if (repoGitDir === gitDir) return repoPath;
      }
      throw new Error("The workspace isn't a worktree of the project's repository");
    };

    const statuses = new Map<string, WorkspaceCleanupStatus>();
    const groups = new Map<
      string,
      { repo: GitBatchRunner; targetBranch: string; heads: Array<WorktreeHead & { id: string }> }
    >();
    await mapWithConcurrency(workspaces, CHECK_CONCURRENCY, async (workspace) => {
      const ssh = isSshWorkspace(workspace) ? workspace.backend : null;
      const branch = toLocalBranchName(
        resolveWorkspaceTargetBranch(workspace, project.baseBranch) ?? ''
      );
      let targetBranch = branch || toLocalBranchName(ssh?.defaultBranch ?? '') || 'main';
      try {
        const head = await gitService.readWorktreeForCleanup(
          ssh
            ? sshWorkspaceGit.gitBatchRunner(ssh.hostId, ssh.remoteDirectory)
            : localGitBatchRunner(workspace.workingDirectory)
        );
        let repo: GitBatchRunner;
        if (ssh) {
          repo = sshWorkspaceGit.gitBatchRunner(ssh.hostId, ssh.remoteRepoPath);
        } else {
          const repoPath = await localRepoOf(workspace.workingDirectory);
          if (!branch) {
            targetBranch = await once(mainBranches, repoPath, () =>
              gitService.getMainBranch(repoPath).catch(() => 'main')
            );
          }
          repo = localGitBatchRunner(repoPath);
        }
        const key = `${repo.label}\0${targetBranch}`;
        const group = groups.get(key) ?? { repo, targetBranch, heads: [] };
        group.heads.push({ id: workspace.id, ...head });
        groups.set(key, group);
      } catch (error) {
        logger.warn('Could not read workspace for cleanup', { workspaceId: workspace.id, error });
        const status = { targetBranch, ok: false as const, error: failure(error) };
        statuses.set(workspace.id, { workspaceId: workspace.id, ...status });
      }
    });

    // The worktrees of one repository share its history, so its target is read once for all.
    await mapWithConcurrency([...groups.values()], CHECK_CONCURRENCY, async (group) => {
      const { repo, targetBranch, heads } = group;
      try {
        const commits = heads.map(({ commit }) => commit);
        const landed = await gitService.findLandedCommits(repo, targetBranch, commits);
        heads.forEach(({ id, uncommittedChanges }, index) =>
          statuses.set(id, {
            workspaceId: id,
            targetBranch,
            ok: true,
            landed: landed[index],
            uncommittedChanges,
          })
        );
      } catch (error) {
        logger.warn('Could not check workspaces for cleanup', { repo: repo.label, error });
        for (const { id } of heads) {
          statuses.set(id, { workspaceId: id, targetBranch, ok: false, error: failure(error) });
        }
      }
    });
    return workspaces.flatMap((workspace) => statuses.get(workspace.id) ?? []);
  }

  /**
   * Branches in the SSH host's clone of the project with commits origin doesn't have, most
   * recent first. The bare clone copied every origin branch into refs/heads when it was
   * made and never updates those copies, so only a branch whose tip is new counts.
   */
  async listHostBranches(projectId: string, hostId: string): Promise<string[]> {
    const project = projectService.get(projectId);
    if (!project || project.kind === 'directory') return [];
    // The clone a new workspace uses, which may not exist yet.
    const remoteRepoPath = sshWorkspaceService.managedRepoPath(
      await sshWorkspaceService.resolveWorkspaceBasePath(hostId),
      project.name
    );
    const [heads, unpublished] = await sshWorkspaceGit.gitBatchRunner(hostId, remoteRepoPath).run([
      {
        args: [
          'for-each-ref',
          '--sort=-committerdate',
          '--format=%(objectname) %(refname:short)',
          'refs/heads',
        ],
      },
      { args: ['rev-list', '--branches', '--not', '--remotes=origin'] },
    ]);
    if (!heads?.ok || !unpublished?.ok) return [];
    const newCommits = new Set(unpublished.output.split('\n').filter(Boolean));
    return heads.output.split('\n').flatMap((line) => {
      const [commit, name] = line.split(' ');
      return name && newCommits.has(commit) ? [name] : [];
    });
  }

  getWorkspacesByProjectId(projectId: string): Workspace[] {
    return Array.from(this.workspaces.values()).filter(
      (workspace) => workspace.projectId === projectId
    );
  }

  list(): Workspace[] {
    // Update terminal statuses from PTY service
    for (const workspace of this.workspaces.values()) {
      for (const terminal of workspace.terminals) {
        const ptyStatus = ptyService.getStatus(terminal.id);
        if (ptyStatus) terminal.status = ptyStatus;
      }
    }
    return Array.from(this.workspaces.values());
  }

  assertSshHostConnectionUpdateAllowed(nextHost: SshHost): void {
    const currentHost = sshHostService.get(nextHost.id);
    if (!currentHost) return;
    if (normalizeSshBasePath(currentHost.basePath) !== normalizeSshBasePath(nextHost.basePath)) {
      throw new Error(
        'Remote Komla path is fixed after this machine is connected. Remove and reconnect the machine to use a different path.'
      );
    }
    const lockedHostIds = new Set(
      Array.from(this.workspaces.values())
        .filter(isSshWorkspace)
        .map((workspace) => workspace.backend.hostId)
    );

    const connectionProfile = (host: SshHost) =>
      JSON.stringify({
        hostname: host.hostname.trim(),
        user: host.user?.trim() || '',
        port: host.port ?? null,
        identityFile: host.identityFile?.trim() || '',
        basePath: normalizeSshBasePath(host.basePath),
        extraSshArgs: host.extraSshArgs ?? [],
      });

    if (
      lockedHostIds.has(nextHost.id) &&
      connectionProfile(currentHost) !== connectionProfile(nextHost)
    ) {
      throw new Error(
        'Remove existing SSH workspaces for this host before changing its connection settings or remote Komla path.'
      );
    }
  }

  get(workspaceId: string): Workspace | undefined {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      // Update terminal statuses
      for (const terminal of workspace.terminals) {
        const ptyStatus = ptyService.getStatus(terminal.id);
        if (ptyStatus) terminal.status = ptyStatus;
      }
    }
    return workspace;
  }

  isDeleting(workspaceId: string): boolean {
    return this.deletingWorkspaceIds.has(workspaceId);
  }

  update(workspaceId: string, updates: Partial<Omit<Workspace, 'id' | 'terminals'>>): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const normalizedUpdates = { ...updates };
    // Matches the IPC schema, for internal callers that skip it.
    if ('browserPanes' in normalizedUpdates) {
      normalizedUpdates.browserPanes = normalizeBrowserPanes(normalizedUpdates.browserPanes);
    }
    if ('recentLinks' in normalizedUpdates) {
      normalizedUpdates.recentLinks = normalizeRecentLinks(normalizedUpdates.recentLinks);
    }
    if ('virtualDesktops' in normalizedUpdates) {
      normalizedUpdates.virtualDesktops = normalizeVirtualDesktops(
        normalizedUpdates.virtualDesktops
      );
    }
    // A script's word on a tag is about that tag, so another tag, or none, drops it.
    if ('tag' in normalizedUpdates && !('tagTooltip' in normalizedUpdates)) {
      if (normalizedUpdates.tag !== workspace.tag) normalizedUpdates.tagTooltip = undefined;
    }
    if ('customName' in normalizedUpdates) {
      if (normalizedUpdates.customName) {
        normalizedUpdates.customNameSource = 'manual';
        normalizedUpdates.customNameGeneratedAt = undefined;
        normalizedUpdates.promptSubmitsSinceCustomNameGeneration = undefined;
      } else {
        const autoNamingController = this.autoNamingControllers.get(workspaceId);
        if (autoNamingController) {
          autoNamingController.abort();
          this.autoNamingControllers.delete(workspaceId);
        }
        normalizedUpdates.customNameSource = undefined;
        normalizedUpdates.customNameGeneratedAt = undefined;
        normalizedUpdates.promptSubmitsSinceCustomNameGeneration = undefined;
        // Reset prompt context so future titles use only prompts submitted from this point on.
        normalizedUpdates.promptSubmits = undefined;
        normalizedUpdates.autoNaming = false;
      }
    }

    const previousSshTargetBranch = isSshWorkspace(workspace)
      ? workspace.baseBranch ||
        workspace.backend.baseBranch ||
        projectService.get(workspace.projectId)?.baseBranch ||
        'main'
      : undefined;

    const wasTrashed = workspace.status === 'trashed';
    Object.assign(workspace, normalizedUpdates);
    // The Trash counts its days from the move; restoring takes a workspace out of it.
    if (workspace.status !== 'trashed') workspace.trashedAt = undefined;
    else if (!wasTrashed) {
      workspace.trashedAt = Date.now();
      publishHookEvent({ event: 'workspace.trashed', workspaceId });
    }
    const snoozeChanged = 'snoozedUntil' in updates || 'wakesOnNotification' in updates;
    if (snoozeChanged) this.snoozeAlarm.check();
    if ('status' in updates || snoozeChanged) this.attention.workspaceStatusChanged();

    if ('branchName' in updates && isSshWorkspace(workspace)) {
      workspace.backend.branchName = workspace.branchName;
    }

    // Keep the backend target branch synchronized with the mutable workspace override.
    if ('baseBranch' in updates && isSshWorkspace(workspace)) {
      workspace.backend.baseBranch =
        workspace.baseBranch ||
        projectService.get(workspace.projectId)?.baseBranch ||
        workspace.backend.defaultBranch;
    } else if ('baseBranch' in updates) {
      // If workspace override was cleared, fall back to the project's baseBranch
      const effectiveBranch =
        workspace.baseBranch || projectService.get(workspace.projectId)?.baseBranch;
      gitService.registerTargetBranch(workspace.workingDirectory, effectiveBranch);
    }

    this.saveWorkspaces();
    if (
      previousSshTargetBranch !== undefined &&
      isSshWorkspace(workspace) &&
      previousSshTargetBranch !==
        (workspace.baseBranch ||
          workspace.backend.baseBranch ||
          projectService.get(workspace.projectId)?.baseBranch ||
          'main')
    ) {
      void remoteWorkspaceObservationService.reconcile();
    }
    if ('customName' in updates && !normalizedUpdates.customName) {
      this.broadcastWorkspaceUpdate(workspace);
    }
    return workspace;
  }

  /**
   * Propagate a project's baseBranch to GitService for all workspaces in that project
   * that don't have their own baseBranch override.
   */
  propagateProjectBaseBranch(projectId: string): void {
    const project = projectService.get(projectId);
    if (!project) return;

    let sshWorkspaceChanged = false;
    for (const workspace of this.workspaces.values()) {
      if (workspace.projectId !== projectId || workspace.baseBranch) continue;

      if (isSshWorkspace(workspace)) {
        workspace.backend.baseBranch = project.baseBranch || workspace.backend.defaultBranch;
        sshWorkspaceChanged = true;
      } else {
        gitService.registerTargetBranch(workspace.workingDirectory, project.baseBranch);
      }
    }
    if (sshWorkspaceChanged) {
      this.saveWorkspaces();
      void remoteWorkspaceObservationService.reconcile();
    }
  }

  updateTerminal(terminalId: string, updates: Partial<Omit<Terminal, 'id'>>): Terminal {
    const workspace = this.findWorkspaceByTerminalId(terminalId);
    if (!workspace) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    const terminal = workspace.terminals.find((t) => t.id === terminalId);
    if (!terminal) {
      throw new Error(`Terminal ${terminalId} not found`);
    }

    Object.assign(terminal, updates);
    return terminal;
  }

  dismissSetupActivity(workspaceId: string, activityId: string): Workspace {
    return workspaceSetupService.dismiss(workspaceId, activityId);
  }

  retrySetupStep(workspaceId: string, stepId: string): Workspace {
    return workspaceSetupService.retry(workspaceId, stepId);
  }

  runBackgroundAction(
    workspaceId: string,
    actionId: string,
    launch?: BackgroundActionLaunch
  ): Workspace {
    return workspaceSetupService.runAction(workspaceId, actionId, launch);
  }

  stopBackgroundActionRun(workspaceId: string, activityId: string): Promise<void> {
    return workspaceSetupService.stopRun(workspaceId, activityId);
  }

  // Restart a workspace by adding a new terminal with continue command
  // Re-applies project setup steps (background processes, terminal layout)
  restart(workspaceId: string, remoteSetupStopped = false): Terminal | Promise<Terminal> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    if (workspace.provisioning) {
      throw new Error(`Workspace ${workspaceId} is still being provisioned`);
    }

    // Stop steps such as `docker compose down` finish before setup starts things again.
    const stopSteps = workspaceSetupService.stopStepsSettled(workspaceId);
    if (stopSteps) return stopSteps.then(() => this.restart(workspaceId, remoteSetupStopped));

    if (!remoteSetupStopped) {
      const setupCleanup = workspaceSetupService.cancel(workspaceId);
      if (setupCleanup) {
        return setupCleanup.then(() => this.restart(workspaceId, true));
      }
    }

    // Restart starts its terminals on the SSH host. Don't double-count this workspace —
    // restarting one already there doesn't add a new running workspace.
    if (isSshWorkspace(workspace)) {
      this.assertFreeSshSlot(
        'start_workspace',
        this.getRunningRemoteWorkspaceCount() +
          this.pendingRemoteStarts -
          (isRunningOnSshHost(workspace) ? 1 : 0)
      );
    }

    // Restart should clean up the same terminal resources as stop before
    // setup steps and the continue command create fresh terminals.
    this.cancelDeferredWorkspaceLaunches(workspace);
    for (const terminal of workspace.terminals) {
      ptyService.kill(terminal.id);
      terminal.status = 'stopped';
    }

    // Clear old terminals to avoid stale references
    workspace.terminals = [];
    workspace.terminalLayout = undefined;
    workspace.lastStoppedAt = undefined;

    // Auto-activate dormant workspaces when restarting
    if (workspace.status !== 'active') {
      workspace.status = 'active';
      this.moveFolderIntoProject(workspace);
      this.attention.workspaceStatusChanged();
      this.saveWorkspaces();
    }

    // Start file watcher (stopped when workspace was stopped)
    if (!isSshWorkspace(workspace)) {
      worktreeWatcherService.startWatching(workspaceId, workspace.workingDirectory).catch((err) => {
        logger.error(`Failed to start watcher for workspace ${workspaceId}:`, err);
      });
    }

    // Kill existing background processes so they can be re-spawned from setup steps
    workspaceSetupService.clearActive(workspace.id);
    workspaceSetupService.stopBackground(workspaceId);
    void sshPortForwardService.stopPreviewForward(workspaceId);

    // Auto-heal: if workspace references a deleted preset, fall back to first active
    if (
      workspace.presetId &&
      agentPresetService.get &&
      !agentPresetService.get(workspace.presetId)
    ) {
      const fallback = agentPresetService.getFirstActive?.();
      if (fallback) {
        workspace.presetId = fallback.id;
        workspace.launchModeId = null;
        workspace.reasoningLevelId = null;
        this.saveWorkspaces();
      }
    }

    // Build continue command from workspace's preset
    let command: string | null = null;
    const activePreset = this.resolvePreset(null, workspace);
    const continueCommand = activePreset?.continueCommand || null;
    if (activePreset && continueCommand && continueCommand.trim()) {
      command = agentPresetService.resolvePresetCommand(
        activePreset,
        'continue',
        workspace.launchModeId,
        undefined,
        undefined,
        workspace.reasoningLevelId
      );
    }

    // Re-apply setup steps for worktree workspaces with a project
    const primaryTerminal = workspaceSetupService.start(workspace, command, 'start');
    if (primaryTerminal) {
      return primaryTerminal;
    }

    // Default: create single terminal with agent command
    const terminal = this.addTerminal(workspaceId, workspace.name, command);
    if (terminal instanceof Promise) {
      return terminal.then((startedTerminal) => {
        workspace.primaryTerminalId = startedTerminal.id;
        return startedTerminal;
      });
    }
    workspace.primaryTerminalId = terminal.id;
    return terminal;
  }

  async restartWithCleanup(workspaceId: string): Promise<Terminal> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    try {
      const releasing = executionLocations.releaseSessions(workspace, {
        observeUnknownFirst: true,
      });
      if (releasing) await releasing;
    } catch (error) {
      throw new Error(
        `Could not confirm all remote agents stopped; workspace restart was cancelled. ${String(error)}`
      );
    }
    await sshPortForwardService.stopPreviewForward(workspaceId);
    return this.restart(workspaceId);
  }

  updateTerminalStatus(terminalId: string, status: TerminalStatus): void {
    const terminal = this.findWorkspaceByTerminalId(terminalId)?.terminals.find(
      (t) => t.id === terminalId
    );
    if (terminal && status === 'running') terminal.connectionError = undefined;
    if (managedRemoteTerminalLifecycleService.attachmentStatusChanged(terminalId, status)) return;
    if (terminal) terminal.status = status;
  }

  reorderWorkspace(workspaceId: string, newOrder: number): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const oldOrder = workspace.order ?? 0;

    // Get all workspaces sorted by order
    const sortedWorkspaces = Array.from(this.workspaces.values()).sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
    );

    // Update orders for affected workspaces
    for (const w of sortedWorkspaces) {
      if (w.id === workspaceId) continue;

      const currentOrder = w.order ?? 0;

      if (oldOrder < newOrder) {
        // Moving down: shift workspaces between old and new position up
        if (currentOrder > oldOrder && currentOrder <= newOrder) {
          w.order = currentOrder - 1;
        }
      } else if (oldOrder > newOrder) {
        // Moving up: shift workspaces between new and old position down
        if (currentOrder >= newOrder && currentOrder < oldOrder) {
          w.order = currentOrder + 1;
        }
      }
    }

    workspace.order = newOrder;
    this.saveWorkspaces();
  }

  // Move workspace to a different window
  moveWorkspaceToWindow(workspaceId: string, windowId: string | null): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    workspace.windowId = windowId;
    this.saveWorkspaces();
  }

  // Assign all unassigned workspaces to the main window on startup
  assignUnassignedToMainWindow(mainWindowId: string): void {
    let changed = false;
    for (const workspace of this.workspaces.values()) {
      if (workspace.windowId === null) {
        workspace.windowId = mainWindowId;
        changed = true;
      }
    }
    if (changed) {
      this.saveWorkspaces();
    }
  }

  /**
   * Records the workspaces a window shows a browser or note pane of. Such a pane keeps its
   * workspace running without a terminal, through `showsPaneSurfaces`.
   */
  setPaneSurfaceWorkspaces(windowId: string, workspaceIds: readonly string[]): void {
    this.paneSurfaceWorkspaceIdsByWindow.set(windowId, new Set(workspaceIds));
    this.updateShowsPaneSurfaces();
  }

  /** A closed window shows no pane; the window that takes its workspaces reports its own. */
  clearWindowPaneSurfaces(windowId: string): void {
    if (this.paneSurfaceWorkspaceIdsByWindow.delete(windowId)) this.updateShowsPaneSurfaces();
  }

  private updateShowsPaneSurfaces(): void {
    const shown = new Set<string>();
    for (const ids of this.paneSurfaceWorkspaceIdsByWindow.values()) {
      for (const id of ids) shown.add(id);
    }
    for (const workspace of this.workspaces.values()) {
      const showsPaneSurfaces = shown.has(workspace.id) || undefined;
      if (workspace.showsPaneSurfaces === showsPaneSurfaces) continue;
      workspace.showsPaneSurfaces = showsPaneSurfaces;
      this.broadcastWorkspaceUpdate(workspace);
    }
  }

  // Reassign all workspaces from a closing window to a target window
  // Returns IDs of affected workspaces so callers can broadcast changes
  reassignWindowWorkspaces(windowId: string, targetWindowId: string | null): string[] {
    const affected: string[] = [];
    for (const workspace of this.workspaces.values()) {
      if (workspace.windowId === windowId) {
        workspace.windowId = targetWindowId;
        affected.push(workspace.id);
      }
    }
    if (affected.length > 0) {
      this.saveWorkspaces();
    }
    return affected;
  }

  /** Update lastActivityAt timestamp for a workspace (e.g. from file watcher activity) */
  touchLastActivity(workspaceId: string, activityAt = Date.now()): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    workspace.lastActivityAt = activityAt;
    this.saveWorkspaces();
  }

  /** An agent's turn ran in the workspace, so it counts as in use, at most once a minute. */
  recordAgentTurnActivity(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    // Files aren't watched in a workspace in the Trash either.
    if (workspace?.status !== 'active') return;
    const now = Date.now();
    const sinceLastActivity = now - workspace.lastActivityAt;
    // A time ahead of this clock, such as one synced from another device, is replaced.
    if (sinceLastActivity >= 0 && sinceLastActivity < AGENT_TURN_ACTIVITY_INTERVAL_MS) return;
    this.touchLastActivity(workspaceId, now);
    this.broadcastWorkspaceUpdate(workspace);
  }

  hasAcceptedTerminalHook(terminalId: string, deliveryId: string): boolean {
    const deliveryKey = `${terminalId}\0${deliveryId}`;
    return (
      !this.pendingTerminalHookDeliveryIds.has(deliveryKey) &&
      this.getTerminal(terminalId)?.lastAcceptedHookDeliveryId === deliveryId
    );
  }

  /** Records a copied hook's delivery; it only changes what's shown, so the save is batched. */
  recordCopiedHookDelivery(
    workspaceId: string,
    delivery?: { terminalId: string; deliveryId: string }
  ): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return;
    const terminal = delivery
      ? workspace.terminals.find((candidate) => candidate.id === delivery.terminalId)
      : undefined;
    if (terminal && delivery) terminal.lastAcceptedHookDeliveryId = delivery.deliveryId;
    this.saveWorkspaces();
  }

  /** Notifies a workspace of something no Terminal of its own reported, such as its CI ending. */
  notifyWorkspace(workspace: Workspace, hook: AgentHook): void {
    // Saved at once on SSH workspaces and published to remote viewers, as a hook over HTTP is.
    this.attention
      .hook({ workspace, hasInvalidTerminalId: false }, hook)
      .then(() => this.persistSshAttention(workspace.id))
      .catch((error) => logger.error('Failed to notify a workspace:', error));
  }

  async persistSshAttention(
    workspaceId: string,
    delivery?: { terminalId: string; deliveryId: string }
  ): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !isSshWorkspace(workspace)) return;
    const terminal = delivery
      ? workspace.terminals.find((candidate) => candidate.id === delivery.terminalId)
      : undefined;
    const previousDeliveryId = terminal?.lastAcceptedHookDeliveryId;
    const deliveryKey = delivery ? `${delivery.terminalId}\0${delivery.deliveryId}` : undefined;
    if (terminal && delivery && deliveryKey) {
      this.pendingTerminalHookDeliveryIds.add(deliveryKey);
      terminal.lastAcceptedHookDeliveryId = delivery.deliveryId;
    }
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    publishRemoteWorkspaceChange();
    try {
      await this.doSaveWorkspaces(true);
    } catch (error) {
      if (terminal) terminal.lastAcceptedHookDeliveryId = previousDeliveryId;
      throw error;
    } finally {
      if (deliveryKey) this.pendingTerminalHookDeliveryIds.delete(deliveryKey);
    }
  }

  /** Tells the other devices showing an SSH tab that its agent was interrupted here. */
  private relayInterrupt(workspace: Workspace, terminalId: string, sources: string[]): void {
    const terminal = workspace.terminals.find((candidate) => candidate.id === terminalId);
    if (
      !isSshWorkspace(workspace) ||
      !terminal ||
      !executionLocations.managesSession(workspace, terminal.executionLocation)
    ) {
      return;
    }
    const { backend } = workspace;
    void (async () => {
      const host = sshWorkspaceService.getHost(backend.hostId);
      // The inbox this device's terminals use, at <base>/helpers/companion/<key>/inbox.
      const { hookInbox } = remoteWorkspaceObservationService.companionForWorkspace(backend);
      const remoteBasePath = pathPosix.join(hookInbox, '..', '..', '..', '..');
      // Only through a companion already installed: stopping a tab mustn't upload one.
      const executable = await remoteCompanionService.installedPath(host, remoteBasePath);
      if (!executable) {
        logger.info('Not relaying an interrupt: no companion installed on its host yet', {
          hostId: backend.hostId,
        });
        return;
      }
      await sshWorkspaceService.relayInterrupt(
        backend,
        { executable, hookInbox },
        terminalId,
        sources
      );
    })().catch((error) => logger.warn('Could not tell other devices about an interrupt:', error));
  }

  getDiagnostics(): {
    workspaceCount: number;
    runningWorkspaceCount: number;
    stoppedWorkspaceCount: number;
    trashedWorkspaceCount: number;
    terminalCount: number;
    pendingSave: boolean;
  } {
    let runningWorkspaceCount = 0;
    let stoppedWorkspaceCount = 0;
    let trashedWorkspaceCount = 0;
    let terminalCount = 0;

    for (const workspace of this.workspaces.values()) {
      if (workspace.status === 'trashed') trashedWorkspaceCount++;
      else if (workspace.status === 'active') {
        if (isRunningHere(workspace)) runningWorkspaceCount++;
        else stoppedWorkspaceCount++;
      }
      terminalCount += workspace.terminals.length;
    }

    return {
      workspaceCount: this.workspaces.size,
      runningWorkspaceCount,
      stoppedWorkspaceCount,
      trashedWorkspaceCount,
      terminalCount,
      pendingSave: this.pendingSave,
    };
  }
}

export const workspaceService = new WorkspaceService();
