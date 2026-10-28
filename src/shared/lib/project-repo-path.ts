import type { Project } from '../types/project';

/** The local clone Komla works in: a managed project's own clone, otherwise the user's repository. */
export function projectRepoPath(
  project: Pick<Project, 'managed' | 'managedRepoPath' | 'repositoryPath'>
): string {
  return project.managed && project.managedRepoPath
    ? project.managedRepoPath
    : project.repositoryPath;
}
