import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RemoteWorkspaceObservationService,
  type RemoteWorkspaceObservationDependencies,
} from '../../../src/main/services/remote-workspace-observation.service';

import type { SshHost, Workspace } from '../../../src/shared/types';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const host: SshHost = {
  id: 'ssh-dev',
  name: 'Dev host',
  hostname: 'dev.example.test',
  basePath: '/home/dev/.komla',
};

function sshWorkspace(
  id: string,
  terminal: Partial<Workspace['terminals'][number]> = {}
): Workspace {
  return {
    id,
    name: id,
    workingDirectory: `ssh://ssh-dev/home/dev/${id}`,
    backend: {
      kind: 'ssh',
      hostId: host.id,
      remoteDirectory: `/home/dev/${id}`,
      remoteRepoPath: `/home/dev/${id}.git`,
      remoteProjectRoot: '/home/dev/.komla/worktrees',
      gitUrl: 'git@example.test:repo.git',
      baseBranch: 'main',
    },
    branchName: 'agent/test',
    baseBranch: 'main',
    isWorktree: true,
    projectId: 'project-1',
    terminals: [
      {
        id: `${id}-terminal`,
        name: 'Agent',
        status: 'running',
        createdAt: 1,
        ...terminal,
      },
    ],
    windowId: null,
    categoryId: null,
    createdAt: 1,
    lastActivityAt: 1,
    order: 0,
    status: 'active',
  };
}

function createHarness(initialWorkspaces: Workspace[] = [sshWorkspace('workspace-1')]) {
  let workspaces = initialWorkspaces;
  const calls: string[] = [];
  const runtime = {
    installationKey: 'installation',
    tmuxSocket: 'companion-socket',
    sessionName: 'companion-session',
    hookInbox: '/home/dev/.komla/companion/inbox',
  };
  const dependencies: RemoteWorkspaceObservationDependencies = {
    listWorkspaces: vi.fn(() => workspaces),
    waitForKomlaPort: vi.fn(async () => 54_183),
    ensureKomlaDataTunnel: vi.fn(async (_hostId, _localPort, onConnected) => {
      calls.push('tunnel');
      onConnected();
    }),
    stopKomlaDataTunnelsExcept: vi.fn(),
    getHost: vi.fn(() => host),
    ensureRemoteNotificationScript: vi.fn(async () => {
      calls.push('notification-script');
    }),
    ensureRemoteCompanion: vi.fn(async () => {
      calls.push('companion');
      return runtime;
    }),
    invalidateRemoteCompanion: vi.fn(),
    companionInstallationId: vi.fn(() => 'installation-id'),
    resolveCompanionRuntime: vi.fn(() => ({
      installationKey: 'deterministic-installation',
      tmuxSocket: 'komla-companion-deterministic-installation',
      sessionName: 'komla-companion-deterministic-installation',
      hookInbox: '/home/dev/.komla/helpers/companion/deterministic-installation/inbox',
    })),
    markRemoteDisconnected: vi.fn(async () => undefined),
    refreshWorkspaceStatus: vi.fn(async () => undefined),
    isWorkspaceDeleting: vi.fn(() => false),
  };
  const service = new RemoteWorkspaceObservationService(dependencies);
  return {
    calls,
    dependencies,
    runtime,
    service,
    setWorkspaces(next: Workspace[]) {
      workspaces = next;
    },
  };
}

describe('RemoteWorkspaceObservationService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('keeps an idle connected host current without periodic workspace scans', async () => {
    const harness = createHarness();
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockClear();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(harness.dependencies.markRemoteDisconnected).not.toHaveBeenCalled();
    expect(harness.dependencies.refreshWorkspaceStatus).not.toHaveBeenCalled();
  });

  it('derives monitored workspaces and prepares the companion and tunnel', async () => {
    const localTerminal = sshWorkspace('workspace-2', {
      executionLocation: 'local-mirror',
    });
    const stoppedTerminal = sshWorkspace('workspace-3', { status: 'stopped' });
    const restoredTerminal = sshWorkspace('workspace-4', {
      status: 'stopped',
      remoteSessionActive: true,
    });
    const startingTerminal = sshWorkspace('workspace-5', {
      status: 'starting',
    });
    const harness = createHarness([
      sshWorkspace('workspace-1'),
      localTerminal,
      stoppedTerminal,
      restoredTerminal,
      startingTerminal,
    ]);

    await harness.service.reconcile();

    expect(harness.calls).toEqual(['notification-script', 'companion', 'tunnel']);
    expect(harness.dependencies.ensureKomlaDataTunnel).toHaveBeenCalledWith(
      host.id,
      54_183,
      expect.any(Function)
    );
    expect(harness.dependencies.ensureRemoteCompanion).toHaveBeenCalledWith(
      host,
      expect.objectContaining({
        remoteBasePath: '/home/dev',
        workspaces: [
          expect.objectContaining({ workspaceId: 'workspace-1' }),
          expect.objectContaining({ workspaceId: 'workspace-4' }),
          expect.objectContaining({ workspaceId: 'workspace-5' }),
        ],
      })
    );
    expect(harness.service.companionForHost(host.id)).toEqual(harness.runtime);
  });

  it('monitors a workspace whose tmux session runs on the host without this device attached', async () => {
    const harness = createHarness([
      sshWorkspace('workspace-1', { status: 'stopped', remoteSessionOnHost: true }),
    ]);

    await harness.service.reconcile();

    expect(harness.dependencies.ensureRemoteCompanion).toHaveBeenCalledWith(
      host,
      expect.objectContaining({
        workspaces: [expect.objectContaining({ workspaceId: 'workspace-1' })],
      })
    );
  });

  it('refreshes every monitored workspace on initial connection and automatic reconnection', async () => {
    const harness = createHarness([
      sshWorkspace('workspace-1'),
      sshWorkspace('workspace-2', { status: 'stopped', remoteSessionActive: true }),
      sshWorkspace('stopped', { status: 'stopped' }),
      sshWorkspace('local', { executionLocation: 'local-mirror' }),
    ]);
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledWith(
      'workspace-1',
      'reconnected'
    );
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledWith(
      'workspace-2',
      'reconnected'
    );

    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockClear();
    const onConnected = vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mock.calls[0][2];
    onConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledTimes(2);
  });

  it('refreshes as a plain refresh when the companion is not running', async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.ensureRemoteCompanion).mockResolvedValue(undefined);

    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);

    // Without a companion, nothing else reports files changed while disconnected.
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledExactlyOnceWith(
      'workspace-1',
      undefined
    );
  });

  it('does not refresh existing workspaces when panes or workspaces reuse the tunnel', async () => {
    const harness = createHarness();
    let connected = false;
    vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mockImplementation(
      async (_hostId, _port, onConnected) => {
        if (connected) return;
        connected = true;
        onConnected();
      }
    );
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockClear();
    const workspace = sshWorkspace('workspace-1');
    workspace.terminals.push({ ...workspace.terminals[0], id: 'new-pane' });
    harness.setWorkspaces([workspace]);
    await harness.service.reconcileAfterReconnect();
    harness.setWorkspaces([workspace, sshWorkspace('new-workspace')]);
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.dependencies.refreshWorkspaceStatus).not.toHaveBeenCalled();
  });

  it('limits connection refreshes to eligible workspaces on the connected host', async () => {
    const otherHost = sshWorkspace('other-host');
    if (otherHost.backend.kind !== 'ssh') throw new Error('Expected SSH workspace');
    otherHost.backend.hostId = 'other-host';
    const harness = createHarness([
      sshWorkspace('workspace-1'),
      sshWorkspace('deleting'),
      otherHost,
    ]);
    vi.mocked(harness.dependencies.isWorkspaceDeleting).mockImplementation(
      (id) => id === 'deleting'
    );
    vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mockImplementation(
      async (hostId, _port, onConnected) => {
        if (hostId === host.id) onConnected();
      }
    );
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledExactlyOnceWith(
      'workspace-1',
      'reconnected'
    );
  });

  it('waits for companion preparation before requesting snapshots', async () => {
    const harness = createHarness();
    let finishCompanion!: () => void;
    vi.mocked(harness.dependencies.ensureRemoteCompanion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCompanion = () => resolve(harness.runtime);
        })
    );
    const reconciliation = harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.dependencies.refreshWorkspaceStatus).not.toHaveBeenCalled();
    finishCompanion();
    await reconciliation;
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledWith(
      'workspace-1',
      'reconnected'
    );
  });

  it('retries failed refreshes without refreshing successful workspaces again', async () => {
    const harness = createHarness([sshWorkspace('workspace-1'), sshWorkspace('workspace-2')]);
    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockRejectedValueOnce(
      new Error('offline')
    );
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledTimes(3);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenLastCalledWith(
      'workspace-1',
      'reconnected'
    );
  });

  it('backs off repeated snapshot failures up to one retry per minute', async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockRejectedValue(new Error('offline'));
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    let expectedCalls = 1;
    for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledTimes(expectedCalls);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledTimes(++expectedCalls);
    }
  });

  it('ignores obsolete connection callbacks and cancels refresh retries when the host retires', async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockRejectedValue(new Error('offline'));
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    const onConnected = vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mock.calls[0][2];
    harness.setWorkspaces([sshWorkspace('workspace-1', { status: 'stopped' })]);
    await harness.service.reconcile();
    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockClear();

    harness.setWorkspaces([sshWorkspace('workspace-1')]);
    onConnected();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.dependencies.refreshWorkspaceStatus).not.toHaveBeenCalled();
  });

  it('coalesces reconnections during a refresh into one subsequent refresh', async () => {
    const harness = createHarness();
    let finishRefresh!: () => void;
    vi.mocked(harness.dependencies.refreshWorkspaceStatus).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    const onConnected = vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mock.calls[0][2];
    onConnected();
    onConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledOnce();

    finishRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.dependencies.refreshWorkspaceStatus).toHaveBeenCalledTimes(2);
  });

  it('derives companion launch context before the companion is running', () => {
    const harness = createHarness();
    const backend = sshWorkspace('workspace-1').backend;
    if (backend.kind !== 'ssh') throw new Error('Expected SSH workspace');

    expect(harness.service.companionForWorkspace(backend)).toEqual({
      installationKey: 'deterministic-installation',
      tmuxSocket: 'komla-companion-deterministic-installation',
      sessionName: 'komla-companion-deterministic-installation',
      hookInbox: '/home/dev/.komla/helpers/companion/deterministic-installation/inbox',
    });
    expect(harness.dependencies.resolveCompanionRuntime).toHaveBeenCalledWith(
      '/home/dev',
      'installation-id'
    );
  });

  it('keeps terminal use best-effort and retries companion setup', async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mockRejectedValueOnce(
      new Error('tunnel unavailable')
    );
    vi.mocked(harness.dependencies.ensureRemoteCompanion)
      .mockRejectedValueOnce(new Error('tmux unavailable'))
      .mockResolvedValueOnce(harness.runtime);

    await expect(harness.service.reconcile()).resolves.toBeUndefined();
    expect(harness.dependencies.markRemoteDisconnected).toHaveBeenCalledWith(['workspace-1']);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(harness.dependencies.ensureRemoteCompanion).toHaveBeenCalledTimes(2)
    );
    expect(harness.service.companionForHost(host.id)).toEqual(harness.runtime);
  });

  it('releases host observation authority when its final managed session ends', async () => {
    const harness = createHarness();
    await harness.service.reconcile();
    harness.setWorkspaces([sshWorkspace('workspace-1', { status: 'stopped' })]);

    await harness.service.reconcile();

    expect(harness.dependencies.stopKomlaDataTunnelsExcept).toHaveBeenLastCalledWith(new Set());
    expect(harness.dependencies.markRemoteDisconnected).toHaveBeenCalledWith(['workspace-1']);
    expect(harness.dependencies.invalidateRemoteCompanion).toHaveBeenCalledWith(host.id);
    expect(harness.service.companionForHost(host.id)).toBeUndefined();
  });

  it('marks the host disconnected when its lifecycle ends without a companion runtime', async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.ensureRemoteCompanion).mockResolvedValue(undefined);
    await harness.service.reconcile();
    vi.mocked(harness.dependencies.markRemoteDisconnected).mockClear();
    harness.setWorkspaces([sshWorkspace('workspace-1', { status: 'stopped' })]);

    await harness.service.reconcile();

    expect(harness.dependencies.markRemoteDisconnected).toHaveBeenCalledWith(['workspace-1']);
  });

  it('discards a companion that starts after its final managed session ends', async () => {
    const harness = createHarness();
    let finishCompanion: (() => void) | undefined;
    vi.mocked(harness.dependencies.ensureRemoteCompanion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCompanion = () => resolve(harness.runtime);
        })
    );

    const reconciliation = harness.service.reconcile();
    await vi.waitFor(() => expect(finishCompanion).toBeDefined());
    harness.setWorkspaces([sshWorkspace('workspace-1', { status: 'stopped' })]);
    finishCompanion?.();
    await reconciliation;

    expect(harness.dependencies.invalidateRemoteCompanion).toHaveBeenCalledWith(host.id);
    expect(harness.service.companionForHost(host.id)).toBeUndefined();
  });

  it('cancels a scheduled companion retry when its final managed session ends', async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.ensureRemoteCompanion).mockRejectedValueOnce(
      new Error('tmux unavailable')
    );
    await harness.service.reconcile();
    harness.setWorkspaces([sshWorkspace('workspace-1', { status: 'stopped' })]);

    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.dependencies.ensureRemoteCompanion).toHaveBeenCalledOnce();
  });

  it('does not schedule a companion retry for a workspace being deleted', async () => {
    const harness = createHarness();
    vi.mocked(harness.dependencies.ensureRemoteCompanion).mockRejectedValueOnce(
      new Error('tmux unavailable')
    );
    vi.mocked(harness.dependencies.isWorkspaceDeleting).mockReturnValue(true);

    await harness.service.reconcile();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.dependencies.ensureRemoteCompanion).toHaveBeenCalledOnce();
  });

  it('reconciles different hosts concurrently', async () => {
    const secondHost = { ...host, id: 'ssh-prod', name: 'Production host' };
    const secondWorkspace = sshWorkspace('workspace-2');
    if (secondWorkspace.backend?.kind !== 'ssh') throw new Error('Expected SSH workspace');
    secondWorkspace.backend = {
      ...secondWorkspace.backend,
      hostId: secondHost.id,
    };
    secondWorkspace.workingDirectory = 'ssh://ssh-prod/home/dev/workspace-2';
    const harness = createHarness([sshWorkspace('workspace-1'), secondWorkspace]);
    vi.mocked(harness.dependencies.getHost).mockImplementation((hostId) =>
      hostId === secondHost.id ? secondHost : host
    );
    let finishFirstCompanion: (() => void) | undefined;
    vi.mocked(harness.dependencies.ensureRemoteCompanion).mockImplementation((requestedHost) =>
      requestedHost.id === host.id
        ? new Promise((resolve) => {
            finishFirstCompanion = () => resolve(harness.runtime);
          })
        : Promise.resolve(harness.runtime)
    );

    const reconciliation = harness.service.reconcile();
    await vi.waitFor(() =>
      expect(harness.dependencies.ensureRemoteCompanion).toHaveBeenCalledWith(
        secondHost,
        expect.anything()
      )
    );
    finishFirstCompanion?.();
    await reconciliation;

    expect(harness.service.companionForHost(secondHost.id)).toEqual(harness.runtime);
  });

  it('coalesces overlapping requests and reconciles the latest workspace state', async () => {
    const harness = createHarness();
    let finishTunnel: (() => void) | undefined;
    vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mockImplementationOnce(
      (_hostId, _localPort, onConnected) =>
        new Promise<void>((resolve) => {
          finishTunnel = () => {
            onConnected();
            resolve();
          };
        })
    );

    const first = harness.service.reconcile();
    await vi.waitFor(() => expect(finishTunnel).toBeDefined());
    harness.setWorkspaces([sshWorkspace('workspace-1', { status: 'stopped' })]);
    const second = harness.service.reconcile();
    finishTunnel?.();
    await Promise.all([first, second]);

    expect(harness.dependencies.listWorkspaces).toHaveBeenCalled();
    expect(harness.dependencies.markRemoteDisconnected).toHaveBeenCalledWith(['workspace-1']);
    expect(harness.service.companionForHost(host.id)).toBeUndefined();
  });

  it('does not block terminal reconnection on the data tunnel', async () => {
    const harness = createHarness();
    let finishTunnel: (() => void) | undefined;
    vi.mocked(harness.dependencies.ensureKomlaDataTunnel).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishTunnel = resolve;
        })
    );

    const reconciliation = harness.service.reconcileAfterReconnect();
    await vi.waitFor(() =>
      expect(harness.dependencies.ensureRemoteCompanion).toHaveBeenCalledOnce()
    );

    await reconciliation;

    finishTunnel?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.dependencies.ensureKomlaDataTunnel).toHaveBeenCalledWith(
      host.id,
      54_183,
      expect.any(Function)
    );
  });

  it('does not start an obsolete tunnel after the host lifecycle ends', async () => {
    const harness = createHarness();
    let releasePort: (() => void) | undefined;
    vi.mocked(harness.dependencies.waitForKomlaPort).mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          releasePort = () => resolve(54_183);
        })
    );

    await harness.service.reconcileAfterReconnect();
    harness.setWorkspaces([sshWorkspace('workspace-1', { status: 'stopped' })]);
    await harness.service.reconcile();

    harness.setWorkspaces([sshWorkspace('workspace-1')]);
    releasePort?.();
    await vi.waitFor(() =>
      expect(harness.dependencies.ensureKomlaDataTunnel).not.toHaveBeenCalled()
    );

    await harness.service.reconcile();
    expect(harness.dependencies.ensureKomlaDataTunnel).toHaveBeenCalledOnce();
  });
});
