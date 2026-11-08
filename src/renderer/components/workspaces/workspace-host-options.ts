import { useMemo } from 'react';

import {
  getSshHostDisplayName,
  getWorkspaceHostId,
  LOCAL_WORKSPACE_HOST_ID,
} from '@/lib/workspace-host';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { SshHost, Workspace } from '@/types';

/** Local, then every SSH host: the configured ones, and any a workspace is on that the list lacks. */
export function getWorkspaceHostOptions(hosts: SshHost[], workspaces: Workspace[]) {
  const workspaceHostIds = new Set(workspaces.map(getWorkspaceHostId));
  const configuredHostIds = new Set(hosts.map((host) => host.id));
  const remoteOptions = hosts.map((host) => ({
    id: host.id,
    name: getSshHostDisplayName(host),
  }));

  for (const hostId of workspaceHostIds) {
    if (hostId !== LOCAL_WORKSPACE_HOST_ID && !configuredHostIds.has(hostId)) {
      remoteOptions.push({ id: hostId, name: 'Unknown SSH host' });
    }
  }

  return [{ id: LOCAL_WORKSPACE_HOST_ID, name: 'Local' }, ...remoteOptions];
}

export function useWorkspaceHostOptions() {
  const hosts = useSshHostsStore((state) => state.hosts);
  const workspaces = useWorkspacesStore((state) => state.workspaces);

  return useMemo(() => getWorkspaceHostOptions(hosts, workspaces), [hosts, workspaces]);
}
