/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalUrl = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/lib/open-terminal-url', () => ({ openTerminalUrl }));

import { openVirtualDesktop } from '../../../src/renderer/lib/virtual-desktops';
import { useDevPreviewOffersStore } from '../../../src/renderer/stores/dev-preview-offers.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';

const openVirtualDesktopInVncApp = vi.fn();
const desktop = {
  vncPort: 5901,
  url: 'http://127.0.0.1:6081/vnc.html?password=pa55word',
  app: 'xterm',
  vncApp: 'Screen Sharing',
  shownAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useDevPreviewOffersStore.setState({ offers: {}, pending: {} });
  openVirtualDesktopInVncApp.mockResolvedValue(undefined);
  (window as unknown as { api: unknown }).api = { openVirtualDesktopInVncApp };
});

describe('openVirtualDesktop', () => {
  it('opens the desktop in the VNC app, and stops the workspace asking about it', () => {
    useDevPreviewOffersStore.getState().offer('ws-1', { kind: 'desktop', desktop });

    openVirtualDesktop('ws-1', desktop, 'vnc-app');

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-1', 5901);
    expect(useDevPreviewOffersStore.getState().pending).toEqual({});
  });

  it("opens the desktop's page in Komla", () => {
    openVirtualDesktop('ws-1', desktop, 'preview');

    expect(openTerminalUrl).toHaveBeenCalledWith(desktop.url, 'preview', {
      workspaceId: 'ws-1',
      executionLocation: 'workspace',
    });
    expect(openVirtualDesktopInVncApp).not.toHaveBeenCalled();
  });

  it('says why the VNC app could not open it', async () => {
    openVirtualDesktopInVncApp.mockRejectedValue(new Error('no route'));

    openVirtualDesktop('ws-1', desktop, 'vnc-app');

    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toContain(
        'Couldn’t open the desktop in Screen Sharing'
      )
    );
  });
});
