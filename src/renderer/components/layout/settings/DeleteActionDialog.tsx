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

interface DeleteActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionTitle?: string;
  onConfirm: () => void;
  isBusy: boolean;
}

export function DeleteActionDialog({
  open,
  onOpenChange,
  actionTitle,
  onConfirm,
  isBusy,
}: DeleteActionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Warning className="size-4 text-destructive" />
            Delete quick command
          </DialogTitle>
          <DialogDescription>
            Delete "{actionTitle || 'this quick command'}"? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isBusy}>
            {isBusy ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
