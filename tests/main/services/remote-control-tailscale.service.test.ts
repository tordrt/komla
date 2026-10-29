import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

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

vi.mock('child_process', () => ({ execFile: mockExecFile }));
vi.mock('../../../src/main/lib/tailscale-command', () => ({
  tailscaleCommand: () => ({
    file: 'tailscale',
    env: { TAILSCALE_BE_CLI: '1' },
    display: 'tailscale',
  }),
}));

describe('remoteControlTailscaleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(null, '', '')
    );
  });

  it('keeps an existing listener that already targets the current local server', async () => {
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        expect(args).toEqual(['serve', 'status', '--json']);
        cb(
          null,
          JSON.stringify({ HTTPS: { '52864': { Handlers: { '/': 'localhost:57948' } } } }),
          ''
        );
      }
    );
    const { remoteControlTailscaleService } =
      await import('../../../src/main/services/remote-control-tailscale.service');

    await remoteControlTailscaleService.reconcile('https://mac.tailnet.ts.net:52864', 57948);

    expect(mockExecFile).toHaveBeenCalledOnce();
  });

  it('repairs a stale listener while preserving its public HTTPS port', async () => {
    mockExecFile
      .mockImplementationOnce(
        (
          _command: string,
          _args: string[],
          _options: Record<string, unknown>,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) =>
          cb(
            null,
            JSON.stringify({ HTTPS: { '52864': { Handlers: { '/': 'localhost:54809' } } } }),
            ''
          )
      )
      .mockImplementationOnce(
        (
          _command: string,
          _args: string[],
          _options: Record<string, unknown>,
          cb: (err: Error | null, stdout: string, stderr: string) => void
        ) => cb(null, '', '')
      );
    const { remoteControlTailscaleService } =
      await import('../../../src/main/services/remote-control-tailscale.service');

    await remoteControlTailscaleService.reconcile('https://mac.tailnet.ts.net:52864', 57948);

    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      'tailscale',
      ['serve', '--bg', '--https=52864', 'localhost:57948'],
      { timeout: 15_000, windowsHide: true, env: { TAILSCALE_BE_CLI: '1' } },
      expect.any(Function)
    );
  });

  function serveStatus(status: unknown): void {
    mockExecFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => cb(null, args[1] === 'status' ? JSON.stringify(status) : '', '')
    );
  }

  it('refuses to keep a listener while Tailscale Funnel exposes its port', async () => {
    serveStatus({
      Web: { 'mac.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'localhost:57948' } } } },
      AllowFunnel: { 'mac.tailnet.ts.net:443': true },
    });
    const { remoteControlTailscaleService, TailscaleFunnelEnabledError } =
      await import('../../../src/main/services/remote-control-tailscale.service');

    await expect(
      remoteControlTailscaleService.reconcile('https://mac.tailnet.ts.net', 57948)
    ).rejects.toBeInstanceOf(TailscaleFunnelEnabledError);

    expect(mockExecFile).toHaveBeenCalledOnce();
  });

  it('refuses to configure Tailscale Serve on a port with Funnel on', async () => {
    serveStatus({ Foreground: { session: { AllowFunnel: { 'mac.tailnet.ts.net:443': true } } } });
    const { remoteControlTailscaleService } =
      await import('../../../src/main/services/remote-control-tailscale.service');

    await expect(
      remoteControlTailscaleService.configure('https://mac.tailnet.ts.net', 57948)
    ).rejects.toThrow(/Funnel/);

    expect(mockExecFile).not.toHaveBeenCalledWith(
      'tailscale',
      expect.arrayContaining(['--bg']),
      expect.anything(),
      expect.any(Function)
    );
  });

  it('configures Tailscale Serve when Funnel is only on another port', async () => {
    serveStatus({ AllowFunnel: { 'mac.tailnet.ts.net:8443': true } });
    const { remoteControlTailscaleService } =
      await import('../../../src/main/services/remote-control-tailscale.service');

    await remoteControlTailscaleService.configure('https://mac.tailnet.ts.net', 57948);

    expect(mockExecFile).toHaveBeenLastCalledWith(
      'tailscale',
      ['serve', '--bg', '--https=443', 'localhost:57948'],
      { timeout: 15_000, windowsHide: true, env: { TAILSCALE_BE_CLI: '1' } },
      expect.any(Function)
    );
  });

  it('updates only the managed HTTPS listener when stopping', async () => {
    const { remoteControlTailscaleService } =
      await import('../../../src/main/services/remote-control-tailscale.service');

    await remoteControlTailscaleService.stop('https://mac.tailnet.ts.net:52864');

    expect(mockExecFile).toHaveBeenCalledWith(
      'tailscale',
      ['serve', '--https=52864', 'off'],
      { timeout: 15_000, windowsHide: true, env: { TAILSCALE_BE_CLI: '1' } },
      expect.any(Function)
    );
  });
});
