import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { disconnectedSshHostIds: [] as string[] },
  hosts: new Map<string, { id: string; name: string; hostname: string; basePath: string }>(),
  workspaces: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  closingConnections: undefined as Promise<void> | undefined,
  reconciling: undefined as Promise<void> | undefined,
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: {
    get: () => mocks.config,
    update: vi.fn((updates: Partial<typeof mocks.config>) => {
      Object.assign(mocks.config, updates);
      return mocks.config;
    }),
  },
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: { get: (hostId: string) => mocks.hosts.get(hostId) },
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: {
    list: () => mocks.workspaces,
    sshSync: {
      syncSoon: vi.fn(async (hostId: string, options: unknown) => {
        mocks.calls.push(`sync ${hostId} ${JSON.stringify(options)}`);
      }),
    },
  },
}));
vi.mock('../../../src/main/services/managed-remote-terminal-lifecycle.service', () => ({
  managedRemoteTerminalLifecycleService: {
    detach: vi.fn(({ workspaceId }: { workspaceId: string }) => {
      mocks.calls.push(`detach ${workspaceId}`);
    }),
  },
}));
vi.mock('../../../src/main/services/remote-workspace-observation.service', () => ({
  remoteWorkspaceObservationService: {
    reconcile: vi.fn(async () => {
      mocks.calls.push('reconcile observation');
      await mocks.reconciling;
    }),
  },
}));
vi.mock('../../../src/main/services/ssh-port-forward.service', () => ({
  sshPortForwardService: {
    closeHost: vi.fn(async (hostId: string) => {
      mocks.calls.push(`close tunnels ${hostId}`);
    }),
    reconcileHostPortForwards: vi.fn(async (host: { id: string }) => {
      mocks.calls.push(`saved forwards ${host.id}`);
    }),
  },
}));
vi.mock('../../../src/main/services/ssh-connection.service', () => ({
  sshConnectionService: {
    closeConnections: vi.fn(async (host: { id: string }, workspaceIds: string[]) => {
      await mocks.closingConnections;
      mocks.calls.push(`close connections ${host.id} ${workspaceIds.join(',')}`);
    }),
    checkHost: vi.fn(async (host: { id: string }) => {
      mocks.calls.push(`check ${host.id}`);
    }),
  },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    broadcastToAll: vi.fn((channel: string, config: typeof mocks.config) => {
      mocks.calls.push(`broadcast ${channel} ${config.disconnectedSshHostIds.join(',')}`);
    }),
  },
}));

function sshWorkspace(id: string, hostId: string) {
  return { id, backend: { kind: 'ssh', hostId } };
}

describe('sshHostConnectionService', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.config.disconnectedSshHostIds = [];
    mocks.calls.length = 0;
    mocks.closingConnections = undefined;
    mocks.reconciling = undefined;
    mocks.hosts.clear();
    mocks.hosts.set('dev', { id: 'dev', name: 'Dev', hostname: 'dev.test', basePath: '~/.komla' });
    mocks.hosts.set('other', {
      id: 'other',
      name: 'Other',
      hostname: 'other.test',
      basePath: '~/.komla',
    });
    mocks.workspaces = [
      sshWorkspace('ws-dev', 'dev'),
      sshWorkspace('ws-other', 'other'),
      { id: 'ws-local', backend: { kind: 'local' } },
    ];
  });

  async function load() {
    const { sshHostConnectionService } =
      await import('../../../src/main/services/ssh-host-connection.service');
    const { isSshHostDisconnected } =
      await import('../../../src/main/services/ssh-host-disconnection');
    return { sshHostConnectionService, isSshHostDisconnected };
  }

  it('remembers the hosts the user disconnected from across restarts', async () => {
    mocks.config.disconnectedSshHostIds = ['dev'];
    const { sshHostConnectionService, isSshHostDisconnected } = await load();

    sshHostConnectionService.load();

    expect(isSshHostDisconnected('dev')).toBe(true);
    expect(isSshHostDisconnected('other')).toBe(false);
  });

  it('detaches the host’s terminals and closes what Komla keeps open there', async () => {
    const { sshHostConnectionService, isSshHostDisconnected } = await load();

    await sshHostConnectionService.setConnected('dev', false);

    expect(isSshHostDisconnected('dev')).toBe(true);
    expect(mocks.config.disconnectedSshHostIds).toEqual(['dev']);
    expect(mocks.calls).toEqual([
      'broadcast config:changed dev',
      'detach ws-dev',
      'reconcile observation',
      'close tunnels dev',
      'close connections dev ws-dev',
    ]);
  });

  it('catches up with the host on connecting again', async () => {
    mocks.config.disconnectedSshHostIds = ['other', 'dev'];
    const { sshHostConnectionService, isSshHostDisconnected } = await load();
    sshHostConnectionService.load();

    await sshHostConnectionService.setConnected('dev', true);

    expect(isSshHostDisconnected('dev')).toBe(false);
    expect(mocks.config.disconnectedSshHostIds).toEqual(['other']);
    expect(mocks.calls).toEqual([
      'broadcast config:changed other',
      'saved forwards dev',
      'reconcile observation',
      'sync dev {"now":true}',
      'check dev',
    ]);
  });

  it('connects only once an earlier disconnect has closed everything', async () => {
    const { sshHostConnectionService, isSshHostDisconnected } = await load();
    let closed!: () => void;
    mocks.closingConnections = new Promise((resolve) => (closed = resolve));

    const disconnecting = sshHostConnectionService.setConnected('dev', false);
    const connecting = sshHostConnectionService.setConnected('dev', true);
    await vi.waitFor(() => expect(mocks.calls).toContain('close tunnels dev'));
    expect(isSshHostDisconnected('dev')).toBe(true);
    closed();
    await Promise.all([disconnecting, connecting]);

    expect(isSshHostDisconnected('dev')).toBe(false);
    expect(mocks.calls.slice(mocks.calls.indexOf('close connections dev ws-dev'))).toEqual([
      'close connections dev ws-dev',
      'broadcast config:changed ',
      'saved forwards dev',
      'reconcile observation',
      'sync dev {"now":true}',
      'check dev',
    ]);
  });

  it('disconnects without waiting for observation of other hosts to settle', async () => {
    const { sshHostConnectionService } = await load();
    mocks.reconciling = new Promise(() => {});

    await sshHostConnectionService.setConnected('dev', false);

    expect(mocks.calls).toContain('close connections dev ws-dev');
  });

  it('does nothing when the host is already as asked, and refuses an unknown host', async () => {
    const { sshHostConnectionService } = await load();

    await sshHostConnectionService.setConnected('dev', true);
    await expect(sshHostConnectionService.setConnected('gone', false)).rejects.toThrow(
      'SSH host gone not found'
    );

    expect(mocks.calls).toEqual([]);
  });
});
