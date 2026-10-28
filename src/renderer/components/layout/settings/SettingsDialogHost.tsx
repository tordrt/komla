import { lazy, useEffect } from 'react';

import { DeferredDialog } from '@/components/ui/DeferredDialog';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';

const loadSettingsDialog = () => import('./SettingsDialog');

const SettingsDialog = lazy(() =>
  loadSettingsDialog().then((module) => ({ default: module.SettingsDialog }))
);

export function SettingsDialogHost() {
  const open = useSettingsDialogStore((s) => s.open);
  const target = useSettingsDialogStore((s) => s.target);
  const requestId = useSettingsDialogStore((s) => s.requestId);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);

  // Fetch and evaluate the settings chunk once the app is idle so the first
  // open doesn't wait on it.
  useEffect(() => {
    const id = requestIdleCallback(() => void loadSettingsDialog(), { timeout: 10_000 });
    return () => cancelIdleCallback(id);
  }, []);

  return (
    <DeferredDialog open={open}>
      <SettingsDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeSettings();
        }}
        initialTab={target.tab}
        initialGeneralSection={target.generalSection}
        initialEditProjectId={target.editProjectId}
        initialSetupProjectId={target.setupProjectId}
        initialCard={target.card}
        openRequestId={requestId}
      />
    </DeferredDialog>
  );
}
