import { ArrowCircleUp, ArrowsClockwise, Download } from '@phosphor-icons/react';
import { useState } from 'react';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { ReleaseNotesDialog } from '@/components/layout/ReleaseNotesDialog';
import { Banner, BannerAction } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpdateStore } from '@/stores/update.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { diesOnAppRestart } from '@/types';

export function UpdateBanner() {
  const { status, version, releaseNotes, dismissed, installUpdate, openDownload, dismiss } =
    useUpdateStore();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);
  // Restarting kills every local PTY; remote sessions that can be resumed survive.
  const runningTerminalCount = useWorkspacesStore((s) =>
    s.workspaces.reduce(
      (count, workspace) =>
        count +
        workspace.terminals.filter((terminal) => diesOnAppRestart(workspace, terminal)).length,
      0
    )
  );

  // Background downloads stay quiet; surface the update once it is ready to install, or to
  // download where Komla can't install it itself.
  const slot = useBannerSlot(
    'update',
    BANNER_PRIORITY.update,
    !dismissed && (status === 'ready' || status === 'manual')
  );
  if (!slot.visible) {
    return null;
  }

  const whatsNew = releaseNotes && (
    <BannerAction variant="ghost" onClick={() => setReleaseNotesOpen(true)}>
      What's new
    </BannerAction>
  );

  if (status === 'manual') {
    return (
      <>
        <Banner
          tone="info"
          icon={<ArrowCircleUp className="size-4" />}
          title={`Komla v${version} is available.`}
          actions={
            <>
              {whatsNew}
              <BannerAction onClick={openDownload}>
                <Download className="size-3" />
                Download
              </BannerAction>
            </>
          }
          pager={slot.pager}
          onDismiss={dismiss}
          dismissLabel="Dismiss update notice"
        >
          This copy can't update itself because it doesn't run from its AppImage file. Download the
          new AppImage and run that file, and later versions will install on their own.
        </Banner>
        <ReleaseNotesDialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} />
      </>
    );
  }

  const handleRestart = () => {
    if (runningTerminalCount > 0) {
      setConfirmRestartOpen(true);
    } else {
      installUpdate();
    }
  };

  return (
    <>
      <Banner
        tone="info"
        icon={<ArrowCircleUp className="size-4" />}
        title={`Komla v${version} is ready to install.`}
        actions={
          <>
            {whatsNew}
            <BannerAction onClick={handleRestart}>
              <ArrowsClockwise className="size-3" />
              Restart to update
            </BannerAction>
          </>
        }
        pager={slot.pager}
        onDismiss={dismiss}
        dismissLabel="Dismiss update notice"
      >
        It also installs when you quit.
      </Banner>

      <ReleaseNotesDialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} />

      <Dialog open={confirmRestartOpen} onOpenChange={setConfirmRestartOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart to update?</DialogTitle>
            <DialogDescription>
              {runningTerminalCount === 1
                ? '1 terminal is still running and will be stopped'
                : `${runningTerminalCount} terminals are still running and will be stopped`}
              , including any agents working in them. If you don't restart now, the update installs
              automatically when you quit Komla.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRestartOpen(false)}>
              Not now
            </Button>
            <Button
              onClick={() => {
                setConfirmRestartOpen(false);
                installUpdate();
              }}
            >
              Restart now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
