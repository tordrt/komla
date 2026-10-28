import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ConfirmRequest {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** Focus the destructive button instead of Cancel, for actions that can be undone. */
  focusConfirm?: boolean;
}

/**
 * A styled replacement for `window.confirm` in destructive flows: `await confirm(...)`
 * resolves true only when the destructive button is pressed. Cancel takes focus,
 * so Enter can't confirm by accident, unless the request sets `focusConfirm`.
 * Render `confirmDialog` once in the caller.
 */
export function useConfirmDialog(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  confirmDialog: React.ReactElement;
} {
  // The request outlives `open` so the text doesn't blank out while the dialog animates closed.
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [open, setOpen] = useState(false);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setOpen(false);
    resolve?.(confirmed);
  }, []);

  const confirm = useCallback((next: ConfirmRequest) => {
    // A newer request supersedes one still waiting for an answer.
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setRequest(next);
      setOpen(true);
    });
  }, []);

  useEffect(() => () => resolveRef.current?.(false), []);

  // onOpenAutoFocus runs only when the content mounts. A request that replaces an open one, or
  // comes while the last one animates closed, would keep the old focus, and Enter would answer
  // it with a button this request didn't choose.
  useEffect(() => {
    if (open && request) (request.focusConfirm ? confirmRef : cancelRef).current?.focus();
  }, [open, request]);

  const confirmDialog = (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) settle(false);
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (request?.focusConfirm ? confirmRef : cancelRef).current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button ref={confirmRef} variant="destructive" onClick={() => settle(true)}>
            {request?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, confirmDialog };
}
