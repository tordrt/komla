import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import type { NotificationIntegrationUpdate } from '../../../../shared/types/notification-integration';

export function NotificationUpdateReview({
  update,
  preview,
  loading,
  onApply,
}: {
  update: NotificationIntegrationUpdate;
  preview: string;
  loading: boolean;
  onApply: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" disabled={loading} onClick={() => setOpen(true)}>
        Review update
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Update notification integration</DialogTitle>
            <DialogDescription>
              Review the agent files Komla will change when you apply this update.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            {update.files.map((file) => (
              <div key={file.path} className="space-y-1">
                <p className="font-mono text-xs break-all">{file.path}</p>
                <p className="text-sm text-muted-foreground">{file.description}</p>
              </div>
            ))}
            <p className="text-sm font-medium">Notification configuration to install</p>
            <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{preview}</pre>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={loading}
              onClick={() => {
                setOpen(false);
                onApply();
              }}
            >
              Apply update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
