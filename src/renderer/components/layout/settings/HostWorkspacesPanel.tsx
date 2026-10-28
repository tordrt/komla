import { Check } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import type { RemoteSshWorkspace, SshHost } from '@/types';

type ListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; workspaces: RemoteSshWorkspace[] }
  | { kind: 'failed'; message: string };

/** Workspaces on an SSH host, including ones started from other devices, ready to add here. */
export function HostWorkspacesPanel({ host }: { host: SshHost }) {
  const addToast = useToastStore((s) => s.addToast);
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const syncDisabledHostIds = useConfigStore((s) => s.config?.workspaceSyncDisabledHostIds);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const syncing = !syncDisabledHostIds?.includes(host.id);
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [addingId, setAddingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      // Syncing adds every workspace other devices started, so the list shows them here.
      if (syncing) await window.api.syncSshHostWorkspaces(host.id);
      setState({
        kind: 'loaded',
        workspaces: await window.api.listRemoteSshWorkspaces(host.id),
      });
    } catch (error) {
      setState({ kind: 'failed', message: (error as Error).message });
    }
  }, [host.id, syncing]);

  const setSyncing = (enabled: boolean) => {
    const others = (syncDisabledHostIds ?? []).filter((id) => id !== host.id);
    void updateConfig({ workspaceSyncDisabledHostIds: enabled ? others : [...others, host.id] });
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (workspace: RemoteSshWorkspace) => {
    setAddingId(workspace.workspaceId);
    try {
      await window.api.adoptRemoteSshWorkspace(host.id, workspace.workspaceId);
      await loadWorkspaces();
      addToast(`Added ${workspace.name}. Open it to pick up where you left off.`, 'success');
      setState((current) =>
        current.kind === 'loaded'
          ? {
              kind: 'loaded',
              workspaces: current.workspaces.map((item) =>
                item.workspaceId === workspace.workspaceId ? { ...item, adopted: true } : item
              ),
            }
          : current
      );
    } catch (error) {
      addToast(`Couldn’t add ${workspace.name}: ${(error as Error).message}`, 'error');
    } finally {
      setAddingId(null);
    }
  };

  return (
    <div className="rounded-lg border border-border/70 bg-background px-3 py-3">
      <div className="text-xs font-medium">Workspaces on {host.name}</div>
      <p className="mt-0.5 text-ui leading-relaxed text-muted-foreground">
        Includes workspaces started from your other devices. Adding one here reattaches to its
        running agents.
      </p>
      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={`sync-workspaces-${host.id}`} className="text-sm">
            Sync with other devices
          </label>
          <p className="text-ui leading-relaxed text-muted-foreground">
            Adds workspaces your other devices start on {host.name}, and carries over their new
            agent tabs, renames and moves to the Trash.
          </p>
        </div>
        <Switch id={`sync-workspaces-${host.id}`} checked={syncing} onCheckedChange={setSyncing} />
      </div>
      {state.kind === 'loading' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          Checking {host.name}…
        </div>
      )}
      {state.kind === 'failed' && (
        <Callout
          tone="error"
          size="sm"
          role="alert"
          className="mt-3"
          action={
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          Couldn’t reach {host.name}: {state.message}
        </Callout>
      )}
      {state.kind === 'loaded' && state.workspaces.length === 0 && (
        <div className="mt-3 text-xs text-muted-foreground">No workspaces on {host.name} yet.</div>
      )}
      {state.kind === 'loaded' && state.workspaces.length > 0 && (
        <ul className="mt-2 divide-y divide-border/60">
          {state.workspaces.map((workspace) => (
            <li
              key={workspace.workspaceId}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm">{workspace.name}</div>
                <div className="truncate text-ui text-muted-foreground">
                  {[workspace.repoName, workspace.branchName].filter(Boolean).join(' · ')}
                  {' · '}
                  {workspace.terminalCount} agent
                  {workspace.terminalCount === 1 ? '' : 's'}
                </div>
              </div>
              {workspace.adopted ? (
                <span className="flex shrink-0 items-center gap-1 text-ui text-muted-foreground">
                  <Check className="size-3.5" />
                  On this device
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={addingId !== null}
                  aria-label={`Add ${workspace.name} to this device`}
                  onClick={() => void add(workspace)}
                >
                  {addingId === workspace.workspaceId ? <Spinner size="sm" /> : 'Add here'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
