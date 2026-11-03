import { useProjectsStore } from '@/stores/projects.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

/** The open workspace's project, with its name for menus. */
export function useOpenProject(): { id: string; name: string } | null {
  const projectId = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.projectId ?? null
  );
  const name = useProjectsStore((s) => s.projects.find((p) => p.id === projectId)?.name);
  return projectId && name ? { id: projectId, name } : null;
}

/** A workspace's project id. */
export function useWorkspaceProjectId(workspaceId: string): string | null {
  return useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.projectId ?? null
  );
}
