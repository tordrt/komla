import {
  ArrowClockwise,
  CaretDown,
  CaretUp,
  HardDrives,
  PencilSimple,
  Plus,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { tmuxUpgradeRecommended } from '@/components/ssh-hosts/ssh-host-draft';
import {
  SshHostStatusDot,
  sshHostStateLabel,
  useSshHostStatuses,
} from '@/components/ssh-hosts/ssh-host-status';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  lastUsedIntegrationTarget,
  sshHostIdFromTarget,
  type IntegrationTarget,
} from '@/lib/integration-target';
import { cn } from '@/lib/utils';
import { formatSshTarget } from '@/lib/workspace-host';
import { useConfigStore } from '@/stores/config.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useSshHostDialogStore } from '@/stores/ssh-host-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import {
  isSshWorkspace,
  normalizeSshBasePath,
  type RemoteSshWorkspace,
  type SshHost,
  type SshHostCapabilities,
  type SshHostStatus,
} from '@/types';

import { AgentIntegrationsPanel } from './AgentIntegrations';
import { FormError } from './FormError';
import { HostWorkspacesPanel } from './HostWorkspacesPanel';
import { SettingsCard } from './SettingsCard';

/** What the last check found missing or dated on a host; nothing when all is well. */
function hostWarnings(capabilities: SshHostCapabilities | undefined): string[] {
  if (!capabilities) return [];
  const warnings: string[] = [];
  if (capabilities.git.status !== 'available') warnings.push('Git missing');
  if (capabilities.tmux.status !== 'available') {
    warnings.push(`tmux ${capabilities.tmux.status}`);
  } else if (tmuxUpgradeRecommended(capabilities.tmux.version)) {
    warnings.push(`${capabilities.tmux.version}: 3.4 or later keeps long file links clickable`);
  }
  if (capabilities.monitoring?.status === 'missing') warnings.push('Utilities missing');
  if (
    capabilities.localMirror.platform === 'supported' &&
    (capabilities.localMirror.localRsync !== 'available' ||
      capabilities.localMirror.remoteRsync !== 'available')
  ) {
    warnings.push('Local copies need rsync');
  }
  return warnings;
}

export function SshTab() {
  const addToast = useToastStore((s) => s.addToast);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const hosts = useSshHostsStore((s) => s.hosts);
  const deleteHost = useSshHostsStore((s) => s.deleteHost);
  const loadConfig = useConfigStore((state) => state.loadConfig);
  const statuses = useSshHostStatuses();
  // The open integrations tab, starting on the SSH host the last workspace ran on.
  const [integrationTarget, setIntegrationTarget] = useState<IntegrationTarget | null>(() => {
    const target = lastUsedIntegrationTarget(workspaces);
    return sshHostIdFromTarget(target) ? target : null;
  });
  const [browsingHostId, setBrowsingHostId] = useState<string | null>(null);
  const [checkingHostIds, setCheckingHostIds] = useState<ReadonlySet<string>>(new Set());
  const [deleteHostId, setDeleteHostId] = useState<string | null>(null);
  const [deleteRemoteData, setDeleteRemoteData] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [otherDeviceWorkspaces, setOtherDeviceWorkspaces] = useState<RemoteSshWorkspace[]>([]);
  const [checkingOtherDevices, setCheckingOtherDevices] = useState(false);
  // Identifies the dialog a host check belongs to, so a late reply can't reach another one.
  const deleteCheckToken = useRef(0);
  const [deletingHost, setDeletingHost] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const selectedIntegrationHost =
    hosts.find((host) => host.id === sshHostIdFromTarget(integrationTarget)) ?? hosts[0];
  // Local Machine stays as picked; a missing or deleted host falls back to the first one.
  const shownIntegrationTarget: IntegrationTarget | undefined =
    integrationTarget && !sshHostIdFromTarget(integrationTarget)
      ? integrationTarget
      : selectedIntegrationHost && `ssh:${selectedIntegrationHost.id}`;
  const deleteHostTarget = hosts.find((host) => host.id === deleteHostId) ?? null;
  const workspaceCountOn = (hostId: string) =>
    workspaces.filter(
      (workspace) => isSshWorkspace(workspace) && workspace.backend.hostId === hostId
    ).length;
  const deleteHostWorkspaceCount = deleteHostId ? workspaceCountOn(deleteHostId) : 0;
  const selectedBasePath = normalizeSshBasePath(selectedIntegrationHost?.basePath ?? '~/.komla');

  // A first host's setup cut short, e.g. by quitting, picks up at its integrations step.
  const pendingHostId = hosts.find((host) => host.setupPending)?.id;
  useEffect(() => {
    if (pendingHostId && !useSshHostDialogStore.getState().open) {
      useSshHostDialogStore.getState().openReady(pendingHostId);
    }
  }, [pendingHostId]);

  // Attributed to where this visit to Settings started, such as Tips.
  const openAdd = () =>
    useSshHostDialogStore
      .getState()
      .openAdd(useSettingsDialogStore.getState().target.sshSetupSource ?? 'settings');

  const checkHost = async (hostId: string) => {
    setCheckingHostIds((current) => new Set(current).add(hostId));
    // Records whether the host answered.
    await window.api.checkSshHost(hostId).catch(() => {});
    setCheckingHostIds((current) => {
      const next = new Set(current);
      next.delete(hostId);
      return next;
    });
  };

  const startDeleteHost = (hostId: string) => {
    setDeleteHostId(hostId);
    setDeleteRemoteData(true);
    setOtherDeviceWorkspaces([]);
    setCheckingOtherDevices(true);
    setDeleteError(null);
    const token = ++deleteCheckToken.current;
    // Workspaces this device hasn't added may belong to the user's other devices.
    void window.api
      .listRemoteSshWorkspaces(hostId)
      .then((remote) => {
        if (deleteCheckToken.current !== token) return;
        const others = remote.filter((workspace) => workspace.mayBeOnOtherDevices);
        setOtherDeviceWorkspaces(others);
        if (others.length > 0) setDeleteRemoteData(false);
      })
      .catch(() => undefined)
      .finally(() => {
        if (deleteCheckToken.current === token) setCheckingOtherDevices(false);
      });
  };

  const closeDeleteHostDialog = () => {
    if (deletingHost) return;
    deleteCheckToken.current += 1;
    setCheckingOtherDevices(false);
    setDeleteHostId(null);
    setDeleteRemoteData(false);
  };

  const confirmDeleteHost = async () => {
    if (!deleteHostId) return;
    setDeletingHost(true);
    setDeleteError(null);
    try {
      const result = await deleteHost(deleteHostId, {
        deleteRemoteData,
      });
      // Host deletion clears the last-used environment and the launch pin from config.
      await Promise.all([loadWorkspaces(), loadConfig()]);
      setDeleteHostId(null);
      setDeleteRemoteData(false);
      const workspaceText =
        result.deletedWorkspaceIds.length === 1
          ? '1 workspace removed'
          : `${result.deletedWorkspaceIds.length} workspaces removed`;
      addToast(
        result.deletedWorkspaceIds.length > 0
          ? `SSH host deleted, ${workspaceText}`
          : 'SSH host deleted',
        'success'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete SSH host.';
      setDeleteError(
        message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') ||
          'Failed to delete SSH host.'
      );
    } finally {
      setDeletingHost(false);
    }
  };

  return (
    <div className="space-y-8">
      {hosts.length === 0 ? (
        <EmptyState
          icon={<HardDrives weight="duotone" />}
          title="Connect your first machine"
          description="Connect over SSH to run agents there, away from your own files and even while your laptop is closed."
          action={
            <Button size="sm" onClick={openAdd}>
              <Plus className="mr-1.5 size-3.5" />
              Add SSH host
            </Button>
          }
          className="rounded-lg border-2 border-dashed border-border/60"
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-medium text-muted-foreground">
              {hosts.length} host{hosts.length === 1 ? '' : 's'}
            </h3>
            <Button variant="outline" size="sm" onClick={openAdd}>
              <Plus className="mr-1.5 size-3.5" />
              Add SSH host
            </Button>
          </div>
          <SettingsCard>
            {hosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                status={statuses.get(host.id)}
                workspaceCount={workspaceCountOn(host.id)}
                isBrowsing={browsingHostId === host.id}
                isChecking={checkingHostIds.has(host.id)}
                labelSuffix={hosts.length === 1 ? null : host.name}
                onBrowse={() => setBrowsingHostId(browsingHostId === host.id ? null : host.id)}
                onCheck={() => void checkHost(host.id)}
                onEdit={() => useSshHostDialogStore.getState().openEdit(host.id)}
                onDelete={() => startDeleteHost(host.id)}
              />
            ))}
          </SettingsCard>
        </div>
      )}

      {selectedIntegrationHost && (
        <>
          <AgentIntegrationsPanel
            target={shownIntegrationTarget}
            onTargetChange={(target) => {
              setIntegrationTarget(target);
              if (sshHostIdFromTarget(target)) setShowDiagnostics(false);
            }}
          />

          <SettingsCard
            title="Advanced diagnostics"
            description="Inspect Komla's remote layout and companion behavior."
          >
            <div className="space-y-4">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                aria-expanded={showDiagnostics}
                onClick={() => setShowDiagnostics((current) => !current)}
              >
                <div>
                  <div className="text-sm font-medium">Remote Companion details</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Managed paths, lifecycle, and agent event delivery.
                  </div>
                </div>
                {showDiagnostics ? (
                  <CaretUp className="size-4 text-muted-foreground" />
                ) : (
                  <CaretDown className="size-4 text-muted-foreground" />
                )}
              </button>

              {showDiagnostics && (
                <div className="space-y-5 border-t border-border/70 pt-4 text-xs leading-relaxed text-muted-foreground">
                  <div className="space-y-2">
                    <div className="font-medium text-foreground">Remote layout</div>
                    <div className="space-y-1 font-mono">
                      <div>{selectedBasePath}/repos/&lt;repo&gt;.git</div>
                      <div>{selectedBasePath}/worktrees/&lt;repo&gt;/&lt;branch&gt;</div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="font-medium text-foreground">Remote Companion</div>
                    <p>
                      Komla automatically deploys a temporary user-level process that observes
                      managed workspaces with native filesystem events and exits after their
                      terminal sessions end.
                    </p>
                    <p>
                      Workspace status and agent lifecycle events travel through the authenticated
                      SSH reverse tunnel to Komla on this computer. They do not contact an Internet
                      service.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <div className="font-medium text-foreground">Agent integrations</div>
                    <p>
                      Enabling an integration adds marked Komla entries to the agent&apos;s
                      configuration. Disabling it removes only those Komla-managed entries.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </SettingsCard>
        </>
      )}

      {hosts.length > 0 && (
        <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          SSH hosts require Linux or macOS, a POSIX shell, Git, tmux, and standard Unix tools. rsync
          is required for local mode.
        </div>
      )}

      <Dialog open={deleteHostTarget !== null} onOpenChange={closeDeleteHostDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete SSH Host</DialogTitle>
            <DialogDescription>
              {deleteHostWorkspaceCount > 0
                ? `Delete "${deleteHostTarget?.name}" and remove ${deleteHostWorkspaceCount} associated workspace${deleteHostWorkspaceCount === 1 ? '' : 's'} from Komla?`
                : `Delete "${deleteHostTarget?.name}"?`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-4 py-2">
            <div className="space-y-1">
              <label htmlFor="delete-remote-data" className="block text-sm">
                Delete all Komla data from this host
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Deletes {normalizeSshBasePath(deleteHostTarget?.basePath ?? '~/.komla')}, remote
                worktrees and repo caches, and Komla-managed agent integrations. Uncommitted work
                will be lost.
              </p>
            </div>
            <Switch
              id="delete-remote-data"
              checked={deleteRemoteData}
              onCheckedChange={setDeleteRemoteData}
            />
          </div>
          {otherDeviceWorkspaces.length > 0 && (
            <Callout tone="warning" className="leading-relaxed">
              {otherDeviceWorkspaces.length === 1
                ? '1 workspace on this host may be in use on another device'
                : `${otherDeviceWorkspaces.length} workspaces on this host may be in use on another device`}
              : {otherDeviceWorkspaces.map((workspace) => workspace.name).join(', ')}. Deleting all
              Komla data also deletes them and stops their agents.
            </Callout>
          )}
          {deleteRemoteData && checkingOtherDevices && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner size="sm" />
              Checking whether other devices have workspaces on this host…
            </p>
          )}
          {deleteError && <FormError message={deleteError} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeDeleteHostDialog} disabled={deletingHost}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDeleteHost()}
              disabled={deletingHost || (deleteRemoteData && checkingOtherDevices)}
            >
              {deletingHost ? (
                <>
                  <Spinner size="sm" className="mr-1.5" />
                  Deleting
                </>
              ) : (
                'Delete Host'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface HostRowProps {
  host: SshHost;
  status: SshHostStatus | undefined;
  workspaceCount: number;
  isBrowsing: boolean;
  isChecking: boolean;
  /** Names the host in button labels when there is more than one. */
  labelSuffix: string | null;
  onBrowse: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function HostRow({
  host,
  status,
  workspaceCount,
  isBrowsing,
  isChecking,
  labelSuffix,
  onBrowse,
  onCheck,
  onEdit,
  onDelete,
}: HostRowProps) {
  return (
    <div className="space-y-3 py-3!">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-muted-foreground"
        >
          <HardDrives className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{host.name}</span>
            <span
              className={cn(
                'flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground',
                status?.state === 'unreachable' && 'text-error'
              )}
            >
              <SshHostStatusDot status={status} />
              {sshHostStateLabel(status)}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{formatSshTarget(host)}</span>
            <span className="mx-1.5 text-muted-foreground/50">·</span>
            <span>
              {workspaceCount} workspace{workspaceCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={isBrowsing ? 'secondary' : 'ghost'}
            size="sm"
            aria-label={`Workspaces on ${host.name}`}
            aria-expanded={isBrowsing}
            onClick={onBrowse}
          >
            Workspaces
          </Button>
          <HostActions
            labelSuffix={labelSuffix}
            isChecking={isChecking}
            onCheck={onCheck}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </div>
      <HostNotes host={host} status={status} />
      {isBrowsing && <HostWorkspacesPanel host={host} />}
    </div>
  );
}

function HostActions({
  labelSuffix,
  isChecking,
  onCheck,
  onEdit,
  onDelete,
}: Pick<HostRowProps, 'labelSuffix' | 'isChecking' | 'onCheck' | 'onEdit' | 'onDelete'>) {
  const labels = labelSuffix
    ? {
        check: `Check ${labelSuffix}`,
        edit: `Edit ${labelSuffix} SSH host`,
        remove: `Delete ${labelSuffix} host`,
      }
    : { check: 'Check connection', edit: 'Edit SSH host', remove: 'Delete host' };
  return (
    <>
      <IconButton label={labels.check} size="md" disabled={isChecking} onClick={onCheck}>
        {isChecking ? <Spinner size="sm" /> : <ArrowClockwise className="size-4" />}
      </IconButton>
      <IconButton label={labels.edit} size="md" onClick={onEdit}>
        <PencilSimple className="size-4" />
      </IconButton>
      <IconButton
        label={labels.remove}
        size="md"
        className="hover:text-destructive"
        onClick={onDelete}
      >
        <Trash className="size-4" />
      </IconButton>
    </>
  );
}

/** Why the host didn't answer, and what its last check found missing. */
function HostNotes({ host, status }: { host: SshHost; status: SshHostStatus | undefined }) {
  const error = status?.state === 'unreachable' ? status.message : undefined;
  const warnings = hostWarnings(host.capabilities);
  if (!error && warnings.length === 0) return null;
  return (
    <div className="space-y-1 pl-11 text-xs leading-relaxed">
      {error && <p className="break-words text-error">{error}</p>}
      {warnings.length > 0 && (
        <p className="flex items-start gap-1.5 text-warning">
          <Warning className="mt-0.5 size-3.5 shrink-0" />
          {warnings.join(' · ')}
        </p>
      )}
    </div>
  );
}
