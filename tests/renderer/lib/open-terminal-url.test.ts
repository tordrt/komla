/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAllLeaves } from '../../../src/renderer/lib/layout-utils';
import { openTerminalUrl } from '../../../src/renderer/lib/open-terminal-url';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';
import { useSshHostsStore } from '../../../src/renderer/stores/ssh-hosts.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { SshHost, SshLinkForward, Workspace } from '../../../src/shared/types';

const openExternal = vi.fn();
const startSshLinkForward = vi.fn();
const stopSshLinkForward = vi.fn();
const updateWorkspace = vi.fn();

function forwardTo(localPort: number, remotePort: number, started = false): SshLinkForward {
  return {
    id: 'forward-1',
    workspaceId: 'ssh-ws',
    localUrl: `http://127.0.0.1:${localPort}`,
    localPort,
    remotePort,
    started,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  openExternal.mockResolvedValue(undefined);
  stopSshLinkForward.mockResolvedValue(undefined);
  updateWorkspace.mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
  useSshHostsStore.setState({ hosts: [{ id: 'devbox', name: 'Devbox' } as SshHost] });
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'ssh-ws', backend: { kind: 'ssh', hostId: 'devbox' } },
      { id: 'local-ws', backend: { kind: 'local' } },
    ] as unknown as Workspace[],
  });
  (window as unknown as { api: unknown }).api = {
    openExternal,
    startSshLinkForward,
    stopSshLinkForward,
    updateWorkspace,
  };
});

describe('openTerminalUrl in the default browser', () => {
  it('opens a localhost link from an SSH host through a tunnel, at the same host name', async () => {
    startSshLinkForward.mockResolvedValue(forwardTo(5174, 5173));

    openTerminalUrl('http://localhost:5173/app?tab=2#top', 'external', { workspaceId: 'ssh-ws' });

    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('http://localhost:5174/app?tab=2#top')
    );
    expect(startSshLinkForward).toHaveBeenCalledWith('ssh-ws', 5173, 'http');
    // A forward the host already had serves it, so there's nothing new to stop.
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('says when it forwards a port, with a way to stop it', async () => {
    startSshLinkForward.mockResolvedValue(forwardTo(3000, 3000, true));

    openTerminalUrl('http://localhost:3000', 'external', { workspaceId: 'ssh-ws' });

    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts).toMatchObject([
        {
          type: 'info',
          message: 'Port 3000 on Devbox is forwarded to localhost:3000',
          action: { label: 'Stop' },
        },
      ])
    );
    expect(openExternal).toHaveBeenCalledWith('http://localhost:3000/');
    useToastStore.getState().toasts[0]!.action!.onClick();
    expect(stopSshLinkForward).toHaveBeenCalledWith('ssh-ws', 'forward-1');
  });

  it('shows progress while the tunnel takes a while to start', async () => {
    let finishForward: (forward: SshLinkForward) => void = () => {};
    startSshLinkForward.mockReturnValue(
      new Promise<SshLinkForward>((resolve) => (finishForward = resolve))
    );

    openTerminalUrl('https://127.0.0.1:8443', 'external', { workspaceId: 'ssh-ws' });

    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts).toMatchObject([
        { message: 'Forwarding port 8443 from the SSH host…', progress: true },
      ])
    );
    finishForward(forwardTo(8443, 8443));
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://127.0.0.1:8443/'));
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('says why when the tunnel fails, and opens nothing', async () => {
    startSshLinkForward.mockRejectedValue(
      new Error(
        "Error invoking remote method 'workspace:start-ssh-link-forward': Error: Remote port 3000 on this SSH host is already forwarded by another workspace."
      )
    );

    openTerminalUrl('http://0.0.0.0:3000', 'external', { workspaceId: 'ssh-ws' });

    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts).toMatchObject([
        {
          type: 'error',
          message:
            "Couldn't open http://localhost:3000/: Remote port 3000 on this SSH host is already forwarded by another workspace.",
        },
      ])
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens other links from an SSH host, and links from this computer, as they are', () => {
    openTerminalUrl('https://example.com/docs', 'external', { workspaceId: 'ssh-ws' });
    openTerminalUrl('http://localhost:5173', 'external', {
      workspaceId: 'ssh-ws',
      executionLocation: 'local-mirror',
    });
    openTerminalUrl('http://localhost:3000', 'external', { workspaceId: 'local-ws' });
    openTerminalUrl('http://localhost:4000', 'external', {});

    expect(openExternal.mock.calls).toEqual([
      ['https://example.com/docs'],
      ['http://localhost:5173'],
      ['http://localhost:3000'],
      ['http://localhost:4000'],
    ]);
    expect(startSshLinkForward).not.toHaveBeenCalled();
  });

  it("stops the tunnel it started when the default browser can't open the page", async () => {
    startSshLinkForward.mockResolvedValue(forwardTo(3000, 3000, true));
    openExternal.mockRejectedValue(new Error('No default browser'));

    openTerminalUrl('http://localhost:3000', 'external', { workspaceId: 'ssh-ws' });

    await vi.waitFor(() => expect(stopSshLinkForward).toHaveBeenCalledWith('ssh-ws', 'forward-1'));
    expect(useToastStore.getState().toasts).toMatchObject([
      { type: 'error', message: "Couldn't open http://localhost:3000: No default browser" },
    ]);
  });

  it('says why when the default browser cannot open a link', async () => {
    openExternal.mockRejectedValue(new Error('No application is registered for this link'));

    openTerminalUrl('vscode://file/tmp/a.ts', 'external', { workspaceId: 'ssh-ws' });

    await vi.waitFor(() =>
      expect(useToastStore.getState().toasts).toMatchObject([
        {
          type: 'error',
          message:
            "Couldn't open vscode://file/tmp/a.ts: No application is registered for this link",
        },
      ])
    );
  });
});

describe('openTerminalUrl and recent links', () => {
  it("adds a link to another site to the workspace's recent links, wherever it opens", () => {
    openTerminalUrl('https://github.com/acme/app/pull/3', 'external', { workspaceId: 'local-ws' });

    const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === 'local-ws');
    expect(workspace?.recentLinks).toEqual([
      { url: 'https://github.com/acme/app/pull/3', openedAt: expect.any(Number) },
    ]);
    expect(updateWorkspace).toHaveBeenCalledWith('local-ws', {
      recentLinks: workspace?.recentLinks,
    });
  });

  it('leaves a localhost link to the running servers list', () => {
    openTerminalUrl('http://localhost:3000/', 'external', { workspaceId: 'local-ws' });

    expect(updateWorkspace).not.toHaveBeenCalled();
  });
});

describe('openTerminalUrl in Komla', () => {
  beforeEach(() => {
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    usePaneSurfacesStore.setState({ surfaces: {} });
    useLayoutStore.getState().setCurrentWorkspace('local-ws', 'term-1');
  });

  function browserPages(): string[] {
    return Object.values(usePaneSurfacesStore.getState().surfaces).flatMap((surface) =>
      surface.kind === 'browser' ? surface.browserTabs.map((tab) => tab.url) : []
    );
  }

  it("opens a link in the workspace's browser, a tab of its own at first", () => {
    openTerminalUrl('http://localhost:5173/', 'preview', {
      workspaceId: 'local-ws',
      executionLocation: 'workspace',
    });
    openTerminalUrl('https://example.com/', 'preview', { workspaceId: 'local-ws' });

    expect(useLayoutStore.getState().tabsByWorkspace['local-ws']).toHaveLength(2);
    expect(browserPages()).toEqual(['http://localhost:5173/', 'https://example.com/']);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens a link in a new browser split beside the focused pane', () => {
    openTerminalUrl(
      'https://example.com/',
      { kind: 'split', direction: 'vertical' },
      { workspaceId: 'local-ws' }
    );

    const root = useLayoutStore.getState().layoutsByTab['local-ws']['term-1'];
    expect(getAllLeaves(root).map((leaf) => leaf.terminalId)[0]).toBe('term-1');
    expect(getAllLeaves(root)).toHaveLength(2);
    expect(browserPages()).toEqual(['https://example.com/']);
  });
});
