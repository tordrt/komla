import { describe, expect, it } from 'vitest';

import { tailscaleCommand } from '../../../src/main/lib/tailscale-command';

const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

describe('tailscaleCommand', () => {
  it('finds the CLI in /usr/local/bin when the app only inherited the system PATH', () => {
    const command = tailscaleCommand({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      isExecutable: (file) => file === '/usr/local/bin/tailscale' || file === MAC_APP_BINARY,
    });

    expect(command.file).toBe('/usr/local/bin/tailscale');
    expect(command.display).toBe('tailscale');
  });

  it('runs the Mac app binary when the CLI was never installed on PATH', () => {
    const command = tailscaleCommand({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      isExecutable: (file) => file === MAC_APP_BINARY,
    });

    expect(command.file).toBe(MAC_APP_BINARY);
    // Shown in Settings, where a bare "tailscale" would not run either.
    expect(command.display).toBe(MAC_APP_BINARY);
  });

  it('asks the Mac app binary to act as the CLI, as it otherwise does only under a shell', () => {
    const command = tailscaleCommand({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/me' },
      isExecutable: (file) => file === MAC_APP_BINARY,
    });

    expect(command.env).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/Users/me',
      TAILSCALE_BE_CLI: '1',
    });
  });

  it('prefers a tailscale already on PATH', () => {
    const command = tailscaleCommand({
      platform: 'linux',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: (file) => file === '/usr/bin/tailscale' || file === '/usr/local/bin/tailscale',
    });

    expect(command.file).toBe('/usr/bin/tailscale');
  });

  it('leaves the bare name when nothing is found, so a missing CLI still fails with ENOENT', () => {
    const command = tailscaleCommand({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: () => false,
    });

    expect(command.file).toBe('tailscale');
  });

  it('leaves Windows lookup to the system', () => {
    const command = tailscaleCommand({
      platform: 'win32',
      env: { PATH: String.raw`C:\Program Files\Tailscale` },
      isExecutable: () => true,
    });

    expect(command.file).toBe('tailscale');
  });
});
