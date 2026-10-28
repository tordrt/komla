import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { getApplicationNameForProtocol: vi.fn(() => '') },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock('electron', () => electron);

const forwards = vi.hoisted(() => ({ startVncForward: vi.fn(async () => 61_234) }));

vi.mock('../../../src/main/services/ssh-port-forward.service', () => ({
  sshPortForwardService: forwards,
}));

const workspaces = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(() => [] as unknown[]),
  update: vi.fn((id: string, updates: object) => ({ id, ...updates })),
  broadcastWorkspaceUpdate: vi.fn(),
}));

vi.mock('../../../src/main/services/workspace.service', () => ({ workspaceService: workspaces }));

import {
  forgetVirtualDesktops,
  openSavedDesktopInVncApp,
} from '../../../src/main/services/virtual-desktop.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forgetVirtualDesktops', () => {
  it('forgets the stopped desktops shown before the check, but not one shown since', () => {
    workspaces.get.mockReturnValue({
      id: 'ws-1',
      virtualDesktops: [
        // Shown after the check began, as its display reused a stopped desktop's port.
        { vncPort: 5901, app: 'gedit', shownAt: 2_000 },
        { vncPort: 5903, app: 'xterm', shownAt: 500 },
        { vncPort: 5904, app: 'xclock', shownAt: 500 },
      ],
    });

    forgetVirtualDesktops('ws-1', [5901, 5903], 1_000);

    const kept = [
      { vncPort: 5901, app: 'gedit', shownAt: 2_000 },
      { vncPort: 5904, app: 'xclock', shownAt: 500 },
    ];
    expect(workspaces.update).toHaveBeenCalledWith('ws-1', { virtualDesktops: kept });
    expect(workspaces.broadcastWorkspaceUpdate).toHaveBeenCalledWith({
      id: 'ws-1',
      virtualDesktops: kept,
    });
  });

  it('leaves the workspace alone when none of its desktops stopped', () => {
    workspaces.get.mockReturnValue({
      id: 'ws-1',
      virtualDesktops: [{ vncPort: 5901, shownAt: 2_000 }],
    });

    forgetVirtualDesktops('ws-1', [5901, 5902], 1_000);
    workspaces.get.mockReturnValue(undefined);
    forgetVirtualDesktops('gone', [5901], 1_000);

    expect(workspaces.update).not.toHaveBeenCalled();
    expect(workspaces.broadcastWorkspaceUpdate).not.toHaveBeenCalled();
  });
});

describe('openSavedDesktopInVncApp', () => {
  const onHost = (id: string, hostId: string, ports: number[]) => ({
    id,
    backend: { kind: 'ssh', hostId },
    virtualDesktops: ports.map((vncPort) => ({ vncPort, vncPassword: 'pa55word', shownAt: 1 })),
  });

  it("opens a saved desktop with its password, keeping forwards to that host's other desktops", async () => {
    const workspace = onHost('ws-1', 'host-1', [5901]);
    workspaces.get.mockReturnValue(workspace);
    workspaces.list.mockReturnValue([
      workspace,
      onHost('ws-2', 'host-1', [5903]),
      onHost('ws-3', 'host-2', [5904]),
    ]);

    await openSavedDesktopInVncApp('ws-1', 5901);

    expect(forwards.startVncForward).toHaveBeenCalledWith('host-1', 5901, [5901, 5903]);
    expect(electron.shell.openExternal).toHaveBeenCalledWith('vnc://:pa55word@127.0.0.1:61234');
  });

  it('refuses a desktop the workspace no longer lists', async () => {
    workspaces.get.mockReturnValue(onHost('ws-1', 'host-1', [5901]));

    await expect(openSavedDesktopInVncApp('ws-1', 5902)).rejects.toThrow('no longer running');
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });
});
