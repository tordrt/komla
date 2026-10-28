import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { formatRelativeTime } from '@/lib/format-time';
import { getWorkspaceLastTouchedAt } from '@/lib/workspace-state-groups';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { TRASH_RETENTION_DAYS } from '@/types';

import { getWorkspaceDisplayTitle } from '../../../shared/lib/workspace-title';

import type { Workspace, WorkspaceCleanupStatus } from '../../../shared/types';

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface WorkspaceGroup {
  key: 'landed' | 'stale';
  title: string;
  hint?: string;
  workspaces: Workspace[];
}

/** Every change in it is in its target branch, and nothing is left uncommitted. */
function isLanded(status: WorkspaceCleanupStatus | undefined): boolean {
  return !!status?.ok && status.landed && !status.uncommittedChanges;
}

/**
 * Workspaces whose changes are all in their target branch, then the others no one has used in
 * 30 days, each group most recently used first. Ones still in use with changes to lose are left
 * out.
 */
export function groupWorkspacesForCleanup(
  workspaces: readonly Workspace[],
  statuses: ReadonlyMap<string, WorkspaceCleanupStatus>,
  now: number
): WorkspaceGroup[] {
  const sorted = [...workspaces].sort(
    (a, b) => getWorkspaceLastTouchedAt(b) - getWorkspaceLastTouchedAt(a)
  );
  const landed = sorted.filter((workspace) => isLanded(statuses.get(workspace.id)));
  const notLanded = sorted.filter((workspace) => !isLanded(statuses.get(workspace.id)));
  const targets = new Set(landed.map((workspace) => statuses.get(workspace.id)?.targetBranch));
  const target = targets.size === 1 ? [...targets][0] : 'their target branch';
  const groups: WorkspaceGroup[] = [
    {
      key: 'landed',
      title: `Already in ${target}`,
      hint: `Nothing in them is missing from ${target}.`,
      workspaces: landed,
    },
    {
      key: 'stale',
      title: 'Not used in 30 days',
      workspaces: notLanded.filter(
        (workspace) => now - getWorkspaceLastTouchedAt(workspace) > STALE_AFTER_MS
      ),
    },
  ];
  return groups.filter((group) => group.workspaces.length > 0);
}

/** What keeps a workspace from being ticked to start with, or why it may not be done. */
function workspaceNotes(
  workspace: Workspace,
  status: WorkspaceCleanupStatus | undefined,
  marksUnchecked: boolean
) {
  const notes: string[] = [];
  if (workspace.agentActive) notes.push('Agent working');
  if (workspace.pinned) notes.push('Pinned');
  if (status && !status.ok) notes.push("Couldn't check its branch");
  // Such as one whose files never got made.
  if (!status && marksUnchecked && workspace.isWorktree) notes.push('Not checked');
  if (status?.ok && status.uncommittedChanges) notes.push('Uncommitted changes');
  if (status?.ok && !status.landed) notes.push(`Changes not in ${status.targetBranch}`);
  return notes;
}

/** Ticked when the dialog opens: done with, and neither pinned nor busy. */
function selectedAtFirst(workspace: Workspace, status: WorkspaceCleanupStatus | undefined) {
  return isLanded(status) && !workspace.pinned && !workspace.agentActive;
}

function pluralizeWorkspaces(count: number): string {
  return `${count} ${count === 1 ? 'workspace' : 'workspaces'}`;
}

function WorkspaceGroupList({
  group,
  statuses,
  marksUnchecked,
  selected,
  onSelectedChange,
}: {
  group: WorkspaceGroup;
  statuses: ReadonlyMap<string, WorkspaceCleanupStatus>;
  /** Say which worktrees the check left out: not when the whole check failed, or had none. */
  marksUnchecked: boolean;
  selected: ReadonlySet<string>;
  onSelectedChange: (ids: string[], checked: boolean) => void;
}) {
  const ids = group.workspaces.map((workspace) => workspace.id);
  const allSelected = ids.every((id) => selected.has(id));
  return (
    <section aria-label={group.title}>
      <label className="flex cursor-pointer items-center gap-2 py-1.5 text-sm font-medium">
        <Checkbox
          checked={allSelected}
          onChange={(event) => onSelectedChange(ids, event.target.checked)}
        />
        {group.title}
        <span className="font-normal text-muted-foreground">{group.workspaces.length}</span>
      </label>
      {group.hint && <p className="pb-1 pl-5.5 text-xs text-muted-foreground">{group.hint}</p>}
      <ul>
        {group.workspaces.map((workspace) => {
          const status = statuses.get(workspace.id);
          const notes = workspaceNotes(workspace, status, marksUnchecked);
          return (
            <li key={workspace.id}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md py-1 pr-1 pl-5.5 hover:bg-muted/50">
                <Checkbox
                  className="mt-0.5"
                  checked={selected.has(workspace.id)}
                  onChange={(event) => onSelectedChange([workspace.id], event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">
                    {getWorkspaceDisplayTitle(workspace)}
                  </span>
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    title={status && !status.ok ? status.error : undefined}
                  >
                    {workspace.branchName && (
                      <span className="font-mono">{workspace.branchName}</span>
                    )}
                    {workspace.branchName && notes.length > 0 && ' · '}
                    {notes.join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {formatRelativeTime(getWorkspaceLastTouchedAt(workspace))}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface WorkspaceCleanupDialogProps {
  projectId: string;
  /** A directory project's workspaces have no branches, so only how long since use counts. */
  isDirectory?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceCleanupDialog({
  projectId,
  isDirectory = false,
  open,
  onOpenChange,
}: WorkspaceCleanupDialogProps) {
  // Each open gets a new body, even one during the last close's fade-out, which keeps it mounted.
  const [opens, setOpens] = useState(open ? 1 : 0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpens(opens + 1);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <WorkspaceCleanup
          key={opens}
          projectId={projectId}
          isDirectory={isDirectory}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceCleanup({
  projectId,
  isDirectory,
  onClose,
}: {
  projectId: string;
  isDirectory: boolean;
  onClose: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const allWorkspaces = useWorkspacesStore((s) => s.workspaces);
  const trashWorkspaces = useWorkspacesStore((s) => s.trashWorkspaces);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, WorkspaceCleanupStatus> | null>(
    null
  );
  // The workspaces offered, as of the check, while they stay active.
  const [listedIds, setListedIds] = useState<ReadonlySet<string>>(new Set());
  // Ones being moved to the Trash stay listed until it's done, or as the dialog fades out.
  const [isClosing, setIsClosing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [isTrashing, setIsTrashing] = useState(false);
  const workspaces = useMemo(
    () =>
      allWorkspaces.filter(
        (workspace) =>
          listedIds.has(workspace.id) && (isTrashing || isClosing || workspace.status === 'active')
      ),
    [allWorkspaces, listedIds, isTrashing, isClosing]
  );

  useEffect(() => {
    let cancelled = false;
    const start = (checked: WorkspaceCleanupStatus[]) => {
      if (cancelled) return;
      const byId = new Map(checked.map((status) => [status.workspaceId, status]));
      // Read now, not as a dependency: workspaces change on every agent title.
      const listed = useWorkspacesStore
        .getState()
        .workspaces.filter(
          (workspace) =>
            workspace.projectId === projectId &&
            workspace.status === 'active' &&
            !workspace.provisioning
        );
      setStatuses(byId);
      setListedIds(new Set(listed.map((workspace) => workspace.id)));
      setSelected(
        new Set(
          listed
            .filter((workspace) => selectedAtFirst(workspace, byId.get(workspace.id)))
            .map((workspace) => workspace.id)
        )
      );
    };
    window.api
      .checkWorkspacesForCleanup(projectId)
      .then(start)
      .catch((error: Error) => {
        if (cancelled) return;
        setLoadError(error.message);
        start([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const groups = statuses ? groupWorkspacesForCleanup(workspaces, statuses, Date.now()) : [];
  const toTrash = workspaces.filter((workspace) => selected.has(workspace.id));

  const changeSelected = (ids: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const handleTrash = async () => {
    const ids = toTrash.map((workspace) => workspace.id);
    setIsTrashing(true);
    try {
      // Asks first about unsaved files, and says itself which workspaces it couldn't move.
      await trashWorkspaces(ids);
    } finally {
      setIsTrashing(false);
    }
    const trashed = new Set(
      useWorkspacesStore
        .getState()
        .workspaces.filter(
          (workspace) => ids.includes(workspace.id) && workspace.status === 'trashed'
        )
        .map((workspace) => workspace.id)
    );
    if (trashed.size === 0) return;
    addToast(`Moved ${pluralizeWorkspaces(trashed.size)} to the Trash`, 'success');
    if (trashed.size === ids.length) {
      setIsClosing(true);
      onClose();
      return;
    }
    changeSelected([...trashed], false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Clean up workspaces</DialogTitle>
        <DialogDescription>
          {isDirectory
            ? 'Workspaces not used in 30 days.'
            : 'Workspaces with no changes to lose, and ones not used in 30 days.'}{' '}
          You can restore them from the Trash for {TRASH_RETENTION_DAYS} days.
        </DialogDescription>
      </DialogHeader>
      {loadError && (
        <Callout tone="warning" size="sm" title="Couldn't check the workspaces' branches">
          {loadError}
        </Callout>
      )}
      {!statuses ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Spinner size="xs" />
          {isDirectory
            ? 'Loading workspaces…'
            : 'Checking which workspaces are already in their target branch…'}
        </p>
      ) : groups.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No workspaces to clean up.</p>
      ) : (
        <div className="-mx-1 max-h-[50vh] space-y-3 overflow-y-auto px-1">
          {groups.map((group) => (
            <WorkspaceGroupList
              key={group.key}
              group={group}
              statuses={statuses}
              marksUnchecked={!isDirectory && !loadError}
              selected={selected}
              onSelectedChange={changeSelected}
            />
          ))}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={toTrash.length === 0 || isTrashing} onClick={() => void handleTrash()}>
          {isTrashing && <Spinner size="xs" />}
          {toTrash.length === 0
            ? 'Move to Trash'
            : `Move ${pluralizeWorkspaces(toTrash.length)} to Trash`}
        </Button>
      </DialogFooter>
    </>
  );
}
