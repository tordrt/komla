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
import { usePushConflictStore } from '@/stores/push-conflict.store';

export function PushConflictDialog() {
  const conflict = usePushConflictStore((s) => s.conflict);
  const resolve = usePushConflictStore((s) => s.resolve);
  const allowRebase = conflict?.options.allowRebase ?? false;

  return (
    <Dialog
      open={conflict !== null}
      onOpenChange={(open) => {
        if (!open) resolve('cancel');
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Warning className="size-5" />
            Push Rejected
          </DialogTitle>
          <DialogDescription>
            {conflict?.message ?? 'Remote has new commits.'} Choose how to proceed.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => resolve('cancel')}>
            Cancel
          </Button>
          {allowRebase && (
            <Button variant="outline" onClick={() => resolve('rebase-and-push')}>
              Pull (Rebase) & Push
            </Button>
          )}
          <Button onClick={() => resolve('pull-and-push')}>Pull (Merge) & Push</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
