import { Warning } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import {
  describeSetupStepsUsingAction,
  type SetupStepUsingAction,
} from '../../../../shared/lib/action-references';

interface DeleteActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionTitle?: string;
  /** The Setup steps that run the quick command, which have to stop using it first. */
  usedBy: readonly SetupStepUsingAction[];
  onConfirm: () => void;
  isBusy: boolean;
}

export function DeleteActionDialog({
  open,
  onOpenChange,
  actionTitle,
  usedBy,
  onConfirm,
  isBusy,
}: DeleteActionDialogProps) {
  const inUse = usedBy.length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Warning className="size-4 text-error" />
            Delete quick command
          </DialogTitle>
          <DialogDescription>
            {inUse
              ? `Workspace Setup runs "${actionTitle || 'this quick command'}": ${describeSetupStepsUsingAction(usedBy)}. Remove it from those steps before deleting it.`
              : `Delete "${actionTitle || 'this quick command'}"? This cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            {inUse ? 'Close' : 'Cancel'}
          </Button>
          {!inUse && (
            <Button variant="destructive" onClick={onConfirm} disabled={isBusy}>
              {isBusy ? 'Deleting...' : 'Delete'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
