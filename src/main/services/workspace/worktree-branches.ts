import { join, sep } from 'path';

import { resolveBranchPrefix } from '../../../shared/lib/project-git-defaults';
import {
  generateBranchSuffix,
  sanitizeWorktreeProjectSegment,
} from '../../../shared/lib/random-names';
import { normalizeSshTargetBranch } from '../../../shared/lib/ssh-target-branch';
import { createLogger } from '../../lib/logger';
import { configService } from '../config.service';
import { gitService } from '../git.service';
import { getKomlaBasePath } from '../paths';
import { projectService } from '../project.service';

import { workspaceStore } from './store';

import type { CreateWorkspaceParams, Project, Workspace } from '../../../shared/types';

const logger = createLogger('WorkspaceService');

const AUTO_BRANCH_RANDOM_RETRIES = 4;

export const AUTO_BRANCH_MAX_ATTEMPTS = 25;

/**
 * The base branch as the workspace's target, absent a project target. A branch only the
 * host has can't be one, since target checks compare with origin's copy.
 */
export function sshWorkspaceTargetBranch(params: CreateWorkspaceParams): string | undefined {
  return params.baseBranchOnHost ? undefined : normalizeSshTargetBranch(params.baseBranch);
}

export function resolveSshTargetBranch(
  project: Project | undefined,
  workspaceBaseBranch: string | undefined
): string | undefined {
  return (
    normalizeSshTargetBranch(project?.baseBranch) || normalizeSshTargetBranch(workspaceBaseBranch)
  );
}

export function findBranchConflict(
  projectId: string,
  branchName: string,
  excludeWorkspaceId?: string
): Workspace | undefined {
  return Array.from(workspaceStore.workspaces.values()).find(
    (workspace) =>
      workspace.isWorktree &&
      workspace.projectId === projectId &&
      workspace.branchName === branchName &&
      workspace.id !== excludeWorkspaceId
  );
}

/** The prefix new branches in `project` start with, the app-wide one when it has none. */
export function branchPrefix(project: Project | undefined): string {
  return resolveBranchPrefix(project, configService.get().gitDefaults);
}

export function withBranchPrefix(branchName: string, prefix: string): string {
  if (!prefix) return branchName;
  // Case-insensitive check to prevent double-prefixing (e.g. "claude/claude/feature")
  if (branchName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `${prefix}${branchName.slice(prefix.length)}`;
  }
  return `${prefix}${branchName}`;
}

export async function resolveLocalWorkspaceTarget(
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
    (!params.useExactBranchName && (!requestedStartPoint || requestedStartPoint === projectTarget));
  const originStartPoint =
    startFromOrigin && localStartPoint && !/^(?:origin\/|refs\/)/.test(localStartPoint)
      ? await startPointFromOrigin(repoPath, localStartPoint)
      : undefined;

  return {
    startPoint: originStartPoint || localStartPoint,
    baseBranch: projectTarget || requestedStartPoint || detectedTarget,
  };
}

/**
 * Origin's copy of a branch as a start point, or undefined to keep the local branch. A copy
 * fetched in the last few minutes is used as it is, so the agent doesn't wait on a fetch, and the
 * local branch is kept without fetching when it has commits that copy lacks. Otherwise, or when
 * that fetch didn't bring the branch, the branch is fetched first.
 */
async function startPointFromOrigin(
  repoPath: string,
  branchName: string
): Promise<string | undefined> {
  if (gitService.fetchedOriginRecently(repoPath)) {
    const recent = await gitService.originStartPoint(repoPath, branchName);
    if (recent.status === 'available') return recent.ref;
    // Fetching again can't give origin the local branch's unpushed commits.
    if (recent.status === 'behind-local') return undefined;
  }
  return gitService.fetchOriginStartPoint(repoPath, branchName);
}

export function toSafeWorktreePath(projectName: string, branchName: string): string {
  // Branch names are already sanitized upstream by sanitizeBranchName; the
  // local sanitizer here is defense-in-depth for the path layer.
  const sanitizeBranch = (s: string, fallback: string) =>
    s.replaceAll('\u0000', '').replace(/\.\./g, '--').replace(/[/\\]/g, '-').replace(/^\./, '_') ||
    fallback;

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

export function createAutoBranchCandidate(
  baseBranchName: string,
  prefix: string,
  attempt: number,
  useExactName?: boolean
): string {
  // For meaningful names (user-provided or AI-generated), always use numeric
  // suffixes to preserve intent. Random retries only make sense when the
  // original name was already random.
  if (attempt <= AUTO_BRANCH_RANDOM_RETRIES && !useExactName) {
    return withBranchPrefix(generateBranchSuffix(), prefix);
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
  return withBranchPrefix(`${branchWithoutPrefix}-${numericSuffix}`, prefix);
}

export function createBranchConflictError(branchName: string, workspace?: Workspace): Error {
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

function getInvalidReference(error: unknown): string | undefined {
  const message = (error as Error)?.message || String(error);
  const lowerMessage = message.toLowerCase();

  if (!lowerMessage.includes('invalid reference')) return undefined;

  const refMatch = message.match(/invalid reference:\s*(\S+)/i);
  return refMatch?.[1] || 'unknown';
}

export async function recoverMissingProjectBaseBranch(
  error: unknown,
  project: Project,
  repoPath: string,
  requestedStartPoint: string | undefined
): Promise<string | undefined> {
  const missingRef = getInvalidReference(error);
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

export function normalizeCreateWorktreeError(error: unknown, branchName: string): Error {
  const message = (error as Error)?.message || String(error);
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes('already checked out at') ||
    lowerMessage.includes('already used by worktree') ||
    lowerMessage.includes('worktree already exists') ||
    lowerMessage.includes('already exists at') ||
    lowerMessage.includes('already exists')
  ) {
    return createBranchConflictError(branchName);
  }

  // Invalid reference: the base branch doesn't resolve to a commit.
  // This typically means the project's target branch is misconfigured.
  const invalidRef = getInvalidReference(error);
  if (invalidRef) {
    return new Error(
      `Could not create branch "${branchName}": the base branch "${invalidRef}" does not exist in this repository. Try updating the project's target branch in project settings.`
    );
  }

  return error instanceof Error ? error : new Error(message);
}

export async function fastForwardManagedProjectTargetBeforeCreation(
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

/** Slice the prefix or path segment off a resolved branch name to derive a workspace label. */
export function deriveBranchSuffixForName(branchName: string, prefix: string): string {
  if (branchName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return branchName.slice(prefix.length);
  }
  if (branchName.includes('/')) {
    return branchName.slice(branchName.lastIndexOf('/') + 1);
  }
  return branchName;
}
