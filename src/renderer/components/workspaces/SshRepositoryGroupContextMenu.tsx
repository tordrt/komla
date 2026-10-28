import { FolderPlus, Link } from '@phosphor-icons/react';
import React, { useSyncExternalStore } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import { isSshWorkspace, type Workspace } from '@/types';

import type { WorkspaceGroup } from './workspace-list-ordering';

type SshWorkspace = Workspace & {
  backend: Extract<Workspace['backend'], { kind: 'ssh' }>;
};

/** The SSH workspaces in a group with no project here, e.g. ones added from another device. */
export function sshWorkspacesWithoutProject(group: WorkspaceGroup): SshWorkspace[] {
  if (group.projectId || group.isDirectory) return [];
  return group.workspaces.filter((workspace): workspace is SshWorkspace =>
    isSshWorkspace(workspace)
  );
}

// Repositories being cloned, shared by a group's header button and its context menu.
let addingRemoteUrls: ReadonlySet<string> = new Set();
const addingListeners = new Set<() => void>();
function setAdding(remoteUrl: string, adding: boolean): void {
  const next = new Set(addingRemoteUrls);
  if (adding) next.add(remoteUrl);
  else next.delete(remoteUrl);
  addingRemoteUrls = next;
  for (const listener of addingListeners) listener();
}
function subscribeAdding(listener: () => void): () => void {
  addingListeners.add(listener);
  return () => addingListeners.delete(listener);
}

function useAddAsProject(workspace: SshWorkspace) {
  const createProjectFromRemote = useProjectsStore((s) => s.createProjectFromRemote);
  const addToast = useToastStore((s) => s.addToast);
  const remoteUrl = workspace.backend.gitUrl;
  const adding = useSyncExternalStore(subscribeAdding, () => addingRemoteUrls.has(remoteUrl));

  const add = async () => {
    if (addingRemoteUrls.has(remoteUrl)) return;
    setAdding(remoteUrl, true);
    try {
      // Main moves this repository's SSH workspaces into the new project.
      const project = await createProjectFromRemote({ remoteUrl });
      addToast(`Added ${project.name} as a project`, 'success');
    } catch (error) {
      addToast(`Couldn’t add ${remoteUrl} as a project: ${(error as Error).message}`, 'error');
    } finally {
      setAdding(remoteUrl, false);
    }
  };

  return { adding, add };
}

/** Clones the repository of SSH workspaces that have no project here, so they join it. */
export function AddSshRepositoryAsProjectButton({
  workspace,
  repoName,
}: {
  workspace: SshWorkspace;
  repoName: string;
}) {
  const { adding, add } = useAddAsProject(workspace);
  return (
    <IconButton
      size="xs"
      // Faint so it doesn't compete with the repository name.
      className="size-5 text-muted-foreground/50 hover:text-foreground"
      label={`Add ${repoName} as a project`}
      tooltipSide="right"
      disabled={adding}
      onClick={() => void add()}
    >
      {adding ? <Spinner size="sm" /> : <FolderPlus className="size-3.5" />}
    </IconButton>
  );
}

export function SshRepositoryGroupContextMenu({
  workspaces,
  children,
}: {
  workspaces: SshWorkspace[];
  children: React.ReactNode;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const addToast = useToastStore((s) => s.addToast);
  const { adding, add } = useAddAsProject(workspaces[0]);
  const gitProjects = projects.filter((project) => project.kind !== 'directory');

  const link = async (projectId: string, projectName: string) => {
    // A group by repository name can span hosts and clones; linking one moves its clone's.
    const clones = new Map(
      workspaces.map((workspace) => [
        `${workspace.backend.hostId}\0${workspace.backend.remoteRepoPath}`,
        workspace.id,
      ])
    );
    try {
      for (const workspaceId of clones.values()) {
        await window.api.linkSshWorkspaceToProject(workspaceId, projectId);
      }
    } catch (error) {
      addToast(`Couldn’t move to ${projectName}: ${(error as Error).message}`, 'error');
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={adding} onSelect={() => void add()}>
          <FolderPlus />
          Add as project
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={gitProjects.length === 0}>
            <Link />
            Link to project
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {gitProjects.map((project) => (
              <ContextMenuItem
                key={project.id}
                onSelect={() => void link(project.id, project.name)}
              >
                {project.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
