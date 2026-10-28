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
import { useRebaseAbortStore } from '@/stores/rebase-abort.store';
import { abortWorkspaceRebase } from '@/utils/rebase-abort';

/** Confirms `git rebase --abort`, which resets the working tree to the branch before the rebase. */
export function RebaseAbortDialog() {
  const pending = useRebaseAbortStore((s) => s.pending);
  const dismiss = useRebaseAbortStore((s) => s.dismiss);
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Cancel takes focus so Enter can't discard work by accident.
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Abort rebase?</DialogTitle>
          <DialogDescription>
            The branch goes back to how it was before the rebase. Conflict resolutions and other
            uncommitted changes made since the rebase paused will be lost.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={dismiss}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (pending) void abortWorkspaceRebase(pending);
              dismiss();
            }}
          >
            Abort rebase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
