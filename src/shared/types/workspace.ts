/**
 * Workspace-related types shared between main and renderer processes.
 */

import type { Project } from './project';
import type { Terminal, TerminalExecutionLocation } from './terminal';
import type { DesiredWorkspaceEnvironment } from '../lib/agent-environment';
import type { WorkspaceMarker } from '../lib/workspace-markers';
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

/** A browser pane's tabs, as its workspace saves them. */
export interface WorkspaceBrowserPane {
  browserTabs: WorkspaceBrowserTab[];
  activeBrowserTabId?: string;
}

/**
 * What a pane of a saved layout shows: a browser or a note, which opens again as it was, or the
 * agent or a Setup step's terminal, whose place the terminal that starts in its stead takes.
 */
export type WorkspaceLayoutPane =
  | ({ kind: 'browser' } & WorkspaceBrowserPane)
  | { kind: 'note'; /** The note's file name. */ name: string }
  | { kind: 'agent' }
  | { kind: 'setup-step'; stepId: string };

export type WorkspaceLayoutNode =
  | { type: 'leaf'; pane: WorkspaceLayoutPane }
  | {
      type: 'split';
      direction: 'horizontal' | 'vertical';
      sizes: [number, number];
      children: [WorkspaceLayoutNode, WorkspaceLayoutNode];
    };

/**
 * A workspace's tabs as it last showed them while it had a browser or a note, which open again
 * in their places when it starts again. Other terminals don't start again, so their panes go.
 */
export interface WorkspaceSavedLayout {
  tabs: WorkspaceLayoutNode[];
  /** The index of the tab on screen. */
  activeTab?: number;
}

/**
 * A pane a Setup step opened in place of a terminal, which the window lays out among the
 * workspace's terminals as it does the terminals' own layout hints.
 */
export interface WorkspaceSetupPane {
  /** The pane's surface id, which the layout holds where a terminal id would go. */
  id: string;
  kind: 'browser' | 'note';
  /** The pages a browser opens, the first one showing; none finds the workspace's dev server. */
  urls?: string[];
  /** Unset for the first visible item of the Setup run. */
  layoutHint?: 'tab' | 'split-right' | 'split-bottom';
  /** How many of the workspace's terminals launched before it, which it follows in the layout. */
  afterTerminals: number;
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
  /** Resumes the agent's last session with its continue command, where it has one. */
  resumeAgent?: boolean;
  /**
   * `local-copy` replaces an SSH terminal's remote session with a plain Local copy shell;
   * `workspace` moves a Local copy terminal back to a shell on the SSH host.
   */
  executionLocation?: 'local-copy' | 'workspace';
}

export interface AddAgentTabOptions {
  /** Leave the workspace's agent and launch mode, and the last agent used, as they were. */
  keepWorkspaceAgent?: boolean;
  /** One of the agent's reasoning levels for this tab; absent, the agent's default. */
  reasoningLevelId?: string;
}

export const WORKSPACE_ATTENTION_KINDS = [
  'input-required',
  'turn-complete',
  'error',
  'idle',
  'generic',
] as const;
export type WorkspaceAttentionKind = (typeof WORKSPACE_ATTENTION_KINDS)[number];
/**
 * The kinds a notification sent from code takes, as `komla notify --kind`: a public subset of the
 * attention kinds, which may grow kinds of their own that code shouldn't send.
 */
export const NOTIFY_KINDS = [
  'input-required',
  'turn-complete',
  'error',
  'idle',
  'generic',
] as const satisfies readonly WorkspaceAttentionKind[];
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
  /**
   * The delivery of the hook that raised it, or that ended the turn whose done a program reported.
   * Every Komla installation showing the Terminal took that hook, so it names the done to them
   * when the user sees it on one.
   */
  deliveryId?: string;
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

/**
 * Main asks the window showing a workspace to open a page, or the workspace's browser, in Komla,
 * or to offer a page for the user to open.
 */
export interface OpenDevPreviewEvent {
  workspaceId: string;
  url?: string;
  /** Where the terminal that printed the URL runs, for a page on that machine. */
  urlExecutionLocation?: TerminalExecutionLocation;
  /** Offer `url` with a toast and a dot on the globe button, instead of opening it. */
  offer?: boolean;
}

/**
 * A drafted launch, `komla launch --draft`: the window opens New Workspace with it filled in, and
 * the user changes it and starts it, or not.
 */
export interface NewWorkspaceDraft {
  /** The workspace it came from, whose window opens the draft. */
  workspaceId?: string;
  prompt?: string;
  projectId?: string;
  /** The branch to start from, the calling workspace's for a draft from the current branch. */
  baseBranch?: string;
  /** The workspace whose machine and clone the branch is on. */
  sourceWorkspaceId?: string;
  sshHostId?: string;
  presetId?: string;
  launchModeId?: string;
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
  /** A Scratch workspace: its folder is Komla's, made for it, and is deleted along with it. */
  scratch?: boolean;

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
  // Model selected for this workspace (null = agent default)
  modelId?: string | null;

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
  /** The Sidebar Panel showing in place of its file tree, by id; null or none shows the tree. */
  sidebarPanelId?: string | null;
  /** Its browsers and notes, in their places among its tabs, which open again when it starts again. */
  savedLayout?: WorkspaceSavedLayout;
  /** The panes Setup opened besides terminals as the workspace was created. Not saved. */
  setupPanes?: WorkspaceSetupPane[];
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
   * What scripts show on the card, such as "PR #12", each under its own key. One with a spinner
   * is work under way, such as "CI running", and isn't saved, so it ends with Komla.
   */
  markers?: WorkspaceMarker[];
  /**
   * Where the branch's pull request stood at the last read, so a tag the user took off stays off
   * until the pull request moves on.
   */
  pullRequestState?: PullRequestTagState;
  /** Kept in the sidebar's Snoozed shelf until this time. */
  snoozedUntil?: number;
  /** Kept in the Snoozed shelf until the workspace's next notification, or snoozedUntil first. */
  wakesOnNotification?: boolean;
  agentActive?: boolean; // True while the agent is processing (set on prompt-submit, activity, or Claude Code input-required; cleared on accepted turn-complete/idle)
  agentActiveSince?: number; // When agentActive last turned on
  agentLaunching?: boolean; // True while it is set up to start an agent on a prompt, which shows working before it has a Terminal
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
  // Directory mode: an empty folder Komla makes for a Scratch workspace, instead of directoryPath
  scratch?: boolean;
  // Common
  categoryId?: string;
  initialPrompt?: string;
  // Local files pasted or dropped into the prompt: copied into the workspace's
  // `.komla-files/` and appended to the prompt as `@path` references
  attachments?: string[];
  launchModeId?: string;
  // null = agent default; undefined = no choice made (keeps the remembered level)
  reasoningLevelId?: string | null;
  // null = agent default; undefined = no choice made (keeps the remembered model)
  modelId?: string | null;
  // Arguments the first agent starts with after its launch mode's and reasoning level's, such
  // as an automation's; later agent tabs start without them
  extraArguments?: string;
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
  // Where the workspace goes. The renderer names only this.
  environment?: DesiredWorkspaceEnvironment;
  // Internal: the resolved placement, which creation derives from environment. Main-process
  // callers may set it to name an SSH clone's Git URL or a source workspace's repository roots.
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

type WorkspaceSnooze = Pick<Workspace, 'snoozedUntil' | 'wakesOnNotification'>;

/** Whether the workspace is on the Snoozed shelf: until a time, its next notification, or both. */
export function isWorkspaceSnoozed(workspace: WorkspaceSnooze): boolean {
  return workspace.snoozedUntil !== undefined || workspace.wakesOnNotification === true;
}

/**
 * Whether attention raised in a snoozed workspace ends its snooze: an agent waiting on the user or
 * failing always does, and any notification does for a snooze until notified, also the end of
 * the turn of an agent that snoozed it.
 */
export function attentionWakesSnooze(
  workspace: WorkspaceSnooze,
  attention: WorkspaceAttention
): boolean {
  if (!isWorkspaceSnoozed(workspace)) return false;
  if (isWorkspaceAttentionActionable(attention)) return true;
  return workspace.wakesOnNotification === true && needsAttention(attention);
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
 * Error prefix used to classify an expected workspace creation error.
 * Keep in sync: it is matched by the IPC handler to return the error as a value.
 */
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
