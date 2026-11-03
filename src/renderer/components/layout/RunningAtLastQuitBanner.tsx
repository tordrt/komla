import { ClockCounterClockwise } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { Banner, BannerAction } from '@/components/ui/banner';
import {
  loadWorkspacesRunningAtLastQuit,
  restartWorkspacesRunningAtLastQuit,
} from '@/lib/running-at-last-quit';
import { useConfigStore } from '@/stores/config.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { getWorkspaceDynamicTitle } from '../../../shared/lib/workspace-title';

import type { Workspace } from '@/types';

const NAMES_SHOWN = 3;

function workspaceTitle(workspace: Workspace): string {
  return workspace.customName || getWorkspaceDynamicTitle(workspace) || workspace.name;
}

function describeWorkspaces(workspaces: Workspace[]): string {
  const names = workspaces.slice(0, NAMES_SHOWN).map(workspaceTitle);
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
  const [offered, setOffered] = useState<Workspace[]>([]);
  const checked = useRef(false);

  useEffect(() => {
    if (!configLoaded || !workspacesLoaded || checked.current) return;
    checked.current = true;
    void loadWorkspacesRunningAtLastQuit().then((workspaces) => {
      if (workspaces.length === 0) return;
      if (mode === 'never') {
        void window.api.forgetWorkspacesRunningAtLastQuit();
      } else if (mode === 'always') {
        void restartWorkspacesRunningAtLastQuit(workspaces.map((w) => w.id));
      } else {
        setOffered(workspaces);
      }
    });
  }, [configLoaded, workspacesLoaded, mode]);

  const slot = useBannerSlot(
    'running-at-last-quit',
    BANNER_PRIORITY.runningAtLastQuit,
    offered.length > 0
  );
  if (!slot.visible) return null;

  const dismiss = () => {
    setOffered([]);
    void window.api.forgetWorkspacesRunningAtLastQuit();
  };
  const restart = () => {
    setOffered([]);
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
      onDismiss={dismiss}
      dismissLabel="Dismiss workspaces running at last quit"
    >
      {describeWorkspaces(offered)}
    </Banner>
  );
}
