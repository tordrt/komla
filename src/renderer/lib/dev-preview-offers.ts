import { openTerminalUrl } from '@/lib/open-terminal-url';
import { notePrintedHyperlink } from '@/lib/recent-links';
import {
  devPreviewOfferToastKey,
  useDevPreviewOffersStore,
} from '@/stores/dev-preview-offers.store';
import { useLayoutStore } from '@/stores/layout.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { getWorkspaceDisplayTitle } from '../../shared/lib/workspace-title';

import type { TerminalExecutionLocation } from '../../shared/types/terminal';

/** `localhost:5173/pricing` for `http://localhost:5173/pricing`. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * Offers a page an agent previewed with `komla preview`, without opening it: a toast opens it in
 * the default browser, through a tunnel from an SSH host, or in Komla's browser, and a dot on
 * the globe button, which lists the workspace's servers and links, marks it until the user looks.
 * A later offer in the same workspace replaces the toast, as an agent restarting its server does.
 */
export function offerDevPreview(
  workspaceId: string,
  url: string,
  executionLocation: TerminalExecutionLocation | undefined
): void {
  // A page on another site lists with the links; the globe button's list keeps one on this
  // computer, or the workspace's machine, among its servers.
  notePrintedHyperlink(workspaceId, url);
  const { offer, markSeen } = useDevPreviewOffersStore.getState();
  offer(workspaceId, { url, executionLocation: executionLocation ?? 'workspace' });

  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const elsewhere = useLayoutStore.getState().currentWorkspaceId !== workspaceId;
  const where = workspace && elsewhere ? ` in ${getWorkspaceDisplayTitle(workspace)}` : '';
  const context = { workspaceId, executionLocation };
  useToastStore.getState().addToast(`Preview ready${where}: ${shortUrl(url)}`, 'info', {
    key: devPreviewOfferToastKey(workspaceId),
    action: {
      label: 'Open in browser',
      onClick: () => {
        markSeen(workspaceId);
        openTerminalUrl(url, 'external', context);
      },
    },
    secondaryAction: {
      label: 'Open in Komla',
      onClick: () => {
        markSeen(workspaceId);
        // The page opens in its workspace, which comes into view.
        if (useLayoutStore.getState().currentWorkspaceId !== workspaceId) {
          void useWorkspacesStore.getState().selectWorkspace(workspaceId);
        }
        openTerminalUrl(url, 'preview', context);
      },
    },
  });
}
