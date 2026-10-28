import { Cloud, DesktopTower, Funnel } from '@phosphor-icons/react';
import { useMemo } from 'react';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import {
  getSshHostDisplayName,
  getWorkspaceHostId,
  LOCAL_WORKSPACE_HOST_ID,
} from '@/lib/workspace-host';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { SshHost, Workspace } from '@/types';

type WorkspaceHostFilterScope = 'sidebar' | 'dashboard';

export function WorkspaceHostFilterMenu({
  scope = 'sidebar',
}: {
  scope?: WorkspaceHostFilterScope;
}) {
  const hiddenWorkspaceHostIds = useWorkspacesStore((state) =>
    scope === 'dashboard' ? state.dashboardHiddenWorkspaceHostIds : state.hiddenWorkspaceHostIds
  );
  const options = useWorkspaceHostOptions();
  const hiddenCount = options.filter((option) => hiddenWorkspaceHostIds.has(option.id)).length;

  if (options.length <= 1) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={
            hiddenCount > 0
              ? `Filter workspaces by host (${hiddenCount} host${hiddenCount === 1 ? '' : 's'} hidden)`
              : 'Filter workspaces by host'
          }
          className={cn(hiddenCount > 0 && 'text-foreground')}
        >
          <Funnel className="size-3.5" weight={hiddenCount > 0 ? 'fill' : 'regular'} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <WorkspaceHostFilterItems scope={scope} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

function WorkspaceHostFilterItems({ scope = 'sidebar' }: { scope?: WorkspaceHostFilterScope }) {
  const options = useWorkspaceHostOptions();
  const hiddenWorkspaceHostIds = useWorkspacesStore((state) =>
    scope === 'dashboard' ? state.dashboardHiddenWorkspaceHostIds : state.hiddenWorkspaceHostIds
  );
  const toggleWorkspaceHostVisibility = useWorkspacesStore((state) =>
    scope === 'dashboard'
      ? state.toggleDashboardWorkspaceHostVisibility
      : state.toggleWorkspaceHostVisibility
  );
  const showAllWorkspaceHosts = useWorkspacesStore((state) =>
    scope === 'dashboard' ? state.showAllDashboardWorkspaceHosts : state.showAllWorkspaceHosts
  );
  const hiddenCount = options.filter((option) => hiddenWorkspaceHostIds.has(option.id)).length;

  return (
    <>
      {options.map((option) => (
        <DropdownMenuCheckboxItem
          key={option.id}
          checked={!hiddenWorkspaceHostIds.has(option.id)}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={() => toggleWorkspaceHostVisibility(option.id)}
        >
          {option.id === LOCAL_WORKSPACE_HOST_ID ? <DesktopTower /> : <Cloud />}
          <span className="truncate">{option.name}</span>
        </DropdownMenuCheckboxItem>
      ))}
      {hiddenCount > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={showAllWorkspaceHosts}>Show all hosts</DropdownMenuItem>
        </>
      )}
    </>
  );
}
