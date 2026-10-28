/**
 * Project-related types shared between main and renderer processes.
 */

import type { SshWorkspaceMode } from '../lib/ssh-workspace-mode';

export const SETUP_STEP_PLACEMENTS = ['background', 'tab', 'split-right', 'split-bottom'] as const;
export const SETUP_DESTINATIONS = [
  'workspace-repository',
  'local-workspace-repository',
  'ssh-workspace-repository',
  'ssh-local-copy',
] as const;
export const SETUP_TRIGGERS = [
  'workspace-creation',
  'every-workspace-start',
  'workspace-stop',
] as const;
export type SetupStepPlacement = (typeof SETUP_STEP_PLACEMENTS)[number];
export type SetupDestination = (typeof SETUP_DESTINATIONS)[number];
export type SetupTrigger = (typeof SETUP_TRIGGERS)[number];

export type AgentPlacement = 'tab' | 'split-right' | 'split-bottom';
export type ProjectKind = 'git' | 'directory';

/** Action when clicking the commits behind (↓N) indicator */
export type BehindTargetAction = 'auto' | 'rebase' | 'merge';

/** Action types that can be assigned directly (not 'auto-default' or 'auto').
 * 'merge' fast-forwards the target branch. */
export type SimpleAheadAction = 'merge' | 'pr' | 'disabled' | 'agent-prompt';

/** Top-level commits ahead (↑N) mode:
 * - 'auto-default': PR for main/master, fast-forward others (simple preset, no sub-dropdowns)
 * - 'auto': custom per-branch settings with sub-dropdowns
 * - others apply uniformly */
export type AheadTargetAction = 'auto-default' | 'auto' | 'unconfigured' | SimpleAheadAction;

/** App-wide git settings, which a project follows where it has no value of its own. */
export interface GitDefaults {
  /** Starts new workspace branch names in projects with an empty prefix. */
  branchPrefix?: string;
  /** ↑N for the default branch and for other targets; both unset asks on first click. */
  aheadMainAction?: SimpleAheadAction;
  aheadOtherAction?: SimpleAheadAction;
  /** The quick command an 'agent-prompt' choice runs; one every project can see. */
  aheadMainActionId?: string;
  aheadOtherActionId?: string;
  /** Push the target branch after fast-forwarding it. Unset pushes. */
  autoPushAfterMerge?: boolean;
  behindTargetAction?: BehindTargetAction;
}

export interface SetupStep {
  id: string;
  name: string;
  command: string;
  placement: SetupStepPlacement;
  actionId?: string;
  /** Launch a fresh agent. An empty object inherits the workspace preset and launch mode. */
  agent?: {
    presetId?: string;
    launchModeId?: string;
  };
  /** Defaults to workspace-repository. */
  destination?: SetupDestination;
  /**
   * Defaults to every-workspace-start. A workspace-stop step runs a shell command in the
   * background once the workspace's terminals have stopped.
   */
  trigger?: SetupTrigger;
}

export interface Project {
  id: string;
  kind?: ProjectKind;
  name: string;
  repositoryPath: string;
  defaultBranchPrefix: string;
  createdAt: number;
  order: number;
  color?: string;
  /** Data URL of an image picked from the project's files, shown instead of the color dot. */
  icon?: string;
  /** The new workspace that offers the icons found in its files, here or on its SSH host. */
  iconPromptWorkspaceId?: string;
  /** Set once icons were offered, so a project kept with its color dot isn't asked again. */
  iconPromptAsked?: boolean;
  setupSteps?: SetupStep[];
  baseBranch?: string;
  agentPlacement?: AgentPlacement;
  agentLayoutOrder?: number;
  trashCleanupScript?: string;
  managed: boolean;
  managedRepoPath?: string;
  // Unset git settings follow GitDefaults; an empty defaultBranchPrefix does too.
  aheadTargetAction?: AheadTargetAction;
  autoPushAfterMerge?: boolean;
  aheadTargetActionId?: string;
  // Auto mode: separate actions for the default branch vs other targets; unset follows GitDefaults
  autoMainBranchAction?: SimpleAheadAction;
  autoOtherBranchAction?: SimpleAheadAction;
  autoMainActionId?: string;
  autoOtherActionId?: string;
  behindTargetAction?: BehindTargetAction; // 'auto': rebase for local branches, merge for pushed branches
  /** Undefined prompts for a choice before the first eligible SSH Terminal Command. */
  sshWorkspaceMode?: SshWorkspaceMode;
}

/** What a folder picked with Open Folder already is to Komla. */
export interface FolderProjectMatch {
  /** The project the folder, its repository or the repository of its worktree is. */
  project: Project | null;
  /** The root of the Git repository the folder is in, when that isn't a project yet. */
  repoRoot: string | null;
}

/** An image in a project's files that could be its icon. */
export interface ProjectIconCandidate {
  /** Where it was found, relative to the folder scanned, with forward slashes. */
  path: string;
  dataUrl: string;
}

/** Where to look for icons: a folder not yet added, or an existing project's files. */
export type ProjectIconSource = { folder: string } | { projectId: string };

/** A local branch no workspace uses and no worktree has checked out. */
export interface LeftoverBranch {
  name: string;
  /** What the branch points at, so it can be restored with `git branch <name> <commit>`. */
  commit: string;
  lastCommitAt: number;
  subject: string;
  /** Every change on it is already in the target branch: merged, rebased, cherry-picked or squashed. */
  landed: boolean;
}

export interface LeftoverBranches {
  targetBranch: string;
  branches: LeftoverBranch[];
}

export interface BranchDeletionResult {
  deleted: string[];
  failed: Array<{ name: string; message: string }>;
}

/** What moving a worktree to the Trash would set aside that its target branch doesn't have. */
export interface WorktreeCleanupCheck {
  /** Every change on its HEAD is already in the target branch. */
  landed: boolean;
  /** It has files it hasn't committed, untracked ones included. */
  uncommittedChanges: boolean;
}

/** A project's workspace on a branch, as workspace cleanup sees it. */
export type WorkspaceCleanupStatus = {
  workspaceId: string;
  targetBranch: string;
} & (({ ok: true } & WorktreeCleanupCheck) | { ok: false; error: string });

export interface CreateProjectParams {
  kind?: ProjectKind;
  name?: string;
  repositoryPath: string;
  defaultBranchPrefix?: string;
  baseBranch?: string;
  color?: string;
  icon?: string;
  /** The form offered the folder's icons, so its first workspace doesn't offer them again. */
  iconPromptAsked?: boolean;
  aheadTargetAction?: AheadTargetAction;
  autoPushAfterMerge?: boolean;
  aheadTargetActionId?: string;
  autoMainBranchAction?: SimpleAheadAction;
  autoOtherBranchAction?: SimpleAheadAction;
  autoMainActionId?: string;
  autoOtherActionId?: string;
  behindTargetAction?: BehindTargetAction;
}

export interface CreateProjectFromRemoteParams {
  remoteUrl: string;
  name?: string;
  defaultBranchPrefix?: string;
  baseBranch?: string;
  color?: string;
  icon?: string;
  aheadTargetAction?: AheadTargetAction;
  autoPushAfterMerge?: boolean;
  aheadTargetActionId?: string;
  autoMainBranchAction?: SimpleAheadAction;
  autoOtherBranchAction?: SimpleAheadAction;
  autoMainActionId?: string;
  autoOtherActionId?: string;
  behindTargetAction?: BehindTargetAction;
}

export interface CreateProjectFromNewParams {
  name: string;
  defaultBranchPrefix?: string;
  color?: string;
  icon?: string;
  aheadTargetAction?: AheadTargetAction;
  autoPushAfterMerge?: boolean;
  aheadTargetActionId?: string;
  autoMainBranchAction?: SimpleAheadAction;
  autoOtherBranchAction?: SimpleAheadAction;
  autoMainActionId?: string;
  autoOtherActionId?: string;
  behindTargetAction?: BehindTargetAction;
}
