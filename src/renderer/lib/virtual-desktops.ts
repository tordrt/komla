import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { openTerminalUrl } from '@/lib/open-terminal-url';
import { useLayoutStore } from '@/stores/layout.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { virtualDesktopDisplay } from '../../shared/lib/virtual-desktops';
import { getWorkspaceDisplayTitle } from '../../shared/lib/workspace-title';

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

/** Opens a virtual desktop of the workspace, which on an SSH host is forwarded here first. */
export function openVirtualDesktop(
  workspaceId: string,
  desktop: WorkspaceVirtualDesktop,
  target: VirtualDesktopTarget
): void {
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

/**
 * Says a desktop `komla desktop run` started without opening it is ready, with a button that
 * opens it as its row would. A page opens in its workspace, which then comes into view.
 */
export function announceVirtualDesktop(
  workspaceId: string,
  desktop: WorkspaceVirtualDesktop
): void {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
  const elsewhere = useLayoutStore.getState().currentWorkspaceId !== workspaceId;
  const where = workspace && elsewhere ? ` in ${getWorkspaceDisplayTitle(workspace)}` : '';
  const target = defaultVirtualDesktopTarget(desktop);
  useToastStore
    .getState()
    .addToast(
      `${desktop.app ?? 'An app'} is running on virtual desktop ${virtualDesktopDisplay(desktop)}${where}.`,
      'info',
      {
        action: {
          label: desktop.vncApp ? `Open in ${desktop.vncApp}` : 'Open',
          onClick: () => {
            if (target !== 'vnc-app' && elsewhere) {
              void useWorkspacesStore.getState().selectWorkspace(workspaceId);
            }
            openVirtualDesktop(workspaceId, desktop, target);
          },
        },
      }
    );
}
