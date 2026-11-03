import { ClockCounterClockwise } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { Banner, BannerAction } from '@/components/ui/banner';
import {
  awaitsRestart,
  forgetWorkspacesRunningAtLastQuit,
  offerableInThisWindow,
  restartWorkspacesRunningAtLastQuit,
} from '@/lib/running-at-last-quit';
import { useConfigStore } from '@/stores/config.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { getWorkspaceDisplayTitle } from '../../../shared/lib/workspace-title';

import type { Workspace } from '@/types';

const NAMES_SHOWN = 3;

function describeWorkspaces(workspaces: Workspace[]): string {
  const names = workspaces.slice(0, NAMES_SHOWN).map(getWorkspaceDisplayTitle);
  const more = workspaces.length - names.length;
  return more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', ');
}

/**
 * At launch, offers to restart the local workspaces that were running when Komla last quit, or
 * restarts them without asking when the setting says so.
 */
export function RunningAtLastQuitBanner() {
  const mode = useConfigStore((s) => s.config?.restoreRunningWorkspaces);
  const configLoaded = useConfigStore((s) => s.config !== null && !s.isLoading);
  const workspacesLoaded = useWorkspacesStore((s) => s.hasLoaded);
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const [offeredIds, setOfferedIds] = useState<string[]>([]);
  const checked = useRef(false);
  // Ids that left the offer this launch, as by a restart; one stopped again doesn't return.
  const left = useRef(new Set<string>());
  const offered = useWorkspacesStore(
    useShallow((s) => {
      if (offeredIds.length === 0) return [];
      const byId = new Map(s.workspaces.map((w) => [w.id, w]));
      return offeredIds
        .filter((id) => !left.current.has(id))
        .map((id) => byId.get(id))
        .filter((w) => awaitsRestart(w, s.restartingWorkspaceIds));
    })
  );
  for (const id of offeredIds) {
    if (!offered.some((w) => w.id === id)) left.current.add(id);
  }

  /** Declines restarting them: an explicit answer, which main remembers. */
  const decline = (ids: string[]) => {
    forgetWorkspacesRunningAtLastQuit(ids);
    setOfferedIds([]);
  };

  useEffect(() => {
    if (!configLoaded || !workspacesLoaded || checked.current) return;
    checked.current = true;
    Promise.resolve()
      .then(() => window.api.listWorkspacesRunningAtLastQuit())
      .then((ids) => {
        // Never declines all of them, also those of other windows.
        if (mode === 'never') return forgetWorkspacesRunningAtLastQuit(ids);
        const here = offerableInThisWindow(ids);
        if (here.length === 0) return;
        if (mode === 'always') void restartWorkspacesRunningAtLastQuit(here);
        else setOfferedIds(here);
      })
      .catch(() => {
        // Nothing to offer this launch; main keeps the offer for the next one.
      });
  }, [configLoaded, workspacesLoaded, mode]);

  // Choosing Never from the banner's own Settings button declines what it offers.
  const shownCount = offered.length;
  useEffect(() => {
    if (mode === 'never' && shownCount > 0) {
      forgetWorkspacesRunningAtLastQuit(offeredIds);
      setOfferedIds([]);
    }
  }, [mode, shownCount, offeredIds]);

  const slot = useBannerSlot(
    'running-at-last-quit',
    BANNER_PRIORITY.runningAtLastQuit,
    offered.length > 0
  );
  if (!slot.visible) return null;

  const restart = () => {
    setOfferedIds([]);
    void restartWorkspacesRunningAtLastQuit(offered.map((w) => w.id));
  };
  const count = offered.length;

  return (
    <Banner
      tone="neutral"
      icon={<ClockCounterClockwise className="size-4" />}
      title={
        count === 1
          ? '1 workspace was running when Komla quit.'
          : `${count} workspaces were running when Komla quit.`
      }
      actions={
        <>
          <BannerAction
            variant="ghost"
            onClick={() => openSettings({ tab: 'general', card: 'Startup' })}
          >
            Settings
          </BannerAction>
          <BannerAction onClick={restart}>
            {count === 1 ? 'Restart it' : 'Restart all'}
          </BannerAction>
        </>
      }
      pager={slot.pager}
      onDismiss={() => decline(offeredIds)}
      dismissLabel="Dismiss workspaces running at last quit"
    >
      {describeWorkspaces(offered)}
    </Banner>
  );
}
