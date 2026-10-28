import { CalendarDots, PencilSimple, Play, Plus, Trash, Warning } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { describeSchedule, formatRunTime } from '@/lib/automation-schedule-draft';
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from '@/lib/automation-templates';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useAutomationsStore } from '@/stores/automations.store';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { nextAutomationOccurrence } from '../../../../shared/lib/automation-schedule';

import { AutomationEditorDialog } from './AutomationEditorDialog';
import { SettingsCard } from './SettingsCard';

import type {
  Automation,
  AutomationRun,
  AutomationTarget,
  AutomationTargetSnapshot,
  SaveAutomationParams,
} from '../../../../shared/types/automation';

/** Electron wraps main-process errors as "Error invoking remote method '<channel>': Error: <message>". */
function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

interface AutomationsTabProps {
  onClose: () => void;
}

type Editing = { automation: Automation | null; template?: AutomationTemplate };

export function AutomationsTab({ onClose }: AutomationsTabProps) {
  const {
    snapshots,
    hasLoaded,
    loadAutomations,
    saveAutomation,
    setAutomationEnabled,
    deleteAutomation,
    runAutomationNow,
  } = useAutomationsStore();
  const projects = useProjectsStore((state) => state.projects);
  const { presets, activePresets, loadPresets } = useAgentPresetsStore();
  const defaultLaunchModeId = useConfigStore((state) => state.config?.defaultLaunchModeId);
  const { hosts, loadHosts } = useSshHostsStore();
  const addToast = useToastStore((state) => state.addToast);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const selectWorkspace = useWorkspacesStore((state) => state.selectWorkspace);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  // The app lists automations again on every change; this reads every SSH host on open.
  useEffect(() => {
    void loadAutomations();
    void loadPresets();
    void loadHosts();
  }, [loadAutomations, loadPresets, loadHosts]);

  const readyHosts = useMemo(() => hosts.filter((host) => !host.setupPending), [hosts]);
  const hostName = (hostId: string) =>
    hosts.find((host) => host.id === hostId)?.name ?? 'Removed SSH host';
  const workspaceIds = useMemo(
    () => new Set(workspaces.map((workspace) => workspace.id)),
    [workspaces]
  );
  const automationCount = snapshots.reduce(
    (count, snapshot) => count + snapshot.automations.length,
    0
  );
  const stillLoading = !hasLoaded || snapshots.some((snapshot) => snapshot.loading);

  const withBusy = async (id: string, work: () => Promise<void>) => {
    setBusyIds((current) => new Set(current).add(id));
    try {
      await work();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const handleSave = async (params: SaveAutomationParams) => {
    setIsSaving(true);
    try {
      await saveAutomation(params);
      addToast(params.id ? 'Automation saved' : 'Automation created', 'success');
      setEditing(null);
    } catch (error) {
      addToast(ipcErrorMessage(error), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggle = (automation: Automation, enabled: boolean) =>
    withBusy(automation.id, async () => {
      try {
        await setAutomationEnabled(automation.target, automation.id, enabled);
      } catch (error) {
        addToast(ipcErrorMessage(error), 'error');
      }
    });

  const handleRunNow = (automation: Automation) =>
    withBusy(automation.id, async () => {
      try {
        const run = await runAutomationNow(automation.target, automation.id);
        if (run.status === 'started') {
          addToast(`${automation.name} started`, 'success');
        } else {
          addToast(run.message ?? `${automation.name} didn’t start`, 'error');
        }
      } catch (error) {
        addToast(ipcErrorMessage(error), 'error');
      }
    });

  const handleDelete = async () => {
    if (!deleting) return;
    setIsSaving(true);
    try {
      await deleteAutomation(deleting.target, deleting.id);
      addToast('Automation deleted', 'success');
      if (editing?.automation?.id === deleting.id) setEditing(null);
      setDeleting(null);
    } catch (error) {
      addToast(ipcErrorMessage(error), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const openWorkspace = (workspaceId: string) => {
    void selectWorkspace(workspaceId);
    onClose();
  };

  const defaultTarget: AutomationTarget = readyHosts[0]
    ? { kind: 'ssh', hostId: readyHosts[0].id }
    : { kind: 'local' };

  const deleteDialog = (
    <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Warning className="size-4 text-destructive" />
            Delete automation
          </DialogTitle>
          <DialogDescription>
            Delete “{deleting?.name}” and its run history? Workspaces it already started stay.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(null)} disabled={isSaving}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={isSaving}>
            {isSaving ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Deleted elsewhere (another device, the host) while the editor was open.
  const editingMissing =
    !!editing?.automation &&
    !snapshots.some((snapshot) =>
      snapshot.automations.some((candidate) => candidate.id === editing.automation?.id)
    );

  const visibleSnapshots = snapshots.filter((snapshot) => snapshot.automations.length > 0);
  // A target that couldn't be read may still have automations nobody here has seen yet.
  const unreadTargets = snapshots.filter(
    (snapshot) => snapshot.error && snapshot.automations.length === 0
  );

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
            {automationCount} automation{automationCount !== 1 ? 's' : ''}
            {stillLoading && <Spinner className="size-3" />}
          </h3>
          {automationCount > 0 && (
            <Button variant="outline" size="sm" onClick={() => setEditing({ automation: null })}>
              <Plus className="mr-1.5 size-3.5" />
              New automation
            </Button>
          )}
        </div>

        {unreadTargets.map((snapshot) =>
          snapshot.target.kind === 'ssh' ? (
            <Callout key={snapshot.target.hostId} tone="warning" size="sm">
              Couldn’t read automations on {hostName(snapshot.target.hostId)}: {snapshot.error}
            </Callout>
          ) : (
            <Callout key="local" tone="warning" size="sm">
              {snapshot.error}
            </Callout>
          )
        )}

        {automationCount === 0 ? (
          <EmptyState
            className="rounded-lg border-2 border-dashed border-border/60"
            icon={<CalendarDots weight="duotone" />}
            title={stillLoading ? 'Looking for automations…' : 'No automations yet'}
            description="Start an agent with the same prompt on a schedule, like a nightly dependency check or a morning triage of new issues. An SSH host runs them even while this computer is off."
            action={
              <Button size="sm" onClick={() => setEditing({ automation: null })}>
                <Plus className="mr-1.5 size-3.5" />
                New automation
              </Button>
            }
          />
        ) : (
          visibleSnapshots.map((snapshot) => (
            <TargetCard
              key={snapshot.target.kind === 'local' ? 'local' : snapshot.target.hostId}
              snapshot={snapshot}
              title={
                snapshot.target.kind === 'local'
                  ? 'This computer'
                  : hostName(snapshot.target.hostId)
              }
              projects={projects}
              workspaceIds={workspaceIds}
              busyIds={busyIds}
              onToggle={(automation, enabled) => void handleToggle(automation, enabled)}
              onRunNow={(automation) => void handleRunNow(automation)}
              onEdit={(automation) => setEditing({ automation })}
              onDelete={setDeleting}
              onOpenWorkspace={openWorkspace}
            />
          ))
        )}

        <TemplateList onSelect={(template) => setEditing({ automation: null, template })} />
      </div>
      {editing && !editingMissing && (
        <AutomationEditorDialog
          key={editing.automation?.id ?? editing.template?.id ?? 'new'}
          automation={editing.automation}
          template={editing.template}
          projects={projects}
          presets={presets}
          activePresets={activePresets}
          defaultLaunchModeId={defaultLaunchModeId}
          hosts={readyHosts}
          defaultTarget={defaultTarget}
          isSaving={isSaving}
          onClose={() => setEditing(null)}
          onSave={(params) => void handleSave(params)}
          onRequestDelete={editing.automation ? () => setDeleting(editing.automation) : undefined}
        />
      )}
      {deleteDialog}
    </>
  );
}

function TemplateList({ onSelect }: { onSelect: (template: AutomationTemplate) => void }) {
  return (
    <SettingsCard
      title="Start from a template"
      description="Opens in the editor, where you choose the project and agent and adjust the prompt."
    >
      {AUTOMATION_TEMPLATES.map((template) => (
        <button
          key={template.id}
          type="button"
          onClick={() => onSelect(template)}
          className="flex w-full items-center gap-4 !py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-hidden"
        >
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-sm font-medium">{template.label}</span>
            <span className="block text-xs text-muted-foreground">{template.description}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {describeSchedule(template.cron)}
          </span>
        </button>
      ))}
    </SettingsCard>
  );
}

interface TargetCardProps {
  snapshot: AutomationTargetSnapshot;
  title: string;
  projects: { id: string; name: string }[];
  workspaceIds: ReadonlySet<string>;
  busyIds: ReadonlySet<string>;
  onToggle: (automation: Automation, enabled: boolean) => void;
  onRunNow: (automation: Automation) => void;
  onEdit: (automation: Automation) => void;
  onDelete: (automation: Automation) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}

function TargetCard({
  snapshot,
  title,
  projects,
  workspaceIds,
  busyIds,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onOpenWorkspace,
}: TargetCardProps) {
  const isLocal = snapshot.target.kind === 'local';
  return (
    <SettingsCard
      title={title}
      action={snapshot.loading ? <Spinner className="size-3" /> : undefined}
      description={
        isLocal
          ? 'Runs while Komla is open and this computer is awake.'
          : 'This host’s cron starts these runs, even while this computer is off.'
      }
    >
      {(!snapshot.scheduler.available || snapshot.error) && (
        <div className="space-y-2">
          {!snapshot.scheduler.available && (
            <Callout tone="warning" size="sm">
              {snapshot.scheduler.message ?? 'This host can’t start automations on schedule.'} Run
              now still works.
            </Callout>
          )}
          {snapshot.error && (
            <Callout tone="error" size="sm">
              Couldn’t read this host’s automations: {snapshot.error} Showing the last ones read.
            </Callout>
          )}
        </div>
      )}
      {snapshot.automations.map((automation) => (
        <AutomationRow
          key={automation.id}
          automation={automation}
          runs={snapshot.runs[automation.id] ?? []}
          projectName={
            projects.find((project) => project.id === automation.projectId)?.name ??
            automation.projectName
          }
          workspaceIds={workspaceIds}
          busy={busyIds.has(automation.id)}
          onToggle={onToggle}
          onRunNow={onRunNow}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenWorkspace={onOpenWorkspace}
        />
      ))}
    </SettingsCard>
  );
}

interface AutomationRowProps {
  automation: Automation;
  runs: AutomationRun[];
  projectName?: string;
  workspaceIds: ReadonlySet<string>;
  busy: boolean;
  onToggle: (automation: Automation, enabled: boolean) => void;
  onRunNow: (automation: Automation) => void;
  onEdit: (automation: Automation) => void;
  onDelete: (automation: Automation) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}

function AutomationRow({
  automation,
  runs,
  projectName,
  workspaceIds,
  busy,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onOpenWorkspace,
}: AutomationRowProps) {
  const lastRun = runs[0];
  const next = automation.enabled ? nextRunTime(automation) : undefined;
  const details = [
    describeSchedule(automation.schedule.cron),
    projectName,
    automation.startBranch && `from ${automation.startBranch}`,
    automation.agentName,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex items-start gap-3 !py-3 !pl-4">
      <Switch
        className="mt-0.5"
        checked={automation.enabled}
        disabled={busy}
        onCheckedChange={(enabled) => onToggle(automation, enabled)}
        aria-label={`${automation.enabled ? 'Turn off' : 'Turn on'} ${automation.name}`}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p
          className={cn(
            'truncate text-sm font-medium',
            !automation.enabled && 'text-muted-foreground'
          )}
        >
          {automation.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">{details}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {next !== undefined && <span>Next {next}</span>}
          {next !== undefined && lastRun && <span aria-hidden="true">·</span>}
          {lastRun && (
            <LastRun
              run={lastRun}
              canOpen={!!lastRun.workspaceId && workspaceIds.has(lastRun.workspaceId)}
              onOpen={onOpenWorkspace}
            />
          )}
          {!automation.enabled && !lastRun && <span>Off</span>}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <IconButton
          label={`Run ${automation.name} now`}
          onClick={() => onRunNow(automation)}
          disabled={busy}
        >
          {busy ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
        </IconButton>
        <IconButton label={`Edit ${automation.name}`} onClick={() => onEdit(automation)}>
          <PencilSimple className="size-3.5" />
        </IconButton>
        <IconButton
          label={`Delete ${automation.name}`}
          className="hover:text-destructive"
          onClick={() => onDelete(automation)}
        >
          <Trash className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

function nextRunTime(automation: Automation): string | undefined {
  try {
    const next = nextAutomationOccurrence(automation.schedule, Date.now());
    return next === undefined ? undefined : formatRunTime(next, automation.schedule.timeZone);
  } catch {
    return undefined;
  }
}

function LastRun({
  run,
  canOpen,
  onOpen,
}: {
  run: AutomationRun;
  canOpen: boolean;
  onOpen: (workspaceId: string) => void;
}) {
  const workspaceId = canOpen ? run.workspaceId : undefined;
  const ago = formatRelativeTime(run.startedAt);
  const when = ago === 'now' ? 'just now' : `${ago} ago`;
  const label =
    run.status === 'started'
      ? `Last run started ${when}`
      : run.status === 'failed'
        ? `Last run failed ${when}`
        : `Last run skipped ${when}`;
  return (
    <span
      className={cn(run.status === 'failed' && 'text-error')}
      title={run.message ?? run.branch ?? undefined}
    >
      {label}
      {run.status !== 'started' && run.message ? `: ${run.message}` : ''}
      {workspaceId && (
        <>
          {' '}
          <button
            type="button"
            className="text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-hidden"
            onClick={() => onOpen(workspaceId)}
          >
            Open
          </button>
        </>
      )}
    </span>
  );
}
