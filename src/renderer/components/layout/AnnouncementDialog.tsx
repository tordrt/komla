import { Info, Lightbulb, Megaphone, Warning } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAnnouncementStore, type Announcement } from '@/stores/announcement.store';

const TYPE_ICON: Record<Announcement['type'], React.ElementType> = {
  info: Info,
  tip: Lightbulb,
  'whats-new': Megaphone,
  warning: Warning,
};

export function AnnouncementDialog() {
  const { announcements, dialogOpen, closeDialog, dismiss } = useAnnouncementStore();

  const dialogItems = announcements.filter(
    (a) => a.displayMode === 'dialog' || a.displayMode === 'both'
  );

  const handleClose = () => {
    closeDialog();
  };

  const handleDismissAll = () => {
    for (const item of dialogItems) {
      if (item.dismissible !== false) {
        dismiss(item.id);
      }
    }
    closeDialog();
  };

  if (dialogItems.length === 0 && dialogOpen) {
    closeDialog();
    return null;
  }

  return (
    <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="max-h-[70vh] max-w-lg">
        <DialogHeader>
          <DialogTitle>Announcements</DialogTitle>
          <DialogDescription>Latest updates and announcements</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {dialogItems.map((item) => {
            const Icon = TYPE_ICON[item.type] ?? Info;
            return (
              <div key={item.id} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <h4 className="text-sm font-medium text-foreground">{item.title}</h4>
                </div>
                <p className="text-sm whitespace-pre-line text-muted-foreground">{item.body}</p>
                {item.action && (
                  <button
                    onClick={() => window.api.openExternal(item.action!.url)}
                    className="text-xs text-primary hover:underline"
                  >
                    {item.action.label}
                  </button>
                )}
              </div>
            );
          })}
        </DialogBody>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleDismissAll}>
            Dismiss All
          </Button>
          <Button onClick={handleClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
