import { useEffect, useMemo, useRef, useState } from 'react';

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
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { formatRelativeTime } from '@/lib/format-time';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { isSshWorkspace } from '../../../shared/types';

import type { BranchDeletionResult, LeftoverBranch, LeftoverBranches } from '../../../shared/types';

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface BranchGroup {
  key: 'landed' | 'stale' | 'recent';
  title: string;
  hint: string;
  branches: LeftoverBranch[];
}

/** Landed branches first, then the others by whether they had a commit in the last 30 days. */
export function groupLeftoverBranches(
  { targetBranch, branches }: LeftoverBranches,
  now: number
): BranchGroup[] {
  const notLanded = branches.filter((branch) => !branch.landed);
  const groups: BranchGroup[] = [
    {
      key: 'landed',
      title: `Already in ${targetBranch}`,
      hint: 'Deleting these loses no changes.',
      branches: branches.filter((branch) => branch.landed),
    },
    {
      key: 'stale',
      title: 'No commits in 30 days',
      hint: `Some of their changes aren't in ${targetBranch}.`,
      branches: notLanded.filter((branch) => now - branch.lastCommitAt > STALE_AFTER_MS),
    },
    {
      key: 'recent',
      title: 'Recent',
      hint: `Some of their changes aren't in ${targetBranch}.`,
      branches: notLanded.filter((branch) => now - branch.lastCommitAt <= STALE_AFTER_MS),
    },
  ];
  return groups.filter((group) => group.branches.length > 0);
}

function pluralizeBranches(count: number): string {
  return `${count} ${count === 1 ? 'branch' : 'branches'}`;
}

function BranchGroupList({
  group,
  selected,
  onSelectedChange,
}: {
  group: BranchGroup;
  selected: ReadonlySet<string>;
  onSelectedChange: (names: string[], checked: boolean) => void;
}) {
  const names = group.branches.map((branch) => branch.name);
  const allSelected = names.every((name) => selected.has(name));
  return (
    <section aria-label={group.title}>
      <label className="flex cursor-pointer items-center gap-2 py-1.5 text-sm font-medium">
        <Checkbox
          checked={allSelected}
          onChange={(event) => onSelectedChange(names, event.target.checked)}
        />
        {group.title}
        <span className="font-normal text-muted-foreground">{group.branches.length}</span>
      </label>
      <p className="pb-1 pl-5.5 text-xs text-muted-foreground">{group.hint}</p>
      <ul>
        {group.branches.map((branch) => (
          <li key={branch.name}>
            <label className="flex cursor-pointer items-start gap-2 rounded-md py-1 pr-1 pl-5.5 hover:bg-muted/50">
              <Checkbox
                className="mt-0.5"
                checked={selected.has(branch.name)}
                onChange={(event) => onSelectedChange([branch.name], event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">{branch.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {branch.subject}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                <span className="block">{formatRelativeTime(branch.lastCommitAt)}</span>
                <span className="block font-mono" title={branch.commit}>
                  {branch.commit.slice(0, 7)}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The SSH hosts where a project has workspaces, each of which keeps its own clone. */
function useProjectHosts(projectId: string, hostId: string | null) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const hosts = useSshHostsStore((s) => s.hosts);
  return useMemo(() => {
    const hostIds = new Set(
      workspaces.flatMap((workspace) =>
        workspace.projectId === projectId && isSshWorkspace(workspace)
          ? [workspace.backend.hostId]
          : []
      )
    );
    if (hostId) hostIds.add(hostId);
    return [...hostIds].map((id) => ({
      id,
      name: hosts.find((host) => host.id === id)?.name ?? id,
    }));
  }, [workspaces, hosts, projectId, hostId]);
}

interface BranchCleanupDialogProps {
  projectId: string;
  /** The SSH host whose clone to clean up first; this computer's when unset. */
  hostId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BranchCleanupDialog({
  projectId,
  hostId = null,
  open,
  onOpenChange,
}: BranchCleanupDialogProps) {
  const addToast = useToastStore((s) => s.addToast);
  const hosts = useProjectHosts(projectId, hostId);
  // An SSH host's id, or '' for this computer.
  const [location, setLocation] = useState(hostId ?? '');
  const [leftover, setLeftover] = useState<LeftoverBranches | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<BranchDeletionResult['failed']>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  // A reload after a delete keeps the ticks; opening the dialog starts from the landed branches.
  const keepSelectionRef = useRef(false);

  // Back to where it was opened for once closed, so the next open checks there straight away.
  useEffect(() => {
    if (!open) setLocation(hostId ?? '');
  }, [open, hostId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const keepSelection = keepSelectionRef.current;
    keepSelectionRef.current = false;
    setLeftover(null);
    setLoadError(null);
    window.api
      .listLeftoverBranches(projectId, location || null)
      .then((result) => {
        if (cancelled) return;
        setLeftover(result);
        setSelected((prev) => {
          const listed = result.branches.filter((b) =>
            keepSelection ? prev.has(b.name) : b.landed
          );
          return new Set(listed.map((b) => b.name));
        });
      })
      .catch((error: Error) => {
        if (!cancelled) setLoadError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, location, reloadCount]);

  useEffect(() => {
    if (open) setFailed([]);
  }, [open, location]);

  const groups = leftover ? groupLeftoverBranches(leftover, Date.now()) : [];
  const toDelete = leftover?.branches.filter((branch) => selected.has(branch.name)) ?? [];

  const changeSelected = (names: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const name of names) {
        if (checked) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const result = await window.api.deleteLeftoverBranches(
        projectId,
        toDelete.map(({ name, commit }) => ({ name, commit })),
        location || null
      );
      if (result.deleted.length > 0) {
        addToast(`Deleted ${pluralizeBranches(result.deleted.length)}`, 'success');
      }
      if (result.failed.length === 0) {
        onOpenChange(false);
        return;
      }
      setFailed(result.failed);
      // A kept branch may have moved since it was ticked, so it has to be ticked again.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const { name } of result.failed) next.delete(name);
        return next;
      });
      keepSelectionRef.current = true;
      setReloadCount((count) => count + 1);
    } catch (error) {
      addToast((error as Error).message, 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clean up branches</DialogTitle>
          <DialogDescription>
            Branches in the project&apos;s clone that no workspace uses and no worktree has checked
            out, such as those of deleted workspaces.
          </DialogDescription>
        </DialogHeader>
        {hosts.length > 0 && (
          <SegmentedControl
            aria-label="Clone"
            value={location}
            onValueChange={setLocation}
            disabled={isDeleting}
            options={[
              { value: '', label: 'This computer' },
              ...hosts.map((host) => ({ value: host.id, label: host.name })),
            ]}
          />
        )}
        {failed.length > 0 && (
          <Callout tone="warning" size="sm" title={`Kept ${pluralizeBranches(failed.length)}`}>
            <ul className="max-h-24 overflow-y-auto">
              {failed.map(({ name, message }) => (
                <li key={name}>
                  <span className="font-mono">{name}</span>: {message}
                </li>
              ))}
            </ul>
          </Callout>
        )}
        {loadError ? (
          <Callout tone="error" size="sm" title="Couldn't list branches">
            {loadError}
          </Callout>
        ) : !leftover ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner size="xs" />
            Checking which branches are already in the target branch…
          </p>
        ) : groups.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No leftover branches.</p>
        ) : (
          <>
            <div className="-mx-1 max-h-[50vh] space-y-3 overflow-y-auto px-1">
              {groups.map((group) => (
                <BranchGroupList
                  key={group.key}
                  group={group}
                  selected={selected}
                  onSelectedChange={changeSelected}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Komla&apos;s log keeps each deleted branch&apos;s commit; restore one with{' '}
              <code className="font-mono whitespace-nowrap">
                git branch &lt;name&gt; &lt;commit&gt;
              </code>
              .
            </p>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={toDelete.length === 0 || isDeleting}
            onClick={() => void handleDelete()}
          >
            {isDeleting && <Spinner size="xs" />}
            {toDelete.length === 0 ? 'Delete' : `Delete ${pluralizeBranches(toDelete.length)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
