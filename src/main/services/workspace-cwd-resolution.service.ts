import { realpathSync } from 'fs';
import { normalize, join } from 'path';

import { sanitizeWorktreeProjectSegment } from '../../shared/lib/random-names';
import { getWorkspaceCwdIdentity, isSshWorkspace } from '../../shared/types';

import type { Project, Workspace } from '../../shared/types';

export type WorkspaceCwdResolution =
  | { workspace: Workspace; error?: undefined }
  | { workspace?: undefined; error: string };

export type WorkspaceProjectCwdResolution =
  | { project?: undefined; sourceWorkspace: Workspace; error?: undefined }
  | { project: Project; sourceWorkspace?: Workspace; error?: undefined }
  | { project?: undefined; sourceWorkspace?: undefined; error: string };

export interface WorkspaceCwdResolutionContext {
  workspaces: Workspace[];
  getProject: (projectId: string) => Project | undefined;
  komlaBasePath: string;
}

class WorkspaceCwdResolutionService {
  findProjectByCwd(
    cwd: string,
    context: WorkspaceCwdResolutionContext
  ): WorkspaceProjectCwdResolution {
    const candidates = this.findCandidatesByCwd(cwd, context);
    if (candidates.length === 0) return { error: 'No matching workspace found' };

    const projectsById = new Map<string, Project>();
    for (const workspace of candidates) {
      if (!workspace.projectId) continue;
      const project = context.getProject(workspace.projectId);
      if (project) projectsById.set(project.id, project);
    }

    if (projectsById.size === 0) {
      const sshCandidates = candidates.filter(isSshWorkspace);
      const runningSshCandidates = sshCandidates.filter((workspace) =>
        this.hasRunningTerminal(workspace)
      );
      const sourceWorkspace =
        sshCandidates.length === 1
          ? sshCandidates[0]
          : runningSshCandidates.length === 1
            ? runningSshCandidates[0]
            : undefined;
      return sourceWorkspace
        ? { sourceWorkspace }
        : {
            error:
              sshCandidates.length > 1
                ? `Multiple SSH workspaces match cwd: ${cwd}. This workspace creation request cannot safely choose a source.`
                : 'No matching workspace found',
          };
    }

    let project: Project | undefined;
    if (projectsById.size === 1) {
      project = Array.from(projectsById.values())[0];
    } else {
      const runningProjectIds = new Set(
        candidates
          .filter((workspace) => this.hasRunningTerminal(workspace))
          .map((workspace) => workspace.projectId)
          .filter((projectId): projectId is string => !!projectId && projectsById.has(projectId))
      );
      if (runningProjectIds.size !== 1) {
        return {
          error: `Multiple projects match cwd: ${cwd}. This workspace creation request cannot safely choose a project.`,
        };
      }
      project = projectsById.get(Array.from(runningProjectIds)[0]);
    }

    if (!project) return { error: 'No matching workspace found' };

    const projectCandidates = candidates.filter((workspace) => workspace.projectId === project.id);
    const runningProjectCandidates = projectCandidates.filter((workspace) =>
      this.hasRunningTerminal(workspace)
    );
    const sourceWorkspace =
      projectCandidates.length === 1
        ? projectCandidates[0]
        : runningProjectCandidates.length === 1
          ? runningProjectCandidates[0]
          : undefined;

    return { project, sourceWorkspace };
  }

  findCandidatesByCwd(cwd: string, context: WorkspaceCwdResolutionContext): Workspace[] {
    const normalizedCwd = this.normalizeForComparison(cwd);

    const exactMatches = context.workspaces.filter((workspace) => {
      const normalizedWorkspaceDir = this.normalizeForComparison(
        getWorkspaceCwdIdentity(workspace)
      );
      return normalizedCwd === normalizedWorkspaceDir;
    });
    if (exactMatches.length > 0) return exactMatches;

    const bestMatches = this.findDeepestDirectoryMatches(normalizedCwd, context.workspaces);
    if (bestMatches.length > 0) return bestMatches;

    const fallback = this.findWorktreePathMatch(normalizedCwd, context);
    return fallback ? [fallback] : [];
  }

  resolveWorkspaceByCwd(
    cwd: string,
    context: WorkspaceCwdResolutionContext,
    options: { rejectAmbiguousMatches?: boolean } = {}
  ): WorkspaceCwdResolution {
    const normalizedCwd = this.normalizeForComparison(cwd);

    const exactMatches = context.workspaces.filter((workspace) => {
      const normalizedWorkspaceDir = this.normalizeForComparison(
        getWorkspaceCwdIdentity(workspace)
      );
      return normalizedCwd === normalizedWorkspaceDir;
    });
    let matchingWorkspace: Workspace | undefined = exactMatches[0];
    if (options.rejectAmbiguousMatches && exactMatches.length > 0) {
      const resolution = this.resolveObviousWorkspaceMatch(cwd, exactMatches);
      if (!resolution.workspace || exactMatches.length > 1) return resolution;
    }

    if (!matchingWorkspace) {
      const bestMatches = this.findDeepestDirectoryMatches(normalizedCwd, context.workspaces);

      if (options.rejectAmbiguousMatches && bestMatches.length > 0) {
        const resolution = this.resolveObviousWorkspaceMatch(cwd, bestMatches);
        if (!resolution.workspace || bestMatches.length > 1) return resolution;
      }
      matchingWorkspace = bestMatches[0];
    }

    if (!matchingWorkspace) {
      matchingWorkspace = this.findWorktreePathMatch(normalizedCwd, context);
    }

    return matchingWorkspace
      ? { workspace: matchingWorkspace }
      : { error: 'No matching workspace found' };
  }

  private findDeepestDirectoryMatches(normalizedCwd: string, workspaces: Workspace[]): Workspace[] {
    let bestMatches: Workspace[] = [];
    let bestLength = -1;

    for (const workspace of workspaces) {
      const normalizedWorkspaceDir = this.normalizeForComparison(
        getWorkspaceCwdIdentity(workspace)
      );
      const isWithinWorkspace =
        normalizedCwd === normalizedWorkspaceDir ||
        normalizedCwd.startsWith(`${normalizedWorkspaceDir}/`) ||
        normalizedCwd.startsWith(`${normalizedWorkspaceDir}\\`);

      if (isWithinWorkspace && normalizedWorkspaceDir.length > bestLength) {
        bestMatches = [workspace];
        bestLength = normalizedWorkspaceDir.length;
      } else if (isWithinWorkspace && normalizedWorkspaceDir.length === bestLength) {
        bestMatches.push(workspace);
      }
    }

    return bestMatches;
  }

  private findWorktreePathMatch(
    normalizedCwd: string,
    context: WorkspaceCwdResolutionContext
  ): Workspace | undefined {
    const worktreesBase = this.normalizeForComparison(join(context.komlaBasePath, 'worktrees'));

    if (!normalizedCwd.startsWith(worktreesBase)) return undefined;

    const relativePath = normalizedCwd.slice(worktreesBase.length + 1);
    const segments = relativePath.split(/[/\\]/);

    if (segments.length < 2) return undefined;

    const projectName = segments[0];
    const safeBranchName = segments[1];

    return context.workspaces.find((workspace) => {
      if (!workspace.isWorktree || !workspace.branchName) return false;

      const workspaceSafeBranch = workspace.branchName.replace(/\//g, '-');
      const workspaceProjectName = workspace.repoName;
      const projectMatches =
        workspaceProjectName !== undefined &&
        (workspaceProjectName === projectName ||
          sanitizeWorktreeProjectSegment(workspaceProjectName) === projectName);

      return projectMatches && workspaceSafeBranch === safeBranchName;
    });
  }

  private hasRunningTerminal(workspace: Workspace): boolean {
    if (workspace.status !== 'active') return false;
    return workspace.terminals.some(
      (terminal) => terminal.status === 'running' || terminal.status === 'starting'
    );
  }

  private resolveObviousWorkspaceMatch(
    cwd: string,
    candidates: Workspace[]
  ): WorkspaceCwdResolution {
    if (candidates.length === 0) return { error: 'No matching workspace found' };
    if (candidates.length === 1) return { workspace: candidates[0] };

    const runningMatches = candidates.filter((workspace) => this.hasRunningTerminal(workspace));
    if (runningMatches.length === 1) return { workspace: runningMatches[0] };

    return {
      error: `Multiple workspaces match cwd: ${cwd}. This MCP tool cannot safely choose a workspace unless exactly one matching workspace is running.`,
    };
  }

  private normalizeForComparison(pathValue: string): string {
    const normalizedPath = normalize(pathValue);

    try {
      return normalize(realpathSync.native?.(normalizedPath) ?? realpathSync(normalizedPath));
    } catch {
      return normalizedPath;
    }
  }
}

export const workspaceCwdResolutionService = new WorkspaceCwdResolutionService();
