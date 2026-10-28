import { Trash } from '@phosphor-icons/react';
import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { showsRunning, TRASH_RETENTION_DAYS, type Workspace } from '@/types';

import { getWorkspaceDisplayTitle } from './WorkspaceInfoCard';

interface BulkTrashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: Workspace[];
  onConfirm: () => void;
}

/** Trashing several workspaces at once asks first; a single one moves right away. */
export function needsBulkTrashConfirmation(count: number): boolean {
  return count > 1;
}

export function BulkTrashDialog({
  open,
  onOpenChange,
  workspaces,
  onConfirm,
}: BulkTrashDialogProps) {
  const trashButtonRef = useRef<HTMLButtonElement>(null);
  const runningCount = workspaces.filter(showsRunning).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          trashButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash className="size-5 text-muted-foreground" />
            Move {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'} to the
            Trash?
          </DialogTitle>
          <DialogDescription asChild>
            <div>
              <span className="block">
                You can restore them from the Trash for {TRASH_RETENTION_DAYS} days:
              </span>
              <ul className="mt-2 max-h-40 list-inside list-disc overflow-y-auto text-sm">
                {workspaces.map((w) => (
                  <li key={w.id}>{getWorkspaceDisplayTitle(w)}</li>
                ))}
              </ul>
              {runningCount > 0 && (
                <span className="mt-2 block font-medium text-foreground">
                  {runningCount} of these {runningCount === 1 ? 'workspace is' : 'workspaces are'}{' '}
                  currently running and will be stopped.
                </span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            ref={trashButtonRef}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {workspaces.length === 1 ? 'Move to Trash' : 'Move All to Trash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
