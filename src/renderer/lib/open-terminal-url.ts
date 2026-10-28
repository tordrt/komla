import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { openBrowserPane, openInBrowserPane, type PaneSurfacePlacement } from '@/lib/pane-surfaces';
import { recordOpenedRecentLink } from '@/lib/recent-links';
import { parseLoopbackForwardIntent } from '@/lib/scan-terminal-urls';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

import { normalizeLocalDevServerUrl } from '../../shared/lib/loopback-url';
import { isLocalTerminalExecutionLocation } from '../../shared/types/terminal';

import type { TerminalExecutionLocation } from '../../shared/types/terminal';

// Starting a tunnel usually takes a moment; past this, a toast says it's under way.
const FORWARD_PROGRESS_DELAY_MS = 300;

interface TerminalUrlContext {
  workspaceId?: string | null;
  executionLocation?: TerminalExecutionLocation;
}

/**
 * Opens a terminal link in the default browser, or in Komla: in the workspace's browser
 * (`'preview'`), or in a new browser where `target` places it. A localhost link from a
 * terminal on an SSH host opens through a tunnel to that host. A link to another site
 * joins the workspace's recent links.
 */
export function openTerminalUrl(
  url: string,
  target: 'preview' | 'external' | PaneSurfacePlacement,
  context: TerminalUrlContext
): void {
  const normalized = normalizeLocalDevServerUrl(url);
  const { workspaceId } = context;
  if (workspaceId) recordOpenedRecentLink(workspaceId, normalized);
  const executionLocation = context.executionLocation ?? 'workspace';
  if (target === 'external' || !workspaceId) {
    void openExternally(normalized, context);
  } else if (target === 'preview') {
    openInBrowserPane(workspaceId, normalized, executionLocation);
  } else {
    openBrowserPane(workspaceId, target, normalized, executionLocation);
  }
}

async function openExternally(
  url: string,
  { workspaceId, executionLocation }: TerminalUrlContext
): Promise<void> {
  const toasts = useToastStore.getState();
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const intent = parseLoopbackForwardIntent(url);
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let progressToastId: string | undefined;
  let startedForwardId: string | undefined;
  try {
    if (
      !workspace ||
      !isSshWorkspace(workspace) ||
      isLocalTerminalExecutionLocation(executionLocation) ||
      !intent
    ) {
      await window.api.openExternal(url);
      return;
    }
    progressTimer = setTimeout(() => {
      progressToastId = toasts.addToast(
        `Forwarding port ${intent.remotePort} from the SSH host…`,
        'info',
        { dismissOnTimeout: false, progress: true }
      );
    }, FORWARD_PROGRESS_DELAY_MS);
    const forward = await window.api.startSshLinkForward(
      workspace.id,
      intent.remotePort,
      intent.scheme
    );
    if (forward.started) startedForwardId = forward.id;
    // Only the port changes, so the page keeps its origin's host name, which cookies,
    // certificates and sign-in redirects are tied to.
    const forwarded = new URL(url);
    forwarded.port = String(forward.localPort);
    await window.api.openExternal(forwarded.toString());
    if (forward.started) {
      // Nothing else shows the tunnel, which runs until the workspace stops.
      const hostName =
        useSshHostsStore.getState().hosts.find((host) => host.id === workspace.backend.hostId)
          ?.name ?? 'the SSH host';
      toasts.addToast(
        `Port ${intent.remotePort} on ${hostName} is forwarded to ${forwarded.host}`,
        'info',
        {
          action: {
            label: 'Stop',
            onClick: () => {
              window.api.stopSshLinkForward(workspace.id, forward.id).catch((error: unknown) => {
                toasts.addToast(
                  `Couldn't stop forwarding port ${intent.remotePort}: ${ipcErrorMessage(error)}`,
                  'error'
                );
              });
            },
          },
        }
      );
    }
  } catch (error) {
    // A tunnel whose page didn't open would run unseen until the workspace stops.
    if (workspace && startedForwardId) {
      window.api.stopSshLinkForward(workspace.id, startedForwardId).catch(() => {});
    }
    toasts.addToast(`Couldn't open ${url}: ${ipcErrorMessage(error)}`, 'error');
  } finally {
    clearTimeout(progressTimer);
    if (progressToastId) toasts.removeToast(progressToastId);
  }
}
