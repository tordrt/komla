import { useGitStatusStore } from '@/stores/git-status.store';
import { useProjectsStore } from '@/stores/projects.store';
import {
  usePublishRepoDialogStore,
  type PublishRepoDialogRequest,
} from '@/stores/publish-repo-dialog.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { projectRepoPath } from '../../../shared/lib/project-repo-path';

import { PublishRepoDialog } from './PublishRepoDialog';

import type { Project } from '@/types';

/** Gives the new remote the branches the workspace starts from, then creates it again. */
async function finishPublishing(project: Project, request: PublishRepoDialogRequest) {
  const { addToast } = useToastStore.getState();
  let pushError: string | undefined;
  let removedOrigin = false;
  if (request.branches.length > 0) {
    addToast(`Pushing ${request.branches.join(', ')} to the new remote…`, 'info');
    const result = await window.api.pushProjectBranches(project.id, request.branches);
    if (!result.success) {
      pushError = result.message;
      removedOrigin = result.removedOrigin ?? false;
    }
  }
  // Other workspaces of this project still show it without a remote until refreshed.
  const { invalidateStatus, fetchStatusIfStale } = useGitStatusStore.getState();
  for (const workspace of useWorkspacesStore.getState().workspaces) {
    if (workspace.projectId !== project.id) continue;
    invalidateStatus(workspace.id);
    void fetchStatusIfStale(workspace.id, workspace.workingDirectory, workspace.projectId);
  }
  if (pushError) {
    addToast(
      removedOrigin
        ? `Couldn't push to the new remote, so it was removed: ${pushError}`
        : `Added the remote, but couldn't push to it: ${pushError}`,
      'error'
    );
    return;
  }
  addToast('Repository published', 'success');
  request.onPublished?.();
}

/** Publishes a project that an SSH workspace can't start without, opened from any create flow. */
export function PublishRepoDialogHost() {
  const open = usePublishRepoDialogStore((s) => s.open);
  const request = usePublishRepoDialogStore((s) => s.request);
  const requestId = usePublishRepoDialogStore((s) => s.requestId);
  const close = usePublishRepoDialogStore((s) => s.close);
  const project = useProjectsStore((s) =>
    request ? s.projects.find((p) => p.id === request.projectId) : undefined
  );

  if (!request || !project) return null;
  return (
    <PublishRepoDialog
      key={requestId}
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      repoPath={projectRepoPath(project)}
      repoName={project.name}
      description={`SSH hosts clone ${project.name} from a Git remote. Publish it to start the workspace.`}
      onPublished={() => void finishPublishing(project, request)}
    />
  );
}
