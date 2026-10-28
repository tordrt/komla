import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, (...args: any[]) => unknown>();
const handlers = new Map<string, (...args: any[]) => unknown>();
const owner = { webContents: { id: 42 } };

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => owner) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: any[]) => unknown) => {
      listeners.set(channel, listener);
    }),
  },
}));

const service = vi.hoisted(() => ({
  capture: vi.fn(async () => 'data:image/jpeg;base64,frame'),
  clearSiteData: vi.fn(async () => true),
  close: vi.fn(),
  hide: vi.fn(),
  navigate: vi.fn(() => true),
  reload: vi.fn(() => true),
  removeSharedSessionData: vi.fn(async () => undefined),
  setProjectLookup: vi.fn(),
  sync: vi.fn(),
}));

vi.mock('../../../../src/main/services/dev-preview.service', () => ({
  devPreviewService: service,
}));

vi.mock('../../../../src/main/services/project.service', () => ({
  projectService: { get: vi.fn((id: string) => (id === 'project-of-gone' ? undefined : { id })) },
}));

vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: { get: vi.fn((id: string) => ({ id, projectId: `project-of-${id}` })) },
}));

const virtualDesktops = vi.hoisted(() => ({
  forgetVirtualDesktops: vi.fn(),
  openSavedDesktopInVncApp: vi.fn(async () => undefined),
}));

vi.mock('../../../../src/main/services/virtual-desktop.service', () => virtualDesktops);

const detector = vi.hoisted(() => ({
  detect: vi.fn(async () => ({
    services: [],
    otherServers: [],
    openPorts: [5173],
    remoteOpenPorts: [3000],
  })),
}));

vi.mock('../../../../src/main/services/dev-preview-services', () => ({
  devPreviewServiceDetector: detector,
}));

const linkPreviews = vi.hoisted(() => ({
  getPreview: vi.fn(async () => ({ title: 'Acme Admin' })),
  getImage: vi.fn(async () => 'data:image/png;base64,aW1n'),
}));

vi.mock('../../../../src/main/services/link-preview', () => ({
  linkPreviewService: linkPreviews,
}));

vi.mock('../../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { IPC } from '../../../../src/shared/constants/ipc-channels';
import { registerDevPreviewHandlers } from '../../../../src/main/ipc/handlers/dev-preview.handlers';

const event = { sender: owner.webContents };

describe('dev preview IPC handlers', () => {
  beforeEach(() => {
    listeners.clear();
    handlers.clear();
    vi.clearAllMocks();
    registerDevPreviewHandlers();
  });

  it("gives the preview service each workspace's project", () => {
    const lookup = service.setProjectLookup.mock.calls[0][0] as (id: string) => string;
    expect(lookup('workspace-1')).toBe('project-of-workspace-1');
    // Synced from another device, naming a project this machine doesn't have.
    expect(lookup('gone')).toBeUndefined();
    expect(service.removeSharedSessionData).toHaveBeenCalled();
  });

  it('syncs a validated tab page and bounds to the sender window', () => {
    listeners.get(IPC.DEV_PREVIEW_SYNC)?.(
      event,
      'workspace-1',
      'tab-1',
      'https://example.com/docs',
      {
        x: 10.5,
        y: 20,
        width: 640,
        height: 480,
      }
    );

    expect(service.sync).toHaveBeenCalledWith(
      owner,
      'workspace-1',
      'tab-1',
      'https://example.com/docs',
      {
        x: 10.5,
        y: 20,
        width: 640,
        height: 480,
      }
    );
  });

  it('drops invalid sync payloads before they reach the service', () => {
    const bounds = { x: 0, y: 0, width: 640, height: 480 };
    listeners.get(IPC.DEV_PREVIEW_SYNC)?.(
      event,
      'workspace-1',
      'tab-1',
      'file:///etc/passwd',
      bounds
    );
    listeners.get(IPC.DEV_PREVIEW_SYNC)?.(event, 'workspace-1', 'http://localhost:5173', bounds);

    expect(service.sync).not.toHaveBeenCalled();
  });

  it('hides and closes only the sender window tab', () => {
    listeners.get(IPC.DEV_PREVIEW_HIDE)?.(event, 'workspace-1', 'tab-1');
    listeners.get(IPC.DEV_PREVIEW_CLOSE)?.(event, 'workspace-1', 'tab-2');

    expect(service.hide).toHaveBeenCalledWith(42, 'workspace-1', 'tab-1');
    expect(service.close).toHaveBeenCalledWith(42, 'workspace-1', 'tab-2');
  });

  it('reloads and clears data through invoke handlers', async () => {
    await expect(
      handlers.get(IPC.DEV_PREVIEW_RELOAD)?.(event, 'workspace-1', 'tab-1', true)
    ).resolves.toBe(true);
    expect(service.reload).toHaveBeenCalledWith(42, 'workspace-1', 'tab-1', true);

    await expect(
      handlers.get(IPC.DEV_PREVIEW_CLEAR_SITE_DATA)?.(event, 'workspace-1', 'tab-1')
    ).resolves.toBe(true);
    expect(service.clearSiteData).toHaveBeenCalledWith(42, 'workspace-1', 'tab-1');
  });

  it('captures a frame of the sender window tab through a validated invoke handler', async () => {
    await expect(
      handlers.get(IPC.DEV_PREVIEW_CAPTURE)?.(event, 'workspace-1', 'tab-1')
    ).resolves.toBe('data:image/jpeg;base64,frame');
    expect(service.capture).toHaveBeenCalledWith(42, 'workspace-1', 'tab-1');

    expect(() => handlers.get(IPC.DEV_PREVIEW_CAPTURE)?.(event, 'workspace-1')).toThrow(
      'IPC validation failed'
    );
    expect(service.capture).toHaveBeenCalledTimes(1);
  });

  it('navigates preview history through a validated invoke handler', async () => {
    await expect(
      handlers.get(IPC.DEV_PREVIEW_NAVIGATE)?.(event, 'workspace-1', 'tab-1', 'back')
    ).resolves.toBe(true);
    expect(service.navigate).toHaveBeenCalledWith(42, 'workspace-1', 'tab-1', 'back');

    expect(() =>
      handlers.get(IPC.DEV_PREVIEW_NAVIGATE)?.(event, 'workspace-1', 'tab-1', 'sideways')
    ).toThrow('IPC validation failed');
    expect(service.navigate).toHaveBeenCalledTimes(1);
  });

  it('detects workspace services through a validated invoke handler', async () => {
    await expect(
      handlers.get(IPC.DEV_PREVIEW_DETECT_SERVICES)?.(event, 'workspace-1', [5173], [3000], [5901])
    ).resolves.toEqual({
      services: [],
      otherServers: [],
      openPorts: [5173],
      remoteOpenPorts: [3000],
    });
    expect(detector.detect).toHaveBeenCalledWith('workspace-1', [5173], [3000], [5901]);

    expect(() =>
      handlers.get(IPC.DEV_PREVIEW_DETECT_SERVICES)?.(event, 'workspace-1', [5173], [70000], [])
    ).toThrow('IPC validation failed');
    expect(detector.detect).toHaveBeenCalledTimes(1);
  });

  it("opens a workspace's virtual desktop in the VNC app through a validated invoke handler", async () => {
    const open = handlers.get(IPC.VIRTUAL_DESKTOP_OPEN_IN_VNC_APP);
    await expect(open?.(event, 'workspace-1', 5901)).resolves.toBeUndefined();
    expect(virtualDesktops.openSavedDesktopInVncApp).toHaveBeenCalledWith('workspace-1', 5901);

    expect(() => open?.(event, 'workspace-1', 70000)).toThrow('IPC validation failed');
    expect(virtualDesktops.openSavedDesktopInVncApp).toHaveBeenCalledTimes(1);
  });

  it('forgets the virtual desktops a check found stopped through a validated invoke handler', async () => {
    const forget = handlers.get(IPC.VIRTUAL_DESKTOP_FORGET);
    await forget?.(event, 'workspace-1', [5901, 5903], 1_000);
    expect(virtualDesktops.forgetVirtualDesktops).toHaveBeenCalledWith(
      'workspace-1',
      [5901, 5903],
      1_000
    );

    expect(() => forget?.(event, 'workspace-1', [70000], 1_000)).toThrow('IPC validation failed');
    expect(() => forget?.(event, 'workspace-1', [5901], -1)).toThrow('IPC validation failed');
    expect(virtualDesktops.forgetVirtualDesktops).toHaveBeenCalledTimes(1);
  });

  it('describes a validated page and drops fields it does not know', async () => {
    const request = { url: 'http://localhost:5173/', workspaceId: 'workspace-1', onSshHost: false };

    await expect(
      handlers.get(IPC.LINK_PREVIEW_GET)?.(event, { ...request, pid: 4242, extra: true })
    ).resolves.toEqual({ title: 'Acme Admin' });
    expect(linkPreviews.getPreview).toHaveBeenCalledWith({ ...request, pid: 4242 });

    for (const invalid of [
      { ...request, url: 'file:///etc/passwd' },
      { ...request, url: 'javascript:alert(1)' },
      { ...request, onSshHost: 'yes' },
      { ...request, pid: -1 },
    ]) {
      expect(() => handlers.get(IPC.LINK_PREVIEW_GET)?.(event, invalid)).toThrow(
        'IPC validation failed'
      );
    }
    expect(linkPreviews.getPreview).toHaveBeenCalledTimes(1);
  });

  it('fetches only http(s) images', async () => {
    await expect(
      handlers.get(IPC.LINK_PREVIEW_IMAGE)?.(event, 'https://example.com/og.png')
    ).resolves.toBe('data:image/png;base64,aW1n');

    expect(() =>
      handlers.get(IPC.LINK_PREVIEW_IMAGE)?.(event, 'file:///Users/me/secret.png')
    ).toThrow('IPC validation failed');
    expect(linkPreviews.getImage).toHaveBeenCalledTimes(1);
  });
});
