import { useMemo } from 'react';

import { useWorkspacesExceptTitles } from '@/lib/workspace-except-titles';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { isSshWorkspace } from '../../shared/types';

/**
 * The SSH hosts where a project has workspaces, and the selected one, with their names. With
 * `activeOnly`, workspaces in the Trash or still being made don't count.
 */
export function useProjectSshHosts(
  projectId: string,
  hostId: string | null,
  { activeOnly = false }: { activeOnly?: boolean } = {}
) {
  // It reads no titles, so an agent's spinner doesn't re-render it.
  const workspaces = useWorkspacesStore(useWorkspacesExceptTitles((s) => s.workspaces));
  const hosts = useSshHostsStore((s) => s.hosts);
  return useMemo(() => {
    const hostIds = new Set(
      workspaces.flatMap((workspace) =>
        workspace.projectId === projectId &&
        isSshWorkspace(workspace) &&
        (!activeOnly || (workspace.status === 'active' && !workspace.provisioning))
          ? [workspace.backend.hostId]
          : []
      )
    );
    if (hostId) hostIds.add(hostId);
    return [...hostIds].map((id) => ({
      id,
      name: hosts.find((host) => host.id === id)?.name ?? id,
    }));
  }, [workspaces, hosts, projectId, hostId, activeOnly]);
}
