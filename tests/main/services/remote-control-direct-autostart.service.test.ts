import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockConfigService = {
  get: vi.fn(),
  update: vi.fn(),
};

vi.mock('../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));

const mockRemoteControlKeepAwakeService = {
  sync: vi.fn(),
};

vi.mock('../../../src/main/services/remote-control-keep-awake.service', () => ({
  remoteControlKeepAwakeService: mockRemoteControlKeepAwakeService,
}));

const server = {
  host: '127.0.0.1',
  port: 52864,
  preferredPort: 52864,
  localOrigin: 'http://localhost:52864',
  httpOrigin: 'https://mac.tailnet.ts.net',
  wsUrl: 'wss://mac.tailnet.ts.net/remote/ws?fp=fingerprint',
  fingerprint: 'fingerprint',
};

const mockRemoteControlDirectService = {
  getInfo: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

vi.mock('../../../src/main/services/remote-control-direct.service', () => ({
  remoteControlDirectService: mockRemoteControlDirectService,
}));

const mockRemoteControlTailscaleService = {
  assertFunnelOff: vi.fn(),
  reconcile: vi.fn(),
  stop: vi.fn(),
};

const { MockTailscaleFunnelEnabledError } = vi.hoisted(() => ({
  MockTailscaleFunnelEnabledError: class extends Error {},
}));

vi.mock('../../../src/main/services/remote-control-tailscale.service', () => ({
  remoteControlTailscaleService: mockRemoteControlTailscaleService,
  TailscaleFunnelEnabledError: MockTailscaleFunnelEnabledError,
}));

const managedConfig = {
  directRemoteEnabled: true,
  directRemotePort: 52864,
  directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
  directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
  directRemoteKeepAwake: false,
};

describe('startPersistedDirectRemoteServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: false,
      directRemotePort: 52864,
      directRemotePublicOrigin: undefined,
      directRemoteKeepAwake: false,
    });
    mockRemoteControlDirectService.getInfo.mockReturnValue(null);
    mockRemoteControlDirectService.start.mockResolvedValue(server);
    mockRemoteControlDirectService.stop.mockResolvedValue(undefined);
    mockRemoteControlTailscaleService.assertFunnelOff.mockResolvedValue(undefined);
    mockRemoteControlTailscaleService.reconcile.mockResolvedValue(undefined);
    mockRemoteControlTailscaleService.stop.mockResolvedValue(undefined);
  });

  it('reconciles the persisted Tailscale listener with the bound local port', async () => {
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: true,
      directRemotePort: 54809,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net:54809',
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:54809',
      directRemoteKeepAwake: false,
    });
    mockRemoteControlDirectService.start.mockResolvedValue({
      ...server,
      port: 57948,
      preferredPort: 54809,
      localOrigin: 'http://localhost:57948',
      httpOrigin: 'https://mac.tailnet.ts.net:54809',
    });
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await startPersistedDirectRemoteServer('boot');

    expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledWith(
      'https://mac.tailnet.ts.net:54809',
      57948
    );
  });

  it('does not start the server while Tailscale Funnel exposes the managed port', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.assertFunnelOff.mockRejectedValue(
      new MockTailscaleFunnelEnabledError('Funnel is on')
    );
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();

    expect(mockRemoteControlTailscaleService.assertFunnelOff).toHaveBeenCalledWith(
      'https://mac.tailnet.ts.net'
    );
    expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
  });

  it('stops the server when Tailscale Funnel is found on the managed port', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.reconcile.mockRejectedValue(
      new MockTailscaleFunnelEnabledError('Funnel is on')
    );
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();

    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
  });

  it('retries the Tailscale listener while Tailscale is still starting', async () => {
    vi.useFakeTimers();
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.reconcile.mockRejectedValueOnce(
      new Error('failed to connect to local tailscaled')
    );
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toEqual(server);
    mockRemoteControlDirectService.getInfo.mockReturnValue(server);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenCalledTimes(2);
    expect(mockRemoteControlTailscaleService.reconcile).toHaveBeenLastCalledWith(
      'https://mac.tailnet.ts.net',
      52864
    );
  });

  it('starts the server from persisted settings when remote control is enabled', async () => {
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: true,
      directRemotePort: 52864,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
      directRemoteKeepAwake: true,
    });
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toEqual(server);

    expect(mockRemoteControlDirectService.start).toHaveBeenCalledWith({
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net',
    });
    expect(mockRemoteControlKeepAwakeService.sync).toHaveBeenCalledWith(true, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start the server when remote control is disabled', async () => {
    const { startPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();

    expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
  });

  it('releases the local server during app shutdown when remote control is enabled', async () => {
    mockConfigService.get.mockReturnValue({ directRemoteEnabled: true });
    const { stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await stopPersistedDirectRemoteServer();

    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
  });

  it('removes the managed Tailscale listener before releasing the local server at shutdown', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    const { stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await stopPersistedDirectRemoteServer();

    // While Komla is closed, any program that takes the port would be on the tailnet.
    expect(mockRemoteControlTailscaleService.stop).toHaveBeenCalledWith(
      'https://mac.tailnet.ts.net',
      5_000
    );
    expect(mockRemoteControlTailscaleService.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoteControlDirectService.stop.mock.invocationCallOrder[0]!
    );
    expect(mockConfigService.update).not.toHaveBeenCalled();
  });

  it('still releases the local server when removing the Tailscale listener fails', async () => {
    mockConfigService.get.mockReturnValue(managedConfig);
    mockRemoteControlTailscaleService.stop.mockRejectedValue(new Error('tailscaled is down'));
    const { stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await stopPersistedDirectRemoteServer();

    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
  });

  it('retries removing a Tailscale listener that turning remote control off left behind', async () => {
    const leftover = { ...managedConfig, directRemoteEnabled: false };
    mockConfigService.get.mockReturnValue(leftover);
    mockRemoteControlTailscaleService.stop.mockRejectedValueOnce(new Error('tailscaled is down'));
    const { startPersistedDirectRemoteServer, stopPersistedDirectRemoteServer } = await import(
      '../../../src/main/services/remote-control-direct-autostart.service'
    );

    await expect(startPersistedDirectRemoteServer('state-read')).resolves.toBeNull();
    expect(mockRemoteControlTailscaleService.stop).not.toHaveBeenCalled();
    await expect(startPersistedDirectRemoteServer('boot')).resolves.toBeNull();
    expect(mockConfigService.update).not.toHaveBeenCalled();

    await stopPersistedDirectRemoteServer();

    expect(mockRemoteControlTailscaleService.stop).toHaveBeenCalledTimes(2);
    expect(mockRemoteControlTailscaleService.stop).toHaveBeenLastCalledWith(
      'https://mac.tailnet.ts.net',
      5_000
    );
    expect(mockConfigService.update).toHaveBeenCalledWith({
      directRemoteManagedTailscaleOrigin: undefined,
    });
    expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
    expect(mockRemoteControlDirectService.stop).not.toHaveBeenCalled();
  });
});
