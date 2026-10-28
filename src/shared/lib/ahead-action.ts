import type { Project, SimpleAheadAction } from '../types/project';

/** Check whether a branch name is a main/master branch */
export function isMainBranch(branchName: string | undefined | null): boolean {
  return !branchName || branchName === 'main' || branchName === 'master';
}

/** Whether a target gets the default-branch action: main/master, or the branch origin/HEAD names. */
export function isDefaultBranchTarget(
  targetBranch: string | undefined | null,
  remoteDefaultBranch: string | undefined | null
): boolean {
  return (
    isMainBranch(targetBranch) || (!!remoteDefaultBranch && targetBranch === remoteDefaultBranch)
  );
}

export interface ResolveBehindActionParams {
  project: Pick<Project, 'behindTargetAction'> | undefined | null;
  /** Whether the current branch has a remote tracking ref (has been pushed) */
  hasRemote: boolean;
}

/**
 * Resolve the effective sync action when the branch is behind the target branch.
 *
 * - Explicit setting: returns it directly
 * - No setting: merge if the branch has a remote tracking ref (already pushed),
 *   rebase if it's local-only (safe to rewrite history)
 */
export function resolveBehindAction(params: ResolveBehindActionParams): 'rebase' | 'merge' {
  const { project, hasRemote } = params;
  const explicit = project?.behindTargetAction;
  if (explicit && explicit !== 'auto') return explicit;
  return hasRemote ? 'merge' : 'rebase';
}

export interface ResolveAheadActionParams {
  project:
    | Pick<Project, 'aheadTargetAction' | 'autoMainBranchAction' | 'autoOtherBranchAction'>
    | undefined
    | null;
  targetBranch: string | undefined | null;
  /** The branch origin/HEAD names, when known */
  remoteDefaultBranch?: string | null;
  /** Whether the repo has an "origin" remote (not whether the branch tracks a remote) */
  hasOriginRemote: boolean;
}

/**
 * Resolve what clicking a workspace's commits ahead (↑N) count does.
 *
 * - Explicit non-auto action: returns that action directly
 * - Auto mode (or undefined): returns per-branch-type action based on target branch
 */
export function resolveAheadAction(params: ResolveAheadActionParams): SimpleAheadAction {
  const { project, targetBranch, remoteDefaultBranch, hasOriginRemote } = params;
  const explicit = project?.aheadTargetAction;
  const isDefaultTarget = isDefaultBranchTarget(targetBranch, remoteDefaultBranch);
  // auto-default / unconfigured: always PR for the default branch, fast-forward others (no custom overrides)
  if (!explicit || explicit === 'auto-default' || explicit === 'unconfigured') {
    if (isDefaultTarget) return hasOriginRemote ? 'pr' : 'merge';
    return 'merge';
  }
  if (explicit !== 'auto') return explicit;
  // Custom auto mode: pick action based on per-branch-type settings
  if (isDefaultTarget) {
    return project?.autoMainBranchAction ?? (hasOriginRemote ? 'pr' : 'merge');
  }
  return project?.autoOtherBranchAction ?? 'merge';
}

export interface UnpushedDisplayParams {
  /** Whether the branch has a remote tracking ref */
  hasRemote: boolean;
  /** Commits ahead of the tracking ref (0 when no tracking ref) */
  unpushedCommits: number;
}

export interface UnpushedDisplay {
  show: boolean;
  count: number;
}

export interface ResolveRemoteWriteActionParams {
  /** Whether the repo has an "origin" remote */
  hasOriginRemote: boolean;
  /** Whether the branch already exists on the remote / tracks a remote branch */
  hasRemote: boolean;
}

export type RemoteWriteAction = 'none' | 'publish' | 'push';

/**
 * Resolve whether to show an unpushed commit indicator and what count to display: only a branch
 * that tracks one on the remote has commits to count. An unpublished branch offers Publish instead.
 */
export function resolveUnpushedDisplay(params: UnpushedDisplayParams): UnpushedDisplay {
  const { hasRemote, unpushedCommits } = params;
  return { show: hasRemote && unpushedCommits > 0, count: unpushedCommits };
}

/** Resolve whether a write-to-remote action should be shown as push or publish. */
export function resolveRemoteWriteAction(
  params: ResolveRemoteWriteActionParams
): RemoteWriteAction {
  const { hasOriginRemote, hasRemote } = params;
  if (!hasOriginRemote) return 'none';
  return hasRemote ? 'push' : 'publish';
}

export interface ResolveRepoPublishParams {
  hasOriginRemote: boolean;
  /** Whether the workspace's branch tracks a branch on the remote */
  hasRemote: boolean;
  /** Whether the target branch is on origin */
  targetBranchHasRemote: boolean;
}

/**
 * Whether to offer publishing the repo: it has no origin, or an origin with neither the
 * workspace's branch nor its target, as when origin points where no repository answers.
 */
export function needsRepoPublish(params: ResolveRepoPublishParams): boolean {
  return !params.hasOriginRemote || (!params.hasRemote && !params.targetBranchHasRemote);
}

export interface ResolveActionIdParams {
  project:
    | Pick<
        Project,
        'aheadTargetAction' | 'aheadTargetActionId' | 'autoMainActionId' | 'autoOtherActionId'
      >
    | undefined
    | null;
  targetBranch: string | undefined | null;
  /** The branch origin/HEAD names, when known */
  remoteDefaultBranch?: string | null;
}

/**
 * Resolve the action ID for the agent-prompt action.
 *
 * In auto mode, returns the per-branch-type action ID.
 * In explicit mode, returns the project-level action ID.
 */
export function resolveActionId(params: ResolveActionIdParams): string | undefined {
  const { project, targetBranch, remoteDefaultBranch } = params;
  if (!project) return undefined;
  const explicit = project.aheadTargetAction;
  // auto-default has no action IDs (it's always PR/merge)
  if (!explicit || explicit === 'auto-default' || explicit === 'unconfigured') return undefined;
  if (explicit !== 'auto') return project.aheadTargetActionId ?? undefined;
  // Custom auto mode
  if (isDefaultBranchTarget(targetBranch, remoteDefaultBranch)) {
    return project.autoMainActionId ?? undefined;
  }
  return project.autoOtherActionId ?? undefined;
}
