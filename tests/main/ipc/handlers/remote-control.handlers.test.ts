import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => cb(null, '', '')
  )
);

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

const mockInstallIdentityService = {
  getPublicKey: vi.fn(async () => Buffer.alloc(91)),
  getFingerprint: vi.fn(async () => 'a'.repeat(64)),
  sign: vi.fn(async () => Buffer.alloc(64)),
};

const mockTailscaleCommand = vi.hoisted(() =>
  vi.fn(() => ({ file: 'tailscale', env: { TAILSCALE_BE_CLI: '1' }, display: 'tailscale' }))
);

vi.mock('../../../../src/main/lib/tailscale-command', () => ({
  tailscaleCommand: mockTailscaleCommand,
}));

vi.mock('../../../../src/main/services/install-identity.service', () => ({
  installIdentityService: mockInstallIdentityService,
}));

vi.mock('../../../../src/main/services/window.service', () => ({
  windowService: { broadcastWhenReady: vi.fn() },
}));

const mockConfigService = {
  get: vi.fn(() => ({
    directRemotePort: 52864,
    directRemotePublicOrigin: undefined,
  })),
  update: vi.fn((updates: Record<string, unknown>) => updates),
};

vi.mock('../../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));

const mockRemoteControlKeepAwakeService = {
  sync: vi.fn(),
};

vi.mock('../../../../src/main/services/remote-control-keep-awake.service', () => ({
  remoteControlKeepAwakeService: mockRemoteControlKeepAwakeService,
}));

const mockRemoteControlHostAccessService = {
  list: vi.fn(() => []),
  setEnabled: vi.fn(async (hostId: string, enabled: boolean) => ({
    hostId,
    hostName: 'devbox',
    enabled,
    state: enabled ? 'ready' : 'off',
  })),
  onChange: vi.fn(() => vi.fn()),
  remoteControlTurnedOff: vi.fn(async () => {}),
};

vi.mock('../../../../src/main/services/remote-control-host-access.service', () => ({
  remoteControlHostAccessService: mockRemoteControlHostAccessService,
}));

const mockRemoteControlDirectService = {
  getInfo: vi.fn(() => ({
    host: '127.0.0.1',
    port: 52864,
    preferredPort: 52864,
    localOrigin: 'http://localhost:52864',
    httpOrigin: 'http://localhost:52864',
    wsUrl: `ws://localhost:52864/remote/ws?fp=${'a'.repeat(64)}`,
    fingerprint: 'a'.repeat(64),
  })),
  start: vi.fn(async () => ({
    host: '127.0.0.1',
    port: 52864,
    preferredPort: 52864,
    localOrigin: 'http://localhost:52864',
    httpOrigin: 'http://localhost:52864',
    wsUrl: `ws://localhost:52864/remote/ws?fp=${'a'.repeat(64)}`,
    fingerprint: 'a'.repeat(64),
  })),
  stop: vi.fn(async () => {}),
  setPublicOrigin: vi.fn((_publicOrigin: string | undefined) => ({
    host: '127.0.0.1',
    port: 52864,
    preferredPort: 52864,
    localOrigin: 'http://localhost:52864',
    httpOrigin: 'http://localhost:52864',
    wsUrl: `ws://localhost:52864/remote/ws?fp=${'a'.repeat(64)}`,
    fingerprint: 'a'.repeat(64),
  })),
  startPairing: vi.fn(async () => ({
    pairUrl: `http://localhost:52864/remote/pair#fp=${'a'.repeat(64)}`,
    fingerprint: 'a'.repeat(64),
    pairingCode: '123456',
  })),
  cancelPairing: vi.fn(),
  getState: vi.fn(() => ({
    server: {
      host: '127.0.0.1',
      port: 52864,
      preferredPort: 52864,
      localOrigin: 'http://localhost:52864',
      httpOrigin: 'http://localhost:52864',
      wsUrl: `ws://localhost:52864/remote/ws?fp=${'a'.repeat(64)}`,
      fingerprint: 'a'.repeat(64),
    },
    pairingOffer: null,
    portChange: null,
  })),
  disconnectActiveClient: vi.fn(),
  disconnectCredential: vi.fn(),
};

vi.mock('../../../../src/main/services/remote-control-direct.service', () => ({
  remoteControlDirectService: mockRemoteControlDirectService,
}));

const mockRemoteControlSessionService = { releaseDeviceLeases: vi.fn() };

vi.mock('../../../../src/main/services/remote-control-session.service', () => ({
  remoteControlSessionService: mockRemoteControlSessionService,
}));

const mockPairedDeviceRegistryService = {
  list: vi.fn(() => []),
  rename: vi.fn(),
  remove: vi.fn(),
  onChange: vi.fn(() => vi.fn()),
};

vi.mock('../../../../src/main/services/paired-device-registry.service', () => ({
  pairedDeviceRegistryService: mockPairedDeviceRegistryService,
}));

describe('registerRemoteControlHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockConfigService.get.mockReturnValue({
      directRemotePort: 52864,
      directRemotePublicOrigin: undefined,
    });
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(null, '', '')
    );
  });

  afterEach(() => {
    vi.doUnmock('node-pty');
  });

  async function setup() {
    const { registerRemoteControlHandlers } =
      await import('../../../../src/main/ipc/handlers/remote-control.handlers');
    const { ipcMain } = (await import('electron')) as unknown as {
      ipcMain: {
        handle: ReturnType<typeof vi.fn>;
        _invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        _getHandler: (channel: string) => unknown;
      };
    };
    return { registerRemoteControlHandlers, ipcMain };
  }

  it('registers its handlers without starting anything', async () => {
    vi.doMock('node-pty', () => {
      throw new Error('registering remote-control handlers loaded node-pty');
    });
    const { registerRemoteControlHandlers, ipcMain } = await setup();

    registerRemoteControlHandlers();

    expect(ipcMain.handle).toHaveBeenCalled();
    expect(mockRemoteControlDirectService.start).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockInstallIdentityService.getFingerprint).not.toHaveBeenCalled();
    expect(mockInstallIdentityService.getPublicKey).not.toHaveBeenCalled();
  });

  it('registers remote-control and paired-devices handlers', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();

    registerRemoteControlHandlers();

    // Eight direct remote-control, two SSH host access and three paired-device handlers.
    expect(ipcMain.handle).toHaveBeenCalledTimes(13);
    expect(ipcMain._getHandler('remote-control:enable')).toBeUndefined();
    expect(ipcMain._getHandler('remote-control:get-state')).toBeUndefined();
    expect(ipcMain._getHandler('remote-control:disconnect-active')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:direct-start')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:direct-stop')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:direct-start-pairing')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:direct-start-tailscale-serve')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:direct-get-tailscale-status')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:direct-cancel-pairing')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:direct-get-state')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:host-access-list')).toBeDefined();
    expect(ipcMain._getHandler('remote-control:host-access-set')).toBeDefined();
    expect(ipcMain._getHandler('paired-devices:list')).toBeDefined();
    expect(ipcMain._getHandler('paired-devices:rename')).toBeDefined();
    expect(ipcMain._getHandler('paired-devices:remove')).toBeDefined();
  });

  it('routes direct remote-control IPC to the direct service', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('remote-control:direct-start', {
        publicOrigin: 'https://mac.tailnet.ts.net',
      })
    ).resolves.toMatchObject({
      httpOrigin: 'http://localhost:52864',
    });
    await expect(ipcMain._invoke('remote-control:direct-start-pairing')).resolves.toMatchObject({
      pairingCode: '123456',
    });
    await expect(ipcMain._invoke('remote-control:direct-get-state')).resolves.toMatchObject({
      server: { port: 52864 },
    });
    await expect(ipcMain._invoke('remote-control:direct-cancel-pairing')).resolves.toBeUndefined();
    await expect(ipcMain._invoke('remote-control:direct-stop')).resolves.toBeUndefined();

    expect(mockRemoteControlDirectService.start).toHaveBeenCalledWith({
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net',
    });
    expect(mockRemoteControlDirectService.startPairing).toHaveBeenCalledOnce();
    expect(mockRemoteControlDirectService.getState).toHaveBeenCalledOnce();
    expect(mockRemoteControlDirectService.cancelPairing).toHaveBeenCalledOnce();
    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
    expect(mockRemoteControlKeepAwakeService.sync).toHaveBeenLastCalledWith(false, undefined);
  });

  it('disconnects the active direct route and rejects obsolete relay requests', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:disconnect-active', 'relay')).rejects.toThrow();
    await expect(
      ipcMain._invoke('remote-control:disconnect-active', 'direct')
    ).resolves.toBeUndefined();
    expect(mockRemoteControlDirectService.disconnectActiveClient).toHaveBeenCalledOnce();
  });

  it('revokes an active session before removing its paired credential', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('paired-devices:remove', { credentialId: 'credential-1' })
    ).resolves.toBeUndefined();

    expect(mockRemoteControlDirectService.disconnectCredential).toHaveBeenCalledWith(
      'credential-1'
    );
    expect(mockRemoteControlSessionService.releaseDeviceLeases).toHaveBeenCalledWith(
      'credential-1'
    );
    expect(mockPairedDeviceRegistryService.remove).toHaveBeenCalledWith('credential-1');
  });

  it('removes the managed Tailscale Serve listener when direct remote stops', async () => {
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: true,
      directRemotePort: 52864,
      directRemotePublicOrigin: 'https://changed.tailnet.ts.net',
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:52864',
    });
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-stop')).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--https=52864', 'off'],
      { timeout: 15_000, windowsHide: true, env: { TAILSCALE_BE_CLI: '1' } },
      expect.any(Function)
    );
    expect(mockConfigService.update).toHaveBeenCalledWith({
      directRemoteEnabled: false,
      directRemoteManagedTailscaleOrigin: undefined,
    });
    expect(mockRemoteControlHostAccessService.remoteControlTurnedOff).toHaveBeenCalled();
  });

  it('turns phone access to an SSH host on or off with a validated request', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('remote-control:host-access-set', { hostId: 'host-1', enabled: true })
    ).resolves.toMatchObject({ hostId: 'host-1', state: 'ready' });
    expect(mockRemoteControlHostAccessService.setEnabled).toHaveBeenCalledWith('host-1', true);
    await expect(
      ipcMain._invoke('remote-control:host-access-set', { hostId: 'host-1', enabled: 'yes' })
    ).rejects.toThrow();
    await expect(
      ipcMain._invoke('remote-control:host-access-set', { hostId: '', enabled: true })
    ).rejects.toThrow();
  });

  it('stops the direct server even when Tailscale cleanup fails', async () => {
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: true,
      directRemotePort: 52864,
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
    });
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(new Error('serve cleanup failed'), '', 'serve cleanup failed')
    );
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-stop')).rejects.toThrow(
      'serve cleanup failed'
    );

    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
    expect(mockConfigService.update).toHaveBeenCalledWith({
      directRemoteEnabled: false,
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
    });
    expect(mockRemoteControlKeepAwakeService.sync).toHaveBeenLastCalledWith(false, undefined);
  });

  it('starts the persisted direct server when state is requested and the toggle is enabled', async () => {
    mockConfigService.get.mockReturnValue({
      directRemoteEnabled: true,
      directRemotePort: 52864,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
    });
    mockRemoteControlDirectService.getInfo.mockReturnValueOnce(null);
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-get-state')).resolves.toMatchObject({
      server: { port: 52864 },
    });

    expect(mockRemoteControlDirectService.start).toHaveBeenCalledWith({
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net',
    });
  });

  it('starts Tailscale Serve at the root HTTPS origin by default', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
        publicOrigin: 'https://mac.tailnet.ts.net',
      })
    ).resolves.toMatchObject({
      server: { port: 52864 },
      command: 'tailscale serve --bg --https=443 localhost:52864',
    });

    expect(mockRemoteControlDirectService.start).toHaveBeenCalledWith({
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net',
    });
    expect(mockConfigService.update).toHaveBeenCalledWith({
      directRemoteEnabled: true,
      directRemotePort: 52864,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--bg', '--https=443', 'localhost:52864'],
      { timeout: 15_000, windowsHide: true, env: { TAILSCALE_BE_CLI: '1' } },
      expect.any(Function)
    );
  });

  it('stops a newly-started direct server when Tailscale Serve fails', async () => {
    mockRemoteControlDirectService.getInfo.mockReturnValueOnce(null);
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(new Error('tailscale missing'), '', 'tailscale missing')
    );
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
        publicOrigin: 'https://mac.tailnet.ts.net',
      })
    ).rejects.toThrow(/tailscale missing/);

    expect(mockRemoteControlDirectService.start).toHaveBeenCalledWith({
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net',
    });
    expect(mockRemoteControlDirectService.stop).toHaveBeenCalledOnce();
    expect(mockConfigService.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ directRemoteEnabled: true })
    );
    expect(mockRemoteControlKeepAwakeService.sync).toHaveBeenCalledWith(false, undefined);
  });

  it('restores the previous direct origin when Tailscale Serve fails on an existing server', async () => {
    mockRemoteControlDirectService.getInfo.mockReturnValueOnce({
      host: '127.0.0.1',
      port: 52864,
      preferredPort: 52864,
      localOrigin: 'http://localhost:52864',
      httpOrigin: 'http://localhost:52864',
      wsUrl: `ws://localhost:52864/remote/ws?fp=${'a'.repeat(64)}`,
      fingerprint: 'a'.repeat(64),
    });
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(new Error('serve failed'), '', 'serve failed')
    );
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
        publicOrigin: 'https://mac.tailnet.ts.net',
      })
    ).rejects.toThrow(/serve failed/);

    expect(mockRemoteControlDirectService.stop).not.toHaveBeenCalled();
    expect(mockRemoteControlDirectService.setPublicOrigin).toHaveBeenCalledWith(undefined);
    expect(mockConfigService.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ directRemoteEnabled: true })
    );
  });

  it('starts Tailscale Serve on the HTTPS port its origin names', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
        publicOrigin: 'https://mac.tailnet.ts.net:444',
      })
    ).resolves.toMatchObject({
      server: { port: 52864 },
      command: 'tailscale serve --bg --https=444 localhost:52864',
    });

    expect(mockRemoteControlDirectService.start).toHaveBeenCalledWith({
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net:444',
    });
    expect(mockConfigService.update).toHaveBeenCalledWith({
      directRemoteEnabled: true,
      directRemotePort: 52864,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net:444',
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:444',
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--bg', '--https=444', 'localhost:52864'],
      { timeout: 15_000, windowsHide: true, env: { TAILSCALE_BE_CLI: '1' } },
      expect.any(Function)
    );
  });

  it('keeps the Tailscale origin stable when the direct server falls back to another port', async () => {
    const fallbackServer = {
      host: '127.0.0.1',
      port: 52900,
      preferredPort: 52864,
      localOrigin: 'http://localhost:52900',
      httpOrigin: 'https://mac.tailnet.ts.net:52864',
      wsUrl: `wss://mac.tailnet.ts.net:52864/remote/ws?fp=${'a'.repeat(64)}`,
      fingerprint: 'a'.repeat(64),
    };
    mockRemoteControlDirectService.start.mockResolvedValueOnce(fallbackServer);
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(
      ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
        publicOrigin: 'https://mac.tailnet.ts.net:52864',
      })
    ).resolves.toMatchObject({
      server: {
        port: 52900,
        httpOrigin: 'https://mac.tailnet.ts.net:52864',
        wsUrl: `wss://mac.tailnet.ts.net:52864/remote/ws?fp=${'a'.repeat(64)}`,
      },
      command: 'tailscale serve --bg --https=52864 localhost:52900',
    });

    expect(mockRemoteControlDirectService.start).toHaveBeenNthCalledWith(1, {
      port: 52864,
      publicOrigin: 'https://mac.tailnet.ts.net:52864',
    });
    expect(mockConfigService.update).toHaveBeenCalledWith({
      directRemoteEnabled: true,
      directRemotePort: 52900,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net:52864',
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:52864',
    });
  });

  it('reports Tailscale installation status and the exact Serve command', async () => {
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-get-tailscale-status')).resolves.toEqual(
      expect.objectContaining({
        installed: true,
        command: 'tailscale serve --bg --https=443 localhost:52864',
        httpsPortTaken: false,
      })
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      'tailscale',
      ['version'],
      { timeout: 5_000, windowsHide: true, env: { TAILSCALE_BE_CLI: '1' } },
      expect.any(Function)
    );
  });

  it('runs and shows the Mac app binary when the CLI was never installed', async () => {
    const appBinary = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    mockTailscaleCommand.mockReturnValueOnce({
      file: appBinary,
      env: { TAILSCALE_BE_CLI: '1' },
      display: appBinary,
    });
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-get-tailscale-status')).resolves.toEqual(
      expect.objectContaining({
        installed: true,
        command: `${appBinary} serve --bg --https=443 localhost:52864`,
      })
    );
    for (const args of [['version'], ['status', '--json'], ['serve', 'status', '--json']]) {
      expect(mockExecFile).toHaveBeenCalledWith(
        appBinary,
        args,
        expect.objectContaining({ env: { TAILSCALE_BE_CLI: '1' } }),
        expect.any(Function)
      );
    }
  });

  it('reports the stable managed HTTPS port when the local server uses a fallback', async () => {
    mockConfigService.get.mockReturnValue({
      directRemotePort: 57948,
      directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:52864',
    });
    mockRemoteControlDirectService.getInfo.mockReturnValueOnce({
      ...mockRemoteControlDirectService.getInfo(),
      port: 57948,
      localOrigin: 'http://localhost:57948',
    });
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-get-tailscale-status')).resolves.toEqual(
      expect.objectContaining({
        command: 'tailscale serve --bg --https=52864 localhost:57948',
      })
    );
  });

  it('autodetects the Tailscale HTTPS origin from MagicDNS', async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args.join(' ') === 'status --json') {
          cb(null, JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }), '');
          return;
        }
        if (args.join(' ') === 'serve status --json') {
          cb(null, JSON.stringify({ TCP: {} }), '');
          return;
        }
        cb(null, '', '');
      }
    );
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-get-tailscale-status')).resolves.toEqual({
      installed: true,
      command: 'tailscale serve --bg --https=443 localhost:52864',
      hostname: 'mac.tailnet.ts.net',
      suggestedOrigin: 'https://mac.tailnet.ts.net',
      httpsPortTaken: false,
      serveConfigured: false,
    });
  });

  describe('with routes already on Tailscale Serve', () => {
    const mockServeStatus = (status: unknown) =>
      mockExecFile.mockImplementation(
        (
          _command: string,
          args: string[],
          _options: Record<string, unknown>,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          if (args.join(' ') === 'status --json') {
            cb(null, JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }), '');
            return;
          }
          if (args.join(' ') === 'serve status --json') {
            cb(null, JSON.stringify(status), '');
            return;
          }
          cb(null, '', '');
        }
      );
    const route = (httpsPort: number, proxy: string) => ({
      TCP: { [httpsPort]: { HTTPS: true } },
      Web: {
        [`mac.tailnet.ts.net:${httpsPort}`]: { Handlers: { '/': { Proxy: proxy } } },
      },
    });
    const getStatus = async () => {
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();
      return ipcMain._invoke('remote-control:direct-get-tailscale-status');
    };

    it('suggests the local port when 443 is taken', async () => {
      mockServeStatus(route(443, 'http://localhost:3000'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({
          command: 'tailscale serve --bg --https=52864 localhost:52864',
          suggestedOrigin: 'https://mac.tailnet.ts.net:52864',
          httpsPortTaken: false,
        })
      );
    });

    it('suggests the plain address when only other HTTPS ports are taken', async () => {
      mockServeStatus(route(48348, 'http://127.0.0.1:48348'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({
          command: 'tailscale serve --bg --https=443 localhost:52864',
          suggestedOrigin: 'https://mac.tailnet.ts.net',
          httpsPortTaken: false,
        })
      );
    });

    it('does not take 443 for a route that only proxies to a port starting with it', async () => {
      mockServeStatus(route(8443, 'http://127.0.0.1:4430'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({ suggestedOrigin: 'https://mac.tailnet.ts.net' })
      );
    });

    it('does not count its own route on 443 as taken', async () => {
      mockServeStatus(route(443, 'http://localhost:52864'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({
          suggestedOrigin: 'https://mac.tailnet.ts.net',
          httpsPortTaken: false,
          serveConfigured: true,
        })
      );
    });

    it('reports a saved origin on a taken port and keeps that port in the command', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
      });
      mockServeStatus(route(443, 'http://localhost:3000'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({
          command: 'tailscale serve --bg --https=443 localhost:52864',
          suggestedOrigin: 'https://mac.tailnet.ts.net:52864',
          httpsPortTaken: true,
        })
      );
    });

    it('does not count a Tailscale Service or a mount path as holding the port', async () => {
      mockServeStatus({
        Services: { 'svc:docs': { TCP: { '443': { HTTPS: true } } } },
        ...route(8443, 'http://localhost:3000'),
        Web: {
          'mac.tailnet.ts.net:8443': {
            Handlers: { '/x:443': { Proxy: 'http://localhost:3000' } },
          },
        },
      });

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({ suggestedOrigin: 'https://mac.tailnet.ts.net' })
      );
    });

    it('is not published by a route to Komla on another HTTPS port', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
      });
      mockServeStatus(route(52864, 'http://localhost:52864'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({ serveConfigured: false })
      );
    });

    it('refuses to publish on a port another route holds', async () => {
      mockServeStatus(route(443, 'http://localhost:3000'));
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();

      await expect(
        ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
          publicOrigin: 'https://mac.tailnet.ts.net',
        })
      ).rejects.toThrow(/HTTPS port 443/);

      expect(mockExecFile).not.toHaveBeenCalledWith(
        'tailscale',
        expect.arrayContaining(['--bg']),
        expect.anything(),
        expect.any(Function)
      );
    });

    it('does not take a saved origin as proof that a port is still its own', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemotePublicOrigin: 'https://mac.tailnet.ts.net',
        directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
      });
      mockServeStatus(route(443, 'http://localhost:3000'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({ httpsPortTaken: true })
      );
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();
      await expect(
        ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
          publicOrigin: 'https://mac.tailnet.ts.net',
        })
      ).rejects.toThrow(/HTTPS port 443/);
    });

    it('leaves another program alone on the port it last published on', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
      });
      mockServeStatus(route(443, 'http://localhost:3000'));
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();

      await expect(
        ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
          publicOrigin: 'https://mac.tailnet.ts.net:8443',
        })
      ).resolves.toMatchObject({ command: 'tailscale serve --bg --https=8443 localhost:52864' });

      expect(mockExecFile).not.toHaveBeenCalledWith(
        'tailscale',
        expect.arrayContaining(['off']),
        expect.anything(),
        expect.any(Function)
      );
    });

    it('removes its route on the old port once the new one is up', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
      });
      mockServeStatus(route(443, 'http://localhost:52864'));
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();

      await ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
        publicOrigin: 'https://mac.tailnet.ts.net:8443',
      });

      const serveCalls = mockExecFile.mock.calls
        .map(([, args]) => (args as string[]).join(' '))
        .filter((args) => args.includes('--https='));
      expect(serveCalls).toEqual([
        'serve --bg --https=8443 localhost:52864',
        'serve --https=443 off',
      ]);
      expect(mockConfigService.update).toHaveBeenCalledWith(
        expect.objectContaining({
          directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:8443',
        })
      );
    });

    it('keeps its route on the old port when the new port is refused', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
      });
      const live = route(443, 'http://localhost:52864');
      const taken = route(8443, 'http://localhost:3000');
      mockServeStatus({ TCP: { ...live.TCP, ...taken.TCP }, Web: { ...live.Web, ...taken.Web } });
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();

      await expect(
        ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
          publicOrigin: 'https://mac.tailnet.ts.net:8443',
        })
      ).rejects.toThrow(/HTTPS port 8443/);

      expect(mockExecFile).not.toHaveBeenCalledWith(
        'tailscale',
        expect.arrayContaining(['off']),
        expect.anything(),
        expect.any(Function)
      );
    });

    it('publishes on a new port when its old route is already gone', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
      });
      mockServeStatus({});
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();

      await expect(
        ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
          publicOrigin: 'https://mac.tailnet.ts.net:8443',
        })
      ).resolves.toMatchObject({ command: 'tailscale serve --bg --https=8443 localhost:52864' });

      expect(mockExecFile).not.toHaveBeenCalledWith(
        'tailscale',
        expect.arrayContaining(['off']),
        expect.anything(),
        expect.any(Function)
      );
    });

    const mockServeCommands = (fails: (args: string) => boolean) =>
      mockExecFile.mockImplementation(
        (
          _command: string,
          args: string[],
          _options: Record<string, unknown>,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          const joined = args.join(' ');
          if (fails(joined)) {
            cb(new Error('serve failed'), '', 'serve failed');
            return;
          }
          cb(
            null,
            joined === 'serve status --json'
              ? JSON.stringify(route(443, 'http://localhost:52864'))
              : '',
            ''
          );
        }
      );
    const publishOnNewPort = async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net',
      });
      const { registerRemoteControlHandlers, ipcMain } = await setup();
      registerRemoteControlHandlers();
      await expect(
        ipcMain._invoke('remote-control:direct-start-tailscale-serve', {
          publicOrigin: 'https://mac.tailnet.ts.net:8443',
        })
      ).rejects.toThrow(/serve failed/);
      expect(mockConfigService.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          directRemoteManagedTailscaleOrigin: 'https://mac.tailnet.ts.net:8443',
        })
      );
      return mockExecFile.mock.calls
        .map(([, args]) => (args as string[]).join(' '))
        .filter((args) => args.includes('--https='));
    };

    it('takes the new route back off when its old route will not come off', async () => {
      mockServeCommands((args) => args === 'serve --https=443 off');

      await expect(publishOnNewPort()).resolves.toEqual([
        'serve --bg --https=8443 localhost:52864',
        'serve --https=443 off',
        'serve --https=8443 off',
      ]);
    });

    it('keeps its old route when the new one fails to publish', async () => {
      mockServeCommands((args) => args.includes('--bg'));

      await expect(publishOnNewPort()).resolves.toEqual([
        'serve --bg --https=8443 localhost:52864',
      ]);
    });

    it('offers the plain address over a saved origin on another port', async () => {
      mockConfigService.get.mockReturnValue({
        directRemotePort: 52864,
        directRemotePublicOrigin: 'https://mac.tailnet.ts.net:52864',
      });
      mockServeStatus(route(48348, 'http://127.0.0.1:48348'));

      await expect(getStatus()).resolves.toEqual(
        expect.objectContaining({
          command: 'tailscale serve --bg --https=52864 localhost:52864',
          suggestedOrigin: 'https://mac.tailnet.ts.net',
        })
      );
    });
  });

  it('reports when Tailscale Serve already points at Komla', async () => {
    mockConfigService.get.mockReturnValue({
      directRemotePort: 52864,
      directRemotePublicOrigin: 'https://mac.tailnet.ts.net:52864',
    });
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (args.join(' ') === 'serve status --json') {
          cb(null, JSON.stringify({ HTTPS: { '52864': { TCPForward: 'localhost:52864' } } }), '');
          return;
        }
        cb(null, '', '');
      }
    );
    const { registerRemoteControlHandlers, ipcMain } = await setup();
    registerRemoteControlHandlers();

    await expect(ipcMain._invoke('remote-control:direct-get-tailscale-status')).resolves.toEqual(
      expect.objectContaining({
        serveConfigured: true,
      })
    );
  });
});
