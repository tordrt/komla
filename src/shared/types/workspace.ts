/**
 * Workspace-related types shared between main and renderer processes.
 */

import type { Project } from './project';
import type { Terminal, TerminalExecutionLocation } from './terminal';
import type { DesiredWorkspaceEnvironment } from '../lib/agent-environment';
import type { PullRequestTagState } from '../lib/workspace-tags';

export type WorkspaceStatus = 'active' | 'trashed';

/** How long a workspace stays in the Trash before it's deleted for good. */
export const TRASH_RETENTION_DAYS = 7;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** A page in one of the workspace's browser panes. */
export interface WorkspaceBrowserTab {
  id: string;
  /** Empty for a new tab that has no page yet. */
  url: string;
  /** In an SSH workspace, whether a localhost URL is served by the SSH host or this computer. */
  urlExecutionLocation?: Terminal['executionLocation'];
  /** The page's last known title. */
  title?: string;
}

/** A browser pane's tabs, saved so the pane opens again when its workspace starts again. */
export interface WorkspaceBrowserPane {
  browserTabs: WorkspaceBrowserTab[];
  activeBrowserTabId?: string;
}

/** A link to another site that the workspace's terminals printed or you opened from them. */
export interface WorkspaceRecentLink {
  url: string;
  /** When you last opened it; missing for a link only printed. */
  openedAt?: number;
  /** When a terminal last printed it, to within a few seconds. */
  printedAt?: number;
}

/**
 * A virtual desktop `komla desktop run` started for an app, on the machine the workspace runs
 * on: the SSH host for an SSH workspace.
 */
export interface WorkspaceVirtualDesktop {
  /** Its VNC server's port, 5900 plus its display number. */
  vncPort: number;
  vncPassword?: string;
  /** Its noVNC page, where the machine has noVNC. */
  url?: string;
  /** What it's named after: the app's command, shortened. */
  app?: string;
  /** The app this computer opened vnc:// links with when the desktop started, if any. */
  vncApp?: string;
  /** When Komla last showed it, as Date.now(). */
  shownAt: number;
}

// What a spawned terminal's command is.
//   'agent'      — an agent command.
//   'host'       — a user's shell command (workspace setup shell steps, command
//                  actions). The shell stays open after it exits.
//   'host-shell' — an empty shell, whatever command is passed.
export type CommandKind = 'agent' | 'host' | 'host-shell';

export interface RestartTerminalOptions {
  command?: string;
  commandKind?: CommandKind;
  plainShell?: boolean;
  replaceSession?: boolean;
  /**
   * `local-mirror` replaces an SSH terminal's remote session with a plain Local copy shell;
   * `workspace` moves a Local copy terminal back to a shell on the SSH host.
   */
  executionLocation?: 'local-mirror' | 'workspace';
}

export interface AddAgentTabOptions {
  /** Leave the workspace's agent and launch mode, and the last agent used, as they were. */
  keepWorkspaceAgent?: boolean;
}

export type WorkspaceAttentionKind =
  | 'input-required'
  | 'turn-complete'
  | 'error'
  | 'idle'
  | 'generic';
export type KnownWorkspaceAttentionSource =
  | 'claude-code'
  | 'codex'
  | 'antigravity'
  | 'gemini'
  | 'opencode'
  | 'command'
  | 'generic';
// Custom agents may send their own opaque source labels; the (string & {}) trick
// preserves autocomplete on known values while accepting any string at runtime.
export type WorkspaceAttentionSource = KnownWorkspaceAttentionSource | (string & {});

export interface WorkspaceAttention {
  kind: WorkspaceAttentionKind;
  source: WorkspaceAttentionSource;
  updatedAt: number;
  title?: string;
  body?: string;
  /** The pill's color: a theme tone such as success, or any CSS color. */
  color?: string;
  /** Short text for the pill, in place of the title. */
  badge?: string;
  /** An image data URL shown in place of the kind's glyph; `iconColor` shows only its shape. */
  icon?: string;
  iconColor?: string;
  /** Lifecycle integration detail. Custom notifications use title and body. */
  message?: string;
  terminalId?: string;
  /**
   * The user saw the Terminal on screen without focusing it. A done, idle or notice then shows
   * only as its pane's border; a prompt or error is never seen this way.
   */
  seen?: boolean;
}

export interface WorkspaceAttentionEvent {
  workspaceId: string;
  /** The attention a Terminal, or the workspace, just raised. */
  attention: WorkspaceAttention;
  /** What the workspace shows after it, which may be another Terminal's that outranks it. */
  workspaceAttention: WorkspaceAttention;
  /** The user was away from the computer when it arrived, so what's on screen wasn't seen. */
  userAway?: boolean;
  /** The workspace stays snoozed after it, as main decided, so it neither rings nor badges. */
  snoozed?: boolean;
}

/** Why a workspace shows as unread: marked by hand, or back from a snooze. */
export interface WorkspaceUnread {
  reason: 'marked' | 'snooze-ended';
  at: number;
}

export interface WorkspacePromptSubmit {
  prompt: string;
  submittedAt: number;
  /** The Terminal the prompt was sent in, which its agent's reply comes from. */
  terminalId?: string;
  /** The agent's final reply to the prompt, when its done hook carried one. */
  reply?: string;
}

/** Main asks the window showing a workspace to open a page, or the workspace's browser, in Komla. */
export interface OpenDevPreviewEvent {
  workspaceId: string;
  url?: string;
  /** Where the terminal that printed the URL runs, for a page on that machine. */
  urlExecutionLocation?: TerminalExecutionLocation;
}

/** An agent's `komla trash`, sent to the window showing its workspace once its turn ends. */
export interface WorkspaceTrashRequest {
  workspaceId: string;
  /** Why it stays after all, such as another tab having started working meanwhile. */
  refusal?: string;
}

export type WorkspaceCustomNameSource = 'generated' | 'manual';

export interface LocalWorkspaceBackend {
  kind: 'local';
}

export interface SshWorkspaceBackend {
  kind: 'ssh';
  hostId: string;
  remoteDirectory: string;
  remoteRepoPath: string;
  remoteProjectRoot: string;
  gitUrl: string;
  projectId?: string;
  projectName?: string;
  branchName?: string;
  checkoutExistingBranch?: boolean;
  baseBranch?: string;
  /** Resolved remote default retained when baseBranch is temporarily overridden. */
  defaultBranch?: string;
  startPoint?: string;
}

export type WorkspaceBackend = LocalWorkspaceBackend | SshWorkspaceBackend;

export interface WorkspaceGitStatusSnapshot {
  branch: {
    behindTargetBranch: number;
    aheadTargetBranch: number;
    mainBranch: string;
    defaultBranch: string;
    remoteDefaultBranch?: string;
    hasRemote: boolean;
    hasOriginRemote: boolean;
    unpushedCommits: number;
    behindRemote: number;
    currentBranch: string;
    targetBranchHasRemote: boolean;
    targetBranchAheadRemote: number;
    targetBranchBehindRemote: number;
    rebaseInProgress?: boolean;
  };
  diff: {
    files: Array<{
      path: string;
      originalPath?: string;
      status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
      staged: boolean;
      additions: number;
      deletions: number;
      /** Untracked line counting was skipped or could not complete. */
      lineCountsUnavailable?: boolean;
      isDirectory?: boolean;
    }>;
    summary: { additions: number; deletions: number; filesChanged: number };
  };
  updatedAt: number;
  /** Null means never confirmed. */
  lastConfirmedAt?: number | null;
}

export type SetupActivityState = 'preparing' | 'running' | 'succeeded' | 'failed' | 'unsupported';

export interface SetupActivityRun {
  id: string;
  workspaceId: string;
  setupRunId: string;
  stepId: string;
  stepName: string;
  /** Set when a background command Action started the run instead of a Setup step. */
  actionId?: string;
  /** What a background Action ran, so Retry runs it the same way. */
  command?: string;
  /** Where the run runs, and for a background Action where Retry runs it. */
  executionLocation?: TerminalExecutionLocation;
  retryable: boolean;
  state: SetupActivityState;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  error?: string;
  output: string;
  truncated?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  customName?: string;
  customDescription?: string;
  customNameSource?: WorkspaceCustomNameSource;
  customNameGeneratedAt?: number;
  promptSubmitsSinceCustomNameGeneration?: number;
  workingDirectory: string;
  backend?: WorkspaceBackend;
  /** Last status pushed by an SSH workspace, retained for display while disconnected. */
  lastKnownGitStatus?: WorkspaceGitStatusSnapshot;

  // Worktree info
  branchName?: string;
  isWorktree: boolean;
  projectId: string | null;
  repoName?: string;
  baseBranch?: string;
  // Source branch the worktree was cut from when it differs from the project's
  // default. Set at creation only; informational, not used for diffs/PRs.
  branchedFrom?: string;

  // Agent preset used for this workspace
  presetId?: string | null;
  // Launch mode selected for this workspace (null = preset default)
  launchModeId?: string | null;
  // Reasoning level selected for this workspace (null = agent default)
  reasoningLevelId?: string | null;

  // Embedded terminals
  terminals: Terminal[];
  primaryTerminalId?: string;
  lastDynamicTitle?: string;
  terminalLayout?: WorkspaceTerminalLayout;

  // Window assignment (null = visible in all windows)
  windowId: string | null;

  // UI state
  fileTreeOpen?: boolean;
  fileTreeMode?: 'diff' | 'browse';
  /** The workspace's browser panes, in tab order, which open again when it starts again. */
  browserPanes?: WorkspaceBrowserPane[];
  /** Links to other sites, opened ones first; see shared/lib/recent-links. */
  recentLinks?: WorkspaceRecentLink[];
  /** The virtual desktops `komla desktop run` started, newest first, while they run. */
  virtualDesktops?: WorkspaceVirtualDesktop[];

  // Appearance
  color?: string | null;

  /**
   * The Action the run button repeats here, until one is picked from its list. The + menu and
   * a terminal's Replace With and Split submenus share it, since they all start something new.
   */
  defaultActionId?: string;
  /**
   * The Saved Prompt a terminal's Paste Prompt item repeats here, apart from the run button's,
   * since it types prompts into the terminal instead of starting them.
   */
  paneDefaultActionId?: string;

  // Metadata
  categoryId: string | null;
  createdAt: number;
  lastActivityAt: number;
  lastStoppedAt?: number;
  order: number;
  needsAttention?: boolean;
  attention?: WorkspaceAttention;
  /** Shows as unread on its card until the workspace is next opened. */
  unread?: WorkspaceUnread;
  /** Listed on the Pinned shelf at the top of the sidebar. */
  pinned?: boolean;
  /** The user's tag, such as "Waiting for review", shown on its card while no agent is busy. */
  tag?: string;
  /** Set when Komla put the tag on from the branch's pull request, not the user. */
  tagSource?: 'pull-request';
  /** What a script said about this workspace's tag, shown on hover; goes when the tag changes. */
  tagTooltip?: string;
  /**
   * Where the branch's pull request stood at the last read, so a tag the user took off stays off
   * until the pull request moves on.
   */
  pullRequestState?: PullRequestTagState;
  /** Kept in the sidebar's Snoozed shelf until this time. */
  snoozedUntil?: number;
  /** Kept in the Snoozed shelf until the workspace's next notification, or snoozedUntil first. */
  wakesOnNotification?: boolean;
  /**
   * The Terminal whose agent snoozed it until notified during a turn: that turn's end is no news
   * (not persisted).
   */
  snoozeOutlastsTurnOf?: string;
  agentActive?: boolean; // True while the agent is processing (set on prompt-submit, activity, or Claude Code input-required; cleared on accepted turn-complete/idle)
  agentActiveSince?: number; // When agentActive last turned on
  showsPaneSurfaces?: boolean; // True while a window shows a browser or note pane of it, which keeps it running without a terminal (not persisted)
  status: WorkspaceStatus;
  /** When it moved to the Trash, which deletes it for good {@link TRASH_RETENTION_MS} later. */
  trashedAt?: number;
  autoNaming?: boolean; // True while auto-naming is in progress
  promptSubmits?: WorkspacePromptSubmit[]; // Bounded local history of user prompts submitted in this workspace
  provisioning?: boolean; // True while background worktree creation is in progress
  provisionStatus?: string; // Human-readable current provisioning step
  provisionError?: string; // Set when background provisioning fails
  removedFromHost?: boolean; // With provisionError: the SSH workspace's files are gone, e.g. deleted on another device
  provisioningRepoPath?: string; // Repo path used to clean up an interrupted provisioning worktree
  provisioningBranchCreated?: boolean; // True only when this provisioning attempt created the branch
  provisioningWorktreeCreated?: boolean; // True only when this provisioning attempt created the worktree

  /** Ephemeral, memory-only diagnostics for background Setup steps. */
  setupActivities?: SetupActivityRun[];

  // Other workspaces this one is linked to. Bidirectional: if A.linkedWorkspaceIds
  // includes B, then B.linkedWorkspaceIds includes A. Maintained by workspaceLinksService.
  linkedWorkspaceIds?: string[];
}

export interface WorkspaceTerminalLayout {
  activeTab?: string;
  tabs: string[];
  layouts: Record<string, unknown>;
}

/** The most files one new-workspace prompt carries. */
export const MAX_PROMPT_ATTACHMENTS = 20;

export interface CreateWorkspaceParams {
  name?: string;
  customName?: string;
  customDescription?: string;
  mode: 'worktree' | 'directory';
  // Worktree mode
  branchName?: string;
  projectId?: string;
  // Use exact branch name (for existing branches, don't add prefix)
  useExactBranchName?: boolean;
  // If true, auto-generated branch conflicts are resolved by retrying with new names
  autoResolveBranchConflicts?: boolean;
  // Directory mode
  directoryPath?: string;
  // Common
  categoryId?: string;
  initialPrompt?: string;
  // Local files pasted or dropped into the prompt: copied into the workspace's
  // `.komla-files/` and appended to the prompt as `@path` references
  attachments?: string[];
  launchModeId?: string;
  // null = agent default; undefined = no choice made (keeps the remembered level)
  reasoningLevelId?: string | null;
  // Agent preset to use (defaults to first active preset)
  presetId?: string;
  // Initial command (runs command then returns to shell)
  initialCommand?: string;
  // The Action the workspace starts with, when one launches it (defaults to the last used)
  defaultActionId?: string;
  // Override base branch for worktree creation
  baseBranch?: string;
  // Fetch the base branch from origin and start the new worktree branch from
  // origin/<base> unless the local base has unpushed commits (local
  // launches; SSH hosts always fetch origin). Defaults to true for a new
  // branch off the project target, false for exact names and other bases.
  startFromOrigin?: boolean;
  // SSH launches: the base branch is a local branch on the host, not one on origin
  baseBranchOnHost?: boolean;
  // Workspace whose branch should be used as the starting point. The main
  // process uses this ID to preserve SSH host repository affinity.
  sourceWorkspaceId?: string;
  // Window assignment
  windowId?: string;
  // If true, the service generates the branch name + worktree in the background
  deferBranchNaming?: boolean;
  // Override global autoNameBranches config for this workspace creation
  autoNameBranches?: boolean;
  // Fetch the branch from the remote before creating the worktree (triggers SSH)
  fetchRemote?: boolean;
  // Check out branchName instead of creating it (used by existing-branch workspaces)
  checkoutExistingBranch?: boolean;
  // Internal: skip recording preset/launch-mode usage (e.g. MCP-created workspaces)
  skipRecordUsage?: boolean;
  // Preferred creation interface. Legacy callers may still use location.
  environment?: DesiredWorkspaceEnvironment;
  location?:
    | { kind: 'local' }
    | {
        kind: 'ssh';
        hostId: string;
        gitUrl?: string;
        // Internal: preserve the exact managed repository roots when creating
        // a sibling of an existing SSH workspace.
        sourceBackend?: SshWorkspaceBackend;
      };
}

export function isSshWorkspace<T extends Pick<Workspace, 'backend'>>(
  workspace: T
): workspace is T & { backend: SshWorkspaceBackend } {
  return workspace.backend?.kind === 'ssh';
}

/** A workspace whose files are ready to read, on this computer or on its SSH host. */
export function hasWorkspaceFiles(
  workspace: Pick<Workspace, 'provisioning' | 'provisionError'>
): boolean {
  return !workspace.provisioning && !workspace.provisionError;
}

/** The workspace that asks for its project's icon, once its files are ready to read. */
export function canPromptForProjectIcon(
  project: Pick<Project, 'iconPromptWorkspaceId'>,
  workspace: Pick<Workspace, 'id' | 'provisioning' | 'provisionError'>
): boolean {
  return project.iconPromptWorkspaceId === workspace.id && hasWorkspaceFiles(workspace);
}

export function resolveWorkspaceTargetBranch(
  workspace: Pick<Workspace, 'baseBranch' | 'backend'> | null | undefined,
  projectBaseBranch?: string,
  statusTargetBranch?: string
): string | undefined {
  return (
    workspace?.baseBranch ||
    projectBaseBranch ||
    (workspace && isSshWorkspace(workspace) ? workspace.backend.baseBranch : undefined) ||
    statusTargetBranch
  );
}

export function canDeleteWorkspaceBranch(
  workspace: Pick<Workspace, 'isWorktree' | 'branchName' | 'baseBranch' | 'backend'>,
  projectBaseBranch?: string
): boolean {
  const targetBranch = resolveWorkspaceTargetBranch(workspace, projectBaseBranch);
  return Boolean(
    workspace.isWorktree &&
    workspace.branchName &&
    workspace.branchName !== 'main' &&
    workspace.branchName !== 'master' &&
    workspace.branchName !== targetBranch
  );
}

/** A branch reference as a local branch name: `origin/x`, `refs/heads/x` and `refs/remotes/origin/x` are `x`. */
export function toLocalBranchName(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^(?:refs\/remotes\/)?origin\//, '');
}

/**
 * The local branches a project relies on, which leftover-branch cleanup never offers: main,
 * master, the given project branches, and every branch its workspaces are on, target or came
 * from. Remote forms such as `origin/x` protect both `x` and the name as written.
 */
export function getBranchesInUse(
  projectBranches: readonly string[],
  workspaces: ReadonlyArray<
    Pick<Workspace, 'branchName' | 'baseBranch' | 'branchedFrom' | 'backend'>
  >
): Set<string> {
  const names = ['main', 'master', ...projectBranches];
  for (const workspace of workspaces) {
    names.push(
      ...[
        workspace.branchName,
        workspace.baseBranch,
        workspace.branchedFrom,
        isSshWorkspace(workspace) ? workspace.backend.baseBranch : undefined,
      ].filter((name): name is string => !!name?.trim())
    );
  }
  return new Set(names.flatMap((name) => [name.trim(), toLocalBranchName(name)]));
}

export function getWorkspaceCwdIdentity(
  workspace: Pick<Workspace, 'workingDirectory' | 'backend'>
): string {
  return workspace.backend?.kind === 'ssh'
    ? workspace.backend.remoteDirectory
    : workspace.workingDirectory;
}

export function isWorkspaceAttentionActionable(attention: WorkspaceAttention | undefined): boolean {
  if (!attention) return false;
  return attention.kind === 'input-required' || attention.kind === 'error';
}

/** Attention the user still has to look at: anything but an idle reminder. */
export function needsAttention(attention: WorkspaceAttention | undefined): boolean {
  return !!attention && attention.kind !== 'idle';
}

type WorkspaceSnooze = Pick<
  Workspace,
  'snoozedUntil' | 'wakesOnNotification' | 'snoozeOutlastsTurnOf'
>;

/** Whether the workspace is on the Snoozed shelf: until a time, its next notification, or both. */
export function isWorkspaceSnoozed(workspace: WorkspaceSnooze): boolean {
  return workspace.snoozedUntil !== undefined || workspace.wakesOnNotification === true;
}

/** Whether `attention` ends the turn of the agent that snoozed its workspace until notified. */
export function endsSnoozingTurn(
  workspace: WorkspaceSnooze,
  attention: WorkspaceAttention
): boolean {
  return (
    workspace.snoozeOutlastsTurnOf !== undefined &&
    attention.terminalId === workspace.snoozeOutlastsTurnOf &&
    attention.kind === 'turn-complete' &&
    attention.source !== COMMAND_ATTENTION_SOURCE
  );
}

/**
 * Whether attention raised in a snoozed workspace ends its snooze: an agent waiting on the user or
 * failing always does, and any notification does for a snooze until notified, except the end of
 * the turn that snoozed it.
 */
export function attentionWakesSnooze(
  workspace: WorkspaceSnooze,
  attention: WorkspaceAttention
): boolean {
  if (!isWorkspaceSnoozed(workspace)) return false;
  if (isWorkspaceAttentionActionable(attention)) return true;
  return (
    workspace.wakesOnNotification === true &&
    needsAttention(attention) &&
    !endsSnoozingTurn(workspace, attention)
  );
}

/**
 * Whether `current` stays shown when `incoming` arrives from another terminal:
 * a prompt or error outranks everything else.
 */
export function attentionOutranks(
  current: WorkspaceAttention | undefined,
  incoming: WorkspaceAttention
): boolean {
  return isWorkspaceAttentionActionable(current) && !isWorkspaceAttentionActionable(incoming);
}

/**
 * The attention to surface from several terminals: a prompt or error, then done, then any, the
 * latest among equals, leaving out what the user has seen.
 */
export function pickWorkspaceAttention(
  attentions: (WorkspaceAttention | undefined)[]
): WorkspaceAttention | undefined {
  const unseen = attentions
    .filter((attention): attention is WorkspaceAttention => !!attention && !attention.seen)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    unseen.find(isWorkspaceAttentionActionable) ??
    unseen.find((attention) => attention.kind === 'turn-complete') ??
    unseen[0]
  );
}

/** The source of a command run with `komla notify --`, which is no agent. */
export const COMMAND_ATTENTION_SOURCE = 'command';

/**
 * Error prefixes used to classify expected workspace creation errors.
 * Keep in sync: these are matched by the IPC handler to return errors as values.
 */
export const WORKSPACE_LIMIT_ERROR_PREFIX = 'WORKSPACE_LIMIT:';
export const DUPLICATE_WORKSPACE_ERROR_PREFIX = 'DUPLICATE_WORKSPACE:';

/** A workspace delete failed because opencode's background service still uses the worktree. */
export const OPENCODE_HOLDS_WORKTREE_ERROR_PREFIX = 'OPENCODE_HOLDS_WORKTREE:';

/**
 * Expected (non-exceptional) errors from workspace creation.
 * Returned as values instead of thrown so Electron doesn't log them as IPC errors.
 */
export interface WorkspaceCreateError {
  __workspaceCreateError: true;
  message: string;
  /** Set when an SSH workspace's project has no Git remote for the host to clone. */
  sshProjectNeedsRemote?: SshProjectNeedsRemote;
}

/** A project to publish before an SSH host can clone it for a new workspace. */
export interface SshProjectNeedsRemote {
  projectId: string;
  /** Local branches the workspace starts from, which the new remote must have. */
  branches: string[];
}

/** An SSH workspace was requested for a project with no Git remote for the host to clone. */
export class SshProjectNeedsRemoteError extends Error {
  readonly detail: SshProjectNeedsRemote;

  constructor(detail: SshProjectNeedsRemote) {
    super('SSH workspaces require a Git remote URL. Add a remote to this project.');
    this.name = 'SshProjectNeedsRemoteError';
    this.detail = detail;
  }
}

/** Rebuilds the error a WorkspaceCreateError value stands for on the other side of IPC. */
export function workspaceCreateException(error: WorkspaceCreateError): Error {
  return error.sshProjectNeedsRemote
    ? new SshProjectNeedsRemoteError(error.sshProjectNeedsRemote)
    : new Error(error.message);
}

export type WorkspaceCreateResult = Workspace | WorkspaceCreateError;
export type WorkspaceCreateBatchResult = Workspace[] | WorkspaceCreateError;

export function isWorkspaceCreateError(
  result: WorkspaceCreateResult | WorkspaceCreateBatchResult
): result is WorkspaceCreateError {
  return '__workspaceCreateError' in result && result.__workspaceCreateError === true;
}

/**
 * Expected (non-exceptional) errors from workspace restart.
 * Returned as values instead of thrown so Electron doesn't log them as IPC errors.
 */
export interface WorkspaceRestartError {
  __workspaceRestartError: true;
  message: string;
}

export type WorkspaceRestartResult = Terminal | WorkspaceRestartError;

export function isWorkspaceRestartError(
  result: WorkspaceRestartResult
): result is WorkspaceRestartError {
  return '__workspaceRestartError' in result && result.__workspaceRestartError === true;
}
