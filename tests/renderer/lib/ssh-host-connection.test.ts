/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { followSshHostConnections } from '../../../src/renderer/lib/ssh-host-connection';
import { useConfigStore } from '../../../src/renderer/stores/config.store';
import { useDevServerPreviewStore } from '../../../src/renderer/stores/dev-server-preview.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';
import { createSshWorkspace } from '../../factories';

import type { AppConfig } from '../../../src/renderer/types';

const activeForward = (workspaceId: string, localPort: number) => ({
  status: 'active' as const,
  requestId: 1,
  remotePort: 3000,
  savedUrl: 'http://localhost:3000/',
  forward: {
    id: `forward-${workspaceId}`,
    workspaceId,
    localUrl: `http://127.0.0.1:${localPort}`,
    localPort,
    remotePort: 3000,
  },
});

function disconnectedFrom(...hostIds: string[]): void {
  useConfigStore.setState({
    config: { disconnectedSshHostIds: hostIds } as unknown as AppConfig,
  });
}

describe('followSshHostConnections', () => {
  let stop: () => void;

  beforeEach(() => {
    disconnectedFrom();
    useWorkspacesStore.setState({
      workspaces: [
        createSshWorkspace({ id: 'ws-dev' }),
        createSshWorkspace({
          id: 'ws-other',
          backend: { ...createSshWorkspace().backend, hostId: 'other' } as never,
        }),
      ],
    });
    useDevServerPreviewStore.setState({
      remoteForwardByWorkspace: {
        'ws-dev': activeForward('ws-dev', 53001),
        'ws-other': activeForward('ws-other', 53002),
      },
    });
    stop = followSshHostConnections();
  });

  afterEach(() => {
    stop();
    useDevServerPreviewStore.setState({ remoteForwardByWorkspace: {} });
    useConfigStore.setState({ config: null });
  });

  it('shows the host’s browser tab tunnels stopped once disconnected, in any window, and forwards them again on connecting', () => {
    disconnectedFrom('ssh-host-1');

    const afterDisconnect = useDevServerPreviewStore.getState().remoteForwardByWorkspace;
    expect(afterDisconnect['ws-dev']).toMatchObject({ status: 'stopped' });
    expect(afterDisconnect['ws-other']).toMatchObject({ status: 'active' });

    disconnectedFrom();

    const afterConnect = useDevServerPreviewStore.getState().remoteForwardByWorkspace;
    // Nothing recorded, so each forwards again as it's shown.
    expect(afterConnect['ws-dev']).toBeUndefined();
    expect(afterConnect['ws-other']).toMatchObject({ status: 'active' });
  });

  it('leaves tunnels alone when other settings change, or the config is not known', () => {
    disconnectedFrom('ssh-host-1');
    useConfigStore.setState({
      config: { disconnectedSshHostIds: ['ssh-host-1'], theme: 'dark' } as unknown as AppConfig,
    });
    // As when loading the config failed.
    useConfigStore.setState({ config: {} as AppConfig });

    expect(useDevServerPreviewStore.getState().remoteForwardByWorkspace['ws-dev']).toMatchObject({
      status: 'stopped',
    });
  });
});
