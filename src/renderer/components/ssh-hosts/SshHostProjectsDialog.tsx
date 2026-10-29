import { useEffect, useState } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshHostProjectsDialogStore } from '@/stores/ssh-host-projects-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';

import type {
  SshHostProject,
  SshProjectSettingsPart,
} from '../../../shared/types/ssh-project-manifest';

const PART_LABELS: Record<SshProjectSettingsPart, string> = {
  appearance: 'Icon and color',
  workspaceSetup: 'Workspace Setup',
  quickCommands: 'Quick Commands',
  settings: 'Branch and merge settings',
};

type ListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; projects: SshHostProject[] }
  | { kind: 'failed'; message: string };

/** What the user picked for each project: whether to take it, which parts, and to keep it in sync. */
type Picks = Record<
  string,
  { included: boolean; parts: ReadonlySet<SshProjectSettingsPart>; keepInSync: boolean }
>;

function pluralizeProjects(count: number): string {
  return `${count} ${count === 1 ? 'project' : 'projects'}`;
}

/** The one dialog for taking projects from an SSH host, opened through its store. */
export function SshHostProjectsDialogHost() {
  const open = useSshHostProjectsDialogStore((s) => s.open);
  const hostId = useSshHostProjectsDialogStore((s) => s.hostId);
  const close = useSshHostProjectsDialogStore((s) => s.close);
  if (!hostId) return null;
  return (
    <SshHostProjectsDialog
      key={hostId}
      hostId={hostId}
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    />
  );
}

/**
 * Projects set up on an SSH host: ones to add here, and ones whose settings
 * there differ from this installation's.
 */
export function SshHostProjectsDialog({
  hostId,
  open,
  onOpenChange,
}: {
  hostId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hostName = useSshHostsStore((s) => s.hosts.find((host) => host.id === hostId)?.name);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const addToast = useToastStore((s) => s.addToast);
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [picks, setPicks] = useState<Picks>({});
  const [importing, setImporting] = useState(false);
  const [failures, setFailures] = useState<Array<{ name: string; error: string }>>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    setFailures([]);
    window.api
      .listSshHostProjects(hostId)
      .then((projects) => {
        if (cancelled) return;
        setState({ kind: 'loaded', projects });
        setPicks(
          Object.fromEntries(
            projects.map((project) => [
              project.manifestId,
              {
                // One removed here was likely removed on purpose.
                included: !project.removedHere,
                parts: new Set(project.differs),
                keepInSync: project.projectId ? !!project.keepsInSync : true,
              },
            ])
          )
        );
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ kind: 'failed', message: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [open, hostId]);

  const projects = state.kind === 'loaded' ? state.projects : [];
  const picked = projects.filter((project) => picks[project.manifestId]?.included);
  const toImport = picked.filter(
    (project) =>
      !project.projectId ||
      picks[project.manifestId].parts.size > 0 ||
      picks[project.manifestId].keepInSync !== !!project.keepsInSync
  );
  const adding = toImport.filter((project) => !project.projectId).length;
  const copying = toImport.length - adding;

  const pick = (manifestId: string, change: Partial<Picks[string]>) =>
    setPicks((current) => ({ ...current, [manifestId]: { ...current[manifestId], ...change } }));

  const handleImport = async () => {
    setImporting(true);
    setFailures([]);
    try {
      const results = await window.api.importSshHostProjects(
        hostId,
        toImport.map((project) => ({
          manifestId: project.manifestId,
          parts: [...picks[project.manifestId].parts],
          keepInSync: picks[project.manifestId].keepInSync,
        }))
      );
      await loadProjects();
      const names = new Map(projects.map((project) => [project.manifestId, project.name]));
      // One the user didn't apply stays offered, without an error.
      const failed = results.flatMap((result) =>
        result.ok || result.cancelled
          ? []
          : [{ name: names.get(result.manifestId) ?? '', error: result.error }]
      );
      const cancelled = results.some((result) => !result.ok && result.cancelled);
      const added = results.filter((result) => result.ok && result.added).length;
      const updated = results.filter((result) => result.ok && !result.added).length;
      if (added > 0 || updated > 0) {
        addToast(
          added > 0 && updated > 0
            ? `Added ${pluralizeProjects(added)} and copied settings for ${pluralizeProjects(updated)}`
            : added > 0
              ? `Added ${pluralizeProjects(added)} from ${hostName ?? 'the SSH host'}`
              : `Copied settings for ${pluralizeProjects(updated)}`,
          'success'
        );
      }
      if (failed.length === 0 && !cancelled) {
        onOpenChange(false);
        return;
      }
      setFailures(failed);
      // What was taken is no longer offered.
      const taken = new Set(results.filter((result) => result.ok).map((r) => r.manifestId));
      setState({
        kind: 'loaded',
        projects: projects.filter((project) => !taken.has(project.manifestId)),
      });
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      setImporting(false);
    }
  };

  const newProjects = projects.filter((project) => !project.projectId);
  const changedProjects = projects.filter((project) => project.projectId);

  return (
    <Dialog open={open} onOpenChange={(next) => !importing && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Projects on {hostName ?? 'this SSH host'}</DialogTitle>
          <DialogDescription>
            Projects set up there, with their settings. Adding one clones its repository here too.
            You review the changes before they apply.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {failures.length > 0 && (
            <Callout tone="error" size="sm" title={`Couldn’t import ${failures.length}`}>
              <ul>
                {failures.map(({ name, error }) => (
                  <li key={name}>
                    <span className="font-medium">{name}</span>: {error}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {state.kind === 'loading' ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Spinner size="xs" />
              Reading projects on {hostName ?? 'the host'}…
            </p>
          ) : state.kind === 'failed' ? (
            <Callout tone="error" size="sm" title="Couldn’t read the host’s projects">
              {state.message}
            </Callout>
          ) : projects.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Every project on this host is here already, with the same settings.
            </p>
          ) : (
            <div className="-mx-1 max-h-[55vh] space-y-4 overflow-y-auto px-1">
              {newProjects.length > 0 && (
                <ProjectSection
                  title="Not here yet"
                  projects={newProjects}
                  picks={picks}
                  disabled={importing}
                  onPick={pick}
                />
              )}
              {changedProjects.length > 0 && (
                <ProjectSection
                  title="Different settings on the host"
                  projects={changedProjects}
                  picks={picks}
                  disabled={importing}
                  onPick={pick}
                />
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={importing} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={toImport.length === 0 || importing} onClick={() => void handleImport()}>
            {importing && <Spinner size="xs" />}
            {adding > 0 && copying > 0
              ? `Import ${pluralizeProjects(adding + copying)}`
              : adding > 0
                ? `Add ${pluralizeProjects(adding)}`
                : 'Copy settings'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSection({
  title,
  projects,
  picks,
  disabled,
  onPick,
}: {
  title: string;
  projects: SshHostProject[];
  picks: Picks;
  disabled: boolean;
  onPick: (manifestId: string, change: Partial<Picks[string]>) => void;
}) {
  return (
    <section aria-label={title} className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="divide-y divide-border/60 rounded-lg border">
        {projects.map((project) => (
          <ProjectRow
            key={project.manifestId}
            project={project}
            pick={picks[project.manifestId]}
            disabled={disabled}
            onPick={(change) => onPick(project.manifestId, change)}
          />
        ))}
      </ul>
    </section>
  );
}

function ProjectRow({
  project,
  pick,
  disabled,
  onPick,
}: {
  project: SshHostProject;
  pick: Picks[string] | undefined;
  disabled: boolean;
  onPick: (change: Partial<Picks[string]>) => void;
}) {
  const included = pick?.included ?? false;
  const parts = pick?.parts ?? new Set<SshProjectSettingsPart>();
  const togglePart = (part: SshProjectSettingsPart, checked: boolean) => {
    const next = new Set(parts);
    if (checked) next.add(part);
    else next.delete(part);
    onPick({ parts: next });
  };

  return (
    <li className="space-y-2 px-3 py-2.5">
      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox
          checked={included}
          disabled={disabled}
          onChange={(event) => onPick({ included: event.target.checked })}
        />
        <ProjectMark project={project} iconClassName="size-4" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{project.name}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {project.gitUrl}
          </span>
        </span>
        {project.removedHere ? (
          <Badge tone="neutral" size="sm">
            Removed here
          </Badge>
        ) : (
          !project.projectId && (
            <Badge tone="primary" size="sm">
              New
            </Badge>
          )
        )}
      </label>
      {included && project.differs.length > 0 && (
        <div className="space-y-2 pl-5.5">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {project.differs.map((part) => (
              <label key={part} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={parts.has(part)}
                  disabled={disabled}
                  onChange={(event) => togglePart(part, event.target.checked)}
                />
                {PART_LABELS[part]}
              </label>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Checkbox
              checked={pick?.keepInSync ?? false}
              disabled={disabled}
              onChange={(event) => onPick({ keepInSync: event.target.checked })}
            />
            <span className="whitespace-nowrap">Keep in sync</span>
            <span className="truncate text-muted-foreground">
              · Takes a new icon or color, and asks about other changes
            </span>
          </label>
        </div>
      )}
    </li>
  );
}
