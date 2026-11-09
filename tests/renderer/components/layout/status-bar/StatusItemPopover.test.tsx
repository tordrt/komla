/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentItemPopover } from '../../../../../src/renderer/components/layout/status-bar/StatusItemPopover';
import { useSshHostsStore } from '../../../../../src/renderer/stores/ssh-hosts.store';
import { useToastStore } from '../../../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';

import type { SshHost, SshLinkForward, Workspace } from '../../../../../src/shared/types';
import type { WindowStatusItem } from '../../../../../src/shared/types/status-items';

const openExternal = vi.fn();
const startSshLinkForward = vi.fn();

function item(workspaceId: string, link: string): WindowStatusItem {
  return {
    id: 'ci',
    workspaceId,
    text: 'CI 2/4',
    link,
    updatedAt: 0,
  } as WindowStatusItem;
}

beforeEach(() => {
  vi.clearAllMocks();
  openExternal.mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
  useSshHostsStore.setState({
    hosts: [{ id: 'devbox', name: 'Devbox' } as SshHost],
  });
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'ssh-ws', backend: { kind: 'ssh', hostId: 'devbox' } },
      { id: 'local-ws', backend: { kind: 'local' } },
    ] as unknown as Workspace[],
  });
  (window as unknown as { api: unknown }).api = {
    openExternal,
    startSshLinkForward,
    stopSshLinkForward: vi.fn().mockResolvedValue(undefined),
  };
});

describe('AgentItemPopover link button', () => {
  it('opens a localhost link of an SSH workspace through a tunnel to the host', async () => {
    startSshLinkForward.mockResolvedValue({
      id: 'forward-1',
      workspaceId: 'ssh-ws',
      localUrl: 'http://127.0.0.1:5174',
      localPort: 5174,
      remotePort: 5173,
      started: false,
    } satisfies SshLinkForward);
    render(<AgentItemPopover item={item('ssh-ws', 'http://localhost:5173/ci-run.html')} />);

    fireEvent.click(screen.getByRole('button', { name: /open localhost/i }));

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('http://localhost:5174/ci-run.html')
    );
    expect(startSshLinkForward).toHaveBeenCalledWith('ssh-ws', 5173, 'http');
  });

  it('tunnels a link to an all-interfaces address as it does one to localhost', async () => {
    startSshLinkForward.mockResolvedValue({
      id: 'forward-1',
      workspaceId: 'ssh-ws',
      localUrl: 'http://127.0.0.1:5174',
      localPort: 5174,
      remotePort: 5173,
      started: false,
    } satisfies SshLinkForward);
    render(<AgentItemPopover item={item('ssh-ws', 'http://0.0.0.0:5173/ci-run.html')} />);

    fireEvent.click(screen.getByRole('button', { name: /open/i }));

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('http://localhost:5174/ci-run.html')
    );
  });

  it('opens a link of a local workspace as it is', async () => {
    render(<AgentItemPopover item={item('local-ws', 'http://localhost:5173/ci-run.html')} />);

    fireEvent.click(screen.getByRole('button', { name: /open localhost/i }));

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/ci-run.html')
    );
    expect(startSshLinkForward).not.toHaveBeenCalled();
  });
});
