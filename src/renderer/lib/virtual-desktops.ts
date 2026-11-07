import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { openTerminalUrl } from '@/lib/open-terminal-url';
import { settleVirtualDesktopOffer } from '@/stores/dev-preview-offers.store';
import { useToastStore } from '@/stores/toast.store';

import type { WorkspaceVirtualDesktop } from '../../shared/types';
import type { OpenInTarget } from '@/components/terminal/OpenInPaneMenu';

/**
 * Where a virtual desktop opens: the VNC app, or in Komla where a page opens. Never the default
 * browser, which would keep its page's address, password included, in its history.
 */
export type VirtualDesktopTarget = 'vnc-app' | Exclude<OpenInTarget, 'external'>;

/** Where a click opens the desktop: in this computer's VNC app if it has one, else Komla's browser. */
export function defaultVirtualDesktopTarget(
  desktop: WorkspaceVirtualDesktop
): VirtualDesktopTarget {
  return desktop.vncApp || !desktop.url ? 'vnc-app' : 'preview';
}

/**
 * Opens a virtual desktop of the workspace, which on an SSH host is forwarded here first, and
 * stops the workspace asking where to open it.
 */
export function openVirtualDesktop(
  workspaceId: string,
  desktop: WorkspaceVirtualDesktop,
  target: VirtualDesktopTarget
): void {
  settleVirtualDesktopOffer(workspaceId, desktop.vncPort);
  if (target !== 'vnc-app' && desktop.url) {
    openTerminalUrl(desktop.url, target, { workspaceId, executionLocation: 'workspace' });
    return;
  }
  window.api.openVirtualDesktopInVncApp(workspaceId, desktop.vncPort).catch((error: unknown) => {
    useToastStore
      .getState()
      .addToast(
        `Couldn’t open the desktop in ${desktop.vncApp ?? 'the VNC app'}: ${ipcErrorMessage(error)}`,
        'error'
      );
  });
}
