/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalUrl = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/lib/open-terminal-url', () => ({ openTerminalUrl }));

import { announceVirtualDesktop } from '../../../src/renderer/lib/virtual-desktops';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../src/shared/types';

const openVirtualDesktopInVncApp = vi.fn();
const selectWorkspace = vi.fn(async () => {});
const desktop = {
  vncPort: 5901,
  url: 'http://127.0.0.1:6081/vnc.html?password=pa55word',
  app: 'xterm',
  shownAt: 1,
};

/** The one toast shown. */
function shownToast() {
  const [toast] = useToastStore.getState().toasts;
  expect(useToastStore.getState().toasts).toHaveLength(1);
  return toast!;
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useLayoutStore.setState({ currentWorkspaceId: 'ws-1' });
  useWorkspacesStore.setState({
    workspaces: [{ id: 'ws-2', name: 'billing-fix', terminals: [] }] as unknown as Workspace[],
    selectWorkspace,
  });
  openVirtualDesktopInVncApp.mockResolvedValue(undefined);
  (window as unknown as { api: unknown }).api = { openVirtualDesktopInVncApp };
});

describe('announceVirtualDesktop', () => {
  it('says the desktop is ready and opens it in the VNC app from its button', () => {
    announceVirtualDesktop('ws-1', { ...desktop, vncApp: 'Screen Sharing' });

    const toast = shownToast();
    expect(toast.message).toBe('xterm is running on virtual desktop :1.');
    expect(toast.action?.label).toBe('Open in Screen Sharing');
    toast.action?.onClick();
    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-1', 5901);
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it("names another workspace's desktop, and shows that workspace to open its page", () => {
    announceVirtualDesktop('ws-2', desktop);

    const toast = shownToast();
    expect(toast.message).toBe('xterm is running on virtual desktop :1 in billing-fix.');
    expect(toast.action?.label).toBe('Open');
    toast.action?.onClick();
    expect(selectWorkspace).toHaveBeenCalledWith('ws-2');
    expect(openTerminalUrl).toHaveBeenCalledWith(desktop.url, 'preview', {
      workspaceId: 'ws-2',
      executionLocation: 'workspace',
    });
  });
});
