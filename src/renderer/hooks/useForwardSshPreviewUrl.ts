import { useCallback } from 'react';

import { useBrowserTabsSource } from '@/hooks/useBrowserTabsSource';
import { updatePaneBrowserTabs } from '@/lib/browser-tabs';
import { parseLoopbackForwardIntent } from '@/lib/scan-terminal-urls';
import { useDevServerPreviewStore } from '@/stores/dev-server-preview.store';
import { isLocalTerminalExecutionLocation } from '@/types';

import { getActiveBrowserTab, setActiveBrowserTabUrl } from '../../shared/lib/browser-tabs';

/**
 * Saves a remote URL as the active browser tab's URL and forwards it over SSH.
 * Every forward goes through here: the tunnel records the tab and URL it was
 * saved for, which is how the preview tells a newer saved URL from the current one.
 * `browserId` is the browser pane's surface id.
 */
export function useForwardSshPreviewUrl(
  workspaceId: string,
  browserId: string
): (url: string) => Promise<void> {
  const tabsSource = useBrowserTabsSource(browserId);
  const startSshPreviewForward = useDevServerPreviewStore((s) => s.startSshPreviewForward);
  const activeTab = getActiveBrowserTab(tabsSource);
  const savedUrl = activeTab?.url;
  const savedUrlIsLocal = isLocalTerminalExecutionLocation(
    activeTab?.urlExecutionLocation ?? 'workspace'
  );

  return useCallback(
    async (url: string) => {
      const intent = parseLoopbackForwardIntent(url);
      if (!intent) return;
      let tabId = activeTab?.id;
      if (url !== savedUrl || savedUrlIsLocal || !tabId) {
        tabId = updatePaneBrowserTabs(browserId, (current) =>
          setActiveBrowserTabUrl(current, url, 'workspace')
        )?.activeBrowserTabId;
      }
      if (!tabId) return;
      await startSshPreviewForward(
        workspaceId,
        tabId,
        intent.remotePort,
        intent.pathSuffix,
        intent.scheme,
        url
      );
    },
    [activeTab?.id, browserId, savedUrl, savedUrlIsLocal, startSshPreviewForward, workspaceId]
  );
}
