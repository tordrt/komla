import { resolve } from 'path';

import { isSshWorkspace } from '../../../shared/types/workspace';
import { gitService } from '../git.service';
import { projectService } from '../project.service';
import { remoteWorkspaceObservationService } from '../remote-workspace-observation.service';

import { workspaceStore } from './store';

import type { Project, Workspace } from '../../../shared/types';

export function workspaceProject(workspace: Workspace): Project | undefined {
  return workspace.projectId ? projectService.get(workspace.projectId) : undefined;
}

/**
 * Folders opened before folders became folder projects join one, in the color they had.
 * Ones in the Trash join when they're restored, so old folders add no projects.
 */
export function moveFoldersIntoProjects(): boolean {
  let moved = false;
  for (const workspace of workspaceStore.workspaces.values()) {
    if (workspace.status === 'active' && moveFolderIntoProject(workspace)) moved = true;
  }
  return moved;
}

export function moveFolderIntoProject(workspace: Workspace): boolean {
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

/** The local worktree workspace at `path`, with the repositories its worktree may come from. */
export function managedWorktree(
  path: string
): { worktreePath: string; repoPaths: string[] } | undefined {
  const target = resolve(path);
  for (const workspace of workspaceStore.workspaces.values()) {
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

export function registerBaseBranches(): void {
  // Register configured target branches with git service
  const projectIdsNeedingFallback = new Set<string>();
  for (const workspace of workspaceStore.workspaces.values()) {
    if (isSshWorkspace(workspace)) continue;
    if (workspace.baseBranch) {
      gitService.registerTargetBranch(workspace.workingDirectory, workspace.baseBranch);
    } else if (workspace.projectId) {
      // For workspaces without their own baseBranch, fall back to project baseBranch
      projectIdsNeedingFallback.add(workspace.projectId);
    }
  }
  for (const projectId of projectIdsNeedingFallback) {
    propagateProjectBaseBranch(projectId);
  }
}

/**
 * Propagate a project's baseBranch to GitService for all workspaces in that project
 * that don't have their own baseBranch override.
 */
export function propagateProjectBaseBranch(projectId: string): void {
  const project = projectService.get(projectId);
  if (!project) return;

  let sshWorkspaceChanged = false;
  for (const workspace of workspaceStore.workspaces.values()) {
    if (workspace.projectId !== projectId || workspace.baseBranch) continue;

    if (isSshWorkspace(workspace)) {
      workspace.backend.baseBranch = project.baseBranch || workspace.backend.defaultBranch;
      sshWorkspaceChanged = true;
    } else {
      gitService.registerTargetBranch(workspace.workingDirectory, project.baseBranch);
    }
  }
  if (sshWorkspaceChanged) {
    workspaceStore.saveWorkspaces();
    void remoteWorkspaceObservationService.reconcile();
  }
}
