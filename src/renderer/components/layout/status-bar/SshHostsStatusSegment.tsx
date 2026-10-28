import { Cloud, CloudSlash, GearSix, Plus } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import {
  SshHostStatusDot,
  sshHostStatusDetail,
  useSshHostStatuses,
} from '@/components/ssh-hosts/ssh-host-status';
import { Button } from '@/components/ui/button';
import { menuItemClass } from '@/components/ui/menu-styles';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AgentStateIcon,
  workspaceAgentState,
  workspaceAgents,
} from '@/components/workspaces/agent-state';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { cn } from '@/lib/utils';
import { useDevServerPreviewStore } from '@/stores/dev-server-preview.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import {
  isSshWorkspace,
  runningTerminalCount,
  showsRunning,
  type SshForwardedPort,
  type SshHost,
  type SshHostStatus,
  type Workspace,
} from '@/types';

import { StatusBarButton } from './StatusBarButton';
import { StatusBarWorkspaceRow, workspaceLabel } from './StatusBarWorkspaceRow';

// Enough to see what runs on a host without the popover outgrowing the window.
const RUNNING_ROWS_SHOWN = 8;

/**
 * The ports forwarded for each host, read when the popover opens and again on `reread`.
 * `forget` drops a list read earlier, which may hold tunnels since stopped.
 */
function useForwardedPorts(open: boolean): {
  ports: SshForwardedPort[];
  reread: () => void;
  forget: () => void;
} {
  const [ports, setPorts] = useState<SshForwardedPort[]>([]);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.api
      .listSshForwardedPorts()
      .then((next) => {
        if (!cancelled) setPorts(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, reads]);
  return {
    ports,
    reread: () => setReads((count) => count + 1),
    forget: () => setPorts([]),
  };
}

type StopForwardedPort = (port: SshForwardedPort) => Promise<void>;

/**
 * How Stop closes the tunnels Komla opened for links, browser tabs and desktops. Saved
 * forwards and Komla's own tunnel have none: the first are turned off in Settings, and Komla
 * needs the second.
 */
const STOP_FORWARDED_PORT: Partial<Record<SshForwardedPort['kind'], StopForwardedPort>> = {
  link: async ({ workspaceId, id }) => {
    if (workspaceId) await window.api.stopSshLinkForward(workspaceId, id);
  },
  // Through the store, so the tab on screen shows its tunnel stopped. A tab out of sight
  // forwards again when it's shown.
  'browser-tab': async ({ workspaceId, tabId }) => {
    if (workspaceId) {
      await useDevServerPreviewStore
        .getState()
        .stopSshPreviewForward(workspaceId, { tabId, keepStopped: true });
    }
  },
  desktop: ({ hostId, remotePort }) => window.api.stopSshDesktopForward(hostId, remotePort),
};

/**
 * The Stop of `port` in this window. A browser tab's tunnel stops only in the window showing
 * the tab, whose browser then shows it stopped.
 */
function stopIn(
  windowId: string,
  port: SshForwardedPort,
  workspace: Workspace | undefined
): StopForwardedPort | undefined {
  const elsewhere = workspace?.windowId != null && workspace.windowId !== windowId;
  return port.kind === 'browser-tab' && elsewhere ? undefined : STOP_FORWARDED_PORT[port.kind];
}

function forwardedPortLabel(port: SshForwardedPort, workspace: Workspace | undefined): string {
  const owner = workspace ? ` · ${workspaceLabel(workspace)}` : '';
  const state = port.state && port.state !== 'connected' ? ` · ${port.state}` : '';
  switch (port.kind) {
    case 'link':
      return `Link${owner}${state}`;
    case 'browser-tab':
      return `Browser tab${owner}${state}`;
    case 'desktop':
      // A desktop's VNC server listens on 5900 plus its display number.
      return port.remotePort > 5900 ? `Desktop :${port.remotePort - 5900}` : 'Desktop';
    case 'saved':
      return `${port.name ?? 'Saved'}${state}`;
    case 'komla':
      return 'Komla · notifications and data';
  }
}

function ForwardedPortRow({
  port,
  host,
  workspace,
  stopPort,
  onStopped,
  onEdit,
}: {
  port: SshForwardedPort;
  host: SshHost;
  workspace: Workspace | undefined;
  /** None for a tunnel this window can't stop. */
  stopPort: StopForwardedPort | undefined;
  onStopped: () => void;
  onEdit: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const stop = async (stopPort: StopForwardedPort) => {
    setStopping(true);
    try {
      await stopPort(port);
    } catch (error) {
      useToastStore
        .getState()
        .addToast(
          `Couldn't stop forwarding port ${port.remotePort}: ${ipcErrorMessage(error)}`,
          'error'
        );
    }
    setStopping(false);
    onStopped();
  };
  const here = `localhost:${port.localPort}`;
  const [route, title] =
    port.direction === 'remote-to-local'
      ? [`${port.remotePort} → ${here}`, `Port ${port.remotePort} on ${host.name}, at ${here} here`]
      : [
          `${here} → ${port.remotePort}`,
          `${here} here, at port ${port.remotePort} on ${host.name}`,
        ];

  return (
    <li className="flex items-center gap-2 px-2 py-1" title={title}>
      <span className="min-w-0 flex-1">
        <span className="block truncate tabular-nums">{route}</span>
        <span
          className={cn(
            'block truncate text-muted-foreground',
            port.state === 'error' && 'text-error'
          )}
        >
          {forwardedPortLabel(port, workspace)}
        </span>
      </span>
      {stopPort ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-5 shrink-0 px-1.5 text-2xs"
          disabled={stopping}
          onClick={() => void stop(stopPort)}
          aria-label={`Stop forwarding port ${port.remotePort}`}
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </Button>
      ) : (
        port.kind === 'saved' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 shrink-0 px-1.5 text-2xs"
            onClick={onEdit}
            aria-label={`Edit ${port.name ?? 'saved forward'}`}
          >
            Edit
          </Button>
        )
      )}
    </li>
  );
}

function ForwardedPortList({
  host,
  ports,
  workspaces,
  onStopped,
  onEdit,
}: {
  host: SshHost;
  ports: SshForwardedPort[];
  workspaces: Workspace[];
  onStopped: () => void;
  onEdit: () => void;
}) {
  const windowId = useWindowStore((s) => s.windowId);
  if (ports.length === 0) return null;
  return (
    <>
      <div className="mt-2 ml-3.5 text-2xs tracking-wide text-muted-foreground uppercase">
        Forwarded ports
      </div>
      <ul aria-label={`Ports forwarded for ${host.name}`} className="ml-1.5 text-ui">
        {ports.map((port) => {
          const workspace = workspaces.find((candidate) => candidate.id === port.workspaceId);
          return (
            <ForwardedPortRow
              key={port.id}
              port={port}
              host={host}
              workspace={workspace}
              stopPort={stopIn(windowId, port, workspace)}
              onStopped={onStopped}
              onEdit={onEdit}
            />
          );
        })}
      </ul>
    </>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Workspaces with a terminal running on the host: attached here, detached, or another device's. */
function runningOn(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((workspace) => showsRunning(workspace));
}

function HostRow({
  host,
  status,
  workspaces,
  ports,
  onOpenWorkspace,
  onPortStopped,
  onEditHost,
}: {
  host: SshHost;
  status: SshHostStatus | undefined;
  /** The host's active workspaces. */
  workspaces: Workspace[];
  ports: SshForwardedPort[];
  onOpenWorkspace: () => void;
  onPortStopped: () => void;
  onEditHost: (hostId: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    // Records whether the host answered.
    await window.api.checkSshHost(host.id).catch(() => {});
    setChecking(false);
  };
  const detail = sshHostStatusDetail(status);
  const running = runningOn(workspaces);
  const agents = running.flatMap(workspaceAgents);
  const needInput = agents.filter(({ state }) => state === 'input').length;
  const working = agents.filter(({ state }) => state === 'working').length;
  const counts = [
    `${running.length} of ${plural(workspaces.length, 'workspace', 'workspaces')} active`,
    needInput > 0 && `${needInput} ${needInput === 1 ? 'needs' : 'need'} input`,
    working > 0 && `${working} working`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="px-2 py-1.5">
      <div className="flex items-start gap-2.5">
        <SshHostStatusDot status={status} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-[18px] font-medium">{host.name}</div>
          <div
            className={cn(
              'line-clamp-2 text-ui break-words text-muted-foreground',
              status?.state === 'unreachable' && 'text-error'
            )}
            title={detail}
          >
            {detail}
          </div>
          {workspaces.length > 0 && (
            <div className="text-ui text-muted-foreground tabular-nums">{counts}</div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-1 h-6 shrink-0 px-2 text-2xs text-muted-foreground hover:text-foreground"
          disabled={checking}
          onClick={() => void check()}
          aria-label={`Check ${host.name}`}
        >
          {checking ? 'Checking…' : 'Check'}
        </Button>
      </div>
      {running.length > 0 && (
        <ul aria-label={`Active on ${host.name}`} className="mt-1 ml-1.5">
          {running.slice(0, RUNNING_ROWS_SHOWN).map((workspace) => {
            // A finished agent's workspace reads as active, as the counts above have it.
            const agentState = workspaceAgentState(workspace);
            const state = agentState === 'done' ? null : agentState;
            const terminals = runningTerminalCount(workspace);
            return (
              <StatusBarWorkspaceRow
                key={workspace.id}
                workspace={workspace}
                leading={
                  state ? (
                    <AgentStateIcon state={state} />
                  ) : (
                    <span className="flex size-3 shrink-0 items-center justify-center">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-success/70" />
                    </span>
                  )
                }
                trailing={plural(terminals, 'session', 'sessions')}
                onOpen={onOpenWorkspace}
              />
            );
          })}
          {running.length > RUNNING_ROWS_SHOWN && (
            <li className="px-2 py-0.5 text-ui text-muted-foreground">
              {running.length - RUNNING_ROWS_SHOWN} more active
            </li>
          )}
        </ul>
      )}
      <ForwardedPortList
        host={host}
        ports={ports}
        workspaces={workspaces}
        onStopped={onPortStopped}
        onEdit={() => onEditHost(host.id)}
      />
    </li>
  );
}

/** What Komla last saw on each SSH host, and what runs there. Hidden until a host is set up. */
export function SshHostsStatusSegment() {
  const [open, setOpen] = useState(false);
  const hosts = useSshHostsStore((s) => s.hosts);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const statuses = useSshHostStatuses();
  const { ports, reread: rereadPorts, forget: forgetPorts } = useForwardedPorts(open);
  if (hosts.length === 0) return null;

  const stateOf = (host: SshHost) => statuses.get(host.id)?.state;
  const unreachable = hosts.filter((host) => stateOf(host) === 'unreachable').length;
  const connected = hosts.filter((host) => stateOf(host) === 'connected').length;
  const unchecked = hosts.length - unreachable - connected;
  const workspacesOn = (host: SshHost) =>
    workspaces.filter(
      (workspace) =>
        workspace.status === 'active' &&
        isSshWorkspace(workspace) &&
        workspace.backend.hostId === host.id
    );
  const running = hosts.reduce((count, host) => count + runningOn(workspacesOn(host)).length, 0);
  const openSshSettings = () => {
    setOpen(false);
    useSettingsDialogStore.getState().openSettings({ tab: 'ssh' });
  };
  const openEdit = (hostId: string) => {
    setOpen(false);
    useSshHostDialogStore.getState().openEdit(hostId);
  };
  const openAdd = () => {
    setOpen(false);
    useSshHostDialogStore.getState().openAdd('settings');
  };
  const states = [
    connected > 0 && `${connected} connected`,
    unreachable > 0 && `${unreachable} unreachable`,
    unchecked > 0 && `${unchecked} not checked`,
  ].filter(Boolean);
  const summary = [...states, running > 0 && `${running} active`].filter(Boolean).join(', ');

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Rows from an earlier opening may be tunnels since stopped.
        if (next) forgetPorts();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <StatusBarButton
          aria-label={`SSH hosts: ${summary}`}
          tooltip={`SSH hosts: ${summary}`}
          className={cn(unreachable > 0 && 'text-error hover:text-error')}
        >
          {unreachable > 0 ? (
            <CloudSlash aria-hidden="true" className="size-3.5" />
          ) : (
            <Cloud aria-hidden="true" className="size-3.5" />
          )}
          <span className="max-w-40 truncate @max-3xl:hidden">
            {unreachable > 0
              ? `${unreachable} unreachable`
              : hosts.length === 1
                ? hosts[0].name
                : plural(hosts.length, 'host', 'hosts')}
          </span>
          {unreachable === 0 && connected > 0 && (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          )}
        </StatusBarButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-0 text-xs">
        <div className="flex items-center justify-between gap-3 border-b border-foreground/10 px-3 py-2">
          <h2 className="text-[13px] font-semibold">SSH hosts</h2>
          <span className="truncate text-ui text-muted-foreground">{states.join(' · ')}</span>
        </div>
        <ul className="max-h-[60vh] divide-y divide-foreground/10 overflow-x-hidden overflow-y-auto px-1">
          {hosts.map((host) => (
            <HostRow
              key={host.id}
              host={host}
              status={statuses.get(host.id)}
              workspaces={workspacesOn(host)}
              ports={ports.filter((port) => port.hostId === host.id)}
              onOpenWorkspace={() => setOpen(false)}
              onPortStopped={rereadPorts}
              onEditHost={openEdit}
            />
          ))}
        </ul>
        <div className="border-t border-foreground/10 p-1">
          <button
            type="button"
            className={cn(menuItemClass, 'w-full hover:bg-foreground/8')}
            onClick={openAdd}
          >
            <Plus />
            Add SSH host…
          </button>
          <button
            type="button"
            className={cn(menuItemClass, 'w-full hover:bg-foreground/8')}
            onClick={openSshSettings}
          >
            <GearSix />
            Manage SSH hosts…
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
