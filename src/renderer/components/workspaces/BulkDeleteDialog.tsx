import { Warning } from '@phosphor-icons/react';
import { useRef, useState, useEffect } from 'react';

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
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { getUnsavedWorkByWorkspace, type UnsavedWork } from '@/lib/workspace-unsaved-work';
import { useProjectsStore } from '@/stores/projects.store';
import { canDeleteWorkspaceBranch, showsRunning, type Workspace } from '@/types';

import { getWorkspaceDisplayTitle } from './WorkspaceInfoCard';

interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: Workspace[];
  /** Ask git first and keep the workspaces whose uncommitted or unpushed work would be lost. */
  keepUnsavedWork?: boolean;
  onConfirm: (deleteBranch: boolean, workspaces: Workspace[]) => void;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Why a workspace is kept instead of deleted, or null when nothing would be lost.
function getKeepReason(work: UnsavedWork | null | undefined, deletesBranch: boolean) {
  if (work === undefined) return null;
  if (work === null) return "couldn't check for unsaved work";
  if (work.uncommittedFiles > 0) {
    return `uncommitted changes in ${pluralize(work.uncommittedFiles, 'file', 'files')}`;
  }
  if (deletesBranch && work.unpushedCommits > 0) {
    return pluralize(work.unpushedCommits, 'unpushed commit', 'unpushed commits');
  }
  return null;
}

interface KeptWorkspace {
  workspace: Workspace;
  reason: string;
}

interface BulkDeletePlan {
  toDelete: Workspace[];
  kept: KeptWorkspace[];
  /** Workspaces whose branch the branch switch decides about. */
  worktreesWithBranch: Workspace[];
  /** Branches deleted while the switch is on. */
  branchesToDelete: number;
  deletesBranches: boolean;
  /** Some are kept only for unpushed commits, which keeping their branches would save. */
  keptOnlyForUnpushedCommits: boolean;
}

function planBulkDelete(
  workspaces: Workspace[],
  unsavedWork: Map<string, UnsavedWork | null> | null,
  deleteBranchChecked: boolean,
  canDeleteBranch: (workspace: Workspace) => boolean
): BulkDeletePlan {
  const keepReason = (workspace: Workspace, deletesBranches: boolean) =>
    getKeepReason(unsavedWork?.get(workspace.id), deletesBranches && canDeleteBranch(workspace));
  // While the switch is on, workspaces with unpushed commits are kept, so their
  // branches stay either way.
  const worktreesWithBranch = workspaces.filter(
    (workspace) => canDeleteBranch(workspace) && !keepReason(workspace, false)
  );
  const deletesBranches = deleteBranchChecked && worktreesWithBranch.length > 0;
  const kept = workspaces.flatMap((workspace) => {
    const reason = keepReason(workspace, deletesBranches);
    return reason ? [{ workspace, reason }] : [];
  });
  return {
    toDelete: workspaces.filter((workspace) => !keepReason(workspace, deletesBranches)),
    kept,
    worktreesWithBranch,
    branchesToDelete: worktreesWithBranch.filter((workspace) => !keepReason(workspace, true))
      .length,
    deletesBranches,
    keptOnlyForUnpushedCommits: kept.some(({ workspace }) => !keepReason(workspace, false)),
  };
}

/** What deleting each workspace would lose, asked of git while the dialog is open; null until it answers. */
function useUnsavedWork(open: boolean, keepUnsavedWork: boolean, workspaces: Workspace[]) {
  const [checked, setChecked] = useState<{
    workspaces: Workspace[];
    unsavedWork: Map<string, UnsavedWork | null>;
  } | null>(null);

  useEffect(() => {
    if (!open || !keepUnsavedWork) return;
    let cancelled = false;
    void getUnsavedWorkByWorkspace(workspaces).then((unsavedWork) => {
      if (!cancelled) setChecked({ workspaces, unsavedWork });
    });
    return () => {
      cancelled = true;
    };
  }, [open, keepUnsavedWork, workspaces]);

  return checked?.workspaces === workspaces ? checked.unsavedWork : null;
}

function DeleteSummary({ checking, toDelete }: { checking: boolean; toDelete: Workspace[] }) {
  if (checking) {
    return (
      <span className="flex items-center gap-2">
        <Spinner size="xs" />
        Checking for uncommitted changes and unpushed commits…
      </span>
    );
  }
  if (toDelete.length === 0) {
    return <span className="block">Deleting would lose the work listed below.</span>;
  }
  return (
    <>
      <span className="block">This will permanently delete the following workspaces:</span>
      <ul className="mt-2 max-h-40 list-inside list-disc overflow-y-auto text-sm">
        {toDelete.map((w) => (
          <li key={w.id}>{getWorkspaceDisplayTitle(w)}</li>
        ))}
      </ul>
    </>
  );
}

function KeptWorkspacesCallout({
  kept,
  keptOnlyForUnpushedCommits,
}: Pick<BulkDeletePlan, 'kept' | 'keptOnlyForUnpushedCommits'>) {
  return (
    <Callout
      tone="info"
      size="sm"
      title={`Keeping ${pluralize(kept.length, 'workspace', 'workspaces')} with unsaved work`}
    >
      <ul className="max-h-32 overflow-y-auto">
        {kept.map(({ workspace, reason }) => (
          <li key={workspace.id}>
            {getWorkspaceDisplayTitle(workspace)}: {reason}
          </li>
        ))}
      </ul>
      {keptOnlyForUnpushedCommits && (
        <p className="mt-1">
          Turn off “Also delete local branches” to delete the ones with unpushed commits too and
          keep their branches.
        </p>
      )}
    </Callout>
  );
}

export function BulkDeleteDialog({
  open,
  onOpenChange,
  workspaces,
  keepUnsavedWork = false,
  onConfirm,
}: BulkDeleteDialogProps) {
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const projects = useProjectsStore((state) => state.projects);
  const unsavedWork = useUnsavedWork(open, keepUnsavedWork, workspaces);
  const checking = keepUnsavedWork && !unsavedWork;

  const [deleteBranchChecked, setDeleteBranchChecked] = useState(true);

  // Reset to checked (default) when dialog opens
  useEffect(() => {
    if (open) setDeleteBranchChecked(true);
  }, [open]);

  const plan = planBulkDelete(workspaces, unsavedWork, deleteBranchChecked, (workspace) =>
    canDeleteWorkspaceBranch(
      workspace,
      workspace.projectId
        ? projects.find((project) => project.id === workspace.projectId)?.baseBranch
        : undefined
    )
  );
  const toDelete = checking ? [] : plan.toDelete;
  const runningCount = toDelete.filter(showsRunning).length;
  const titleCount = checking ? workspaces.length : toDelete.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          deleteButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Warning className="size-5 text-destructive" />
            {titleCount === 0
              ? 'Nothing to delete'
              : `Delete ${titleCount} ${titleCount === 1 ? 'workspace' : 'workspaces'}?`}
          </DialogTitle>
          <DialogDescription asChild>
            <div>
              <DeleteSummary checking={checking} toDelete={toDelete} />
              {runningCount > 0 && (
                <span className="mt-2 block font-medium text-destructive">
                  {runningCount} of these {runningCount === 1 ? 'workspace is' : 'workspaces are'}{' '}
                  currently running and will be stopped.
                </span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        {plan.kept.length > 0 && (
          <KeptWorkspacesCallout
            kept={plan.kept}
            keptOnlyForUnpushedCommits={plan.keptOnlyForUnpushedCommits}
          />
        )}
        {plan.worktreesWithBranch.length > 0 && !checking && (
          <div className="flex items-center justify-between py-2">
            <label htmlFor="delete-branches" className="text-sm">
              Also delete local branches
              {plan.branchesToDelete > 0 &&
                ` (${pluralize(plan.branchesToDelete, 'worktree', 'worktrees')})`}
            </label>
            <Switch
              id="delete-branches"
              checked={deleteBranchChecked}
              onCheckedChange={setDeleteBranchChecked}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            ref={deleteButtonRef}
            variant="destructive"
            disabled={toDelete.length === 0}
            onClick={() => {
              onOpenChange(false);
              onConfirm(plan.deletesBranches, toDelete);
            }}
          >
            {toDelete.length === 1 ? 'Delete' : 'Delete All'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
