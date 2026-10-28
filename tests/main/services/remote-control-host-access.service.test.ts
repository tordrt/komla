import { execFileSync, spawnSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: vi.fn(() => ({ directRemoteEnabled: true })) },
}));
vi.mock('../../../src/main/services/paired-device-registry.service', () => ({
  pairedDeviceRegistryService: { list: vi.fn(() => []), onChange: vi.fn(() => () => {}) },
}));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: { ensureInstalled: vi.fn() },
}));
vi.mock('../../../src/main/services/remote-control-host-launch', () => ({
  buildHostLaunchFile: vi.fn(),
}));
vi.mock('../../../src/main/services/ssh-connection.service', () => ({
  sshConnectionService: { hasOpenConnection: vi.fn() },
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: { list: vi.fn(() => []), get: vi.fn() },
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshCompanionInstallationId: vi.fn(),
  sshWorkspaceService: { resolveWorkspaceBasePath: vi.fn(), runWithInput: vi.fn() },
}));

import {
  buildSyncScript,
  buildTrustFile,
  credentialSpkiFromCose,
  phoneServerKey,
  phoneServerPort,
  RemoteControlHostAccessService,
} from '../../../src/main/services/remote-control-host-access.service';

import type { SshHost } from '../../../src/shared/types';
import type { PairedDeviceRecord } from '../../../src/shared/types/paired-device';

const COMPANION = resolve(__dirname, '../../../native');
const BINARY = join(COMPANION, 'target/debug/komla');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

function coseKey(): { cose: string; spki: string } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const encoded = isoCBOR.encode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ])
  );
  return {
    cose: Buffer.from(encoded).toString('base64url'),
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

function device(overrides: Partial<PairedDeviceRecord> = {}): PairedDeviceRecord {
  return {
    deviceId: 'a'.repeat(64),
    devicePublicKey: 'BBBB',
    credentialId: 'cred-1',
    publicKey: coseKey().cose,
    signCounter: 0,
    aaguid: null,
    label: 'iPhone',
    createdAt: '2026-10-15T00:00:00Z',
    lastUsedAt: null,
    transports: null,
    rpId: 'mac.tail1.ts.net',
    origin: 'https://mac.tail1.ts.net',
    ...overrides,
  };
}

const host: SshHost = { id: 'host-1', name: 'devbox', hostname: 'devbox', basePath: '~/.komla' };

const TAILSCALE_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'devbox.tail1.ts.net.' },
});

function syncOutput(serve: unknown = {}, extra = ''): string {
  return [
    '__KOMLA_PHONE__init',
    JSON.stringify({ fingerprint: 'f'.repeat(64), socketPath: '/remote/ws' }),
    extra,
    '__KOMLA_PHONE__status',
    TAILSCALE_STATUS,
    '__KOMLA_PHONE__serve',
    JSON.stringify(serve),
  ].join('\n');
}

describe('phone access trust', () => {
  it('converts an ES256 passkey to the SPKI the host verifies with', () => {
    const { cose, spki } = coseKey();

    expect(credentialSpkiFromCose(cose)).toBe(spki);
    const rsa = Buffer.from(
      isoCBOR.encode(
        new Map<number, unknown>([
          [1, 3],
          [3, -257],
        ])
      )
    );
    expect(credentialSpkiFromCose(rsa.toString('base64url'))).toBeNull();
    expect(credentialSpkiFromCose('not cbor')).toBeNull();
  });

  it('lets in only phones paired over HTTPS with a passkey the host can check', () => {
    const trust = JSON.parse(
      buildTrustFile(
        [
          device(),
          device({ deviceId: 'b'.repeat(64), origin: 'http://build.tail1.ts.net' }),
          device({ deviceId: 'c'.repeat(64), publicKey: 'AAAA' }),
        ],
        1234,
        15 * 60_000
      )
    );

    expect(trust.expiresAt).toBe(1234);
    expect(trust.resumeWindowMs).toBe(15 * 60_000);
    expect(trust.devices).toHaveLength(1);
    expect(trust.devices[0]).toMatchObject({
      deviceId: 'a'.repeat(64),
      credentialId: 'cred-1',
      label: 'iPhone',
      origin: 'https://mac.tail1.ts.net',
    });
  });

  it('gives each desktop install its own server folder and port on a host', () => {
    const first = phoneServerKey('/Users/me/.komla\0host-1');
    const second = phoneServerKey('/Users/me/.komla\0host-2');

    expect(first).not.toBe(second);
    expect(phoneServerPort(first)).toBeGreaterThanOrEqual(48100);
    expect(phoneServerPort(first)).toBeLessThan(48900);
  });
});

describe('RemoteControlHostAccessService', () => {
  let dir: string;
  let scripts: string[];
  let outputs: string[];
  let devices: PairedDeviceRecord[];
  let deviceListeners: Array<() => void>;
  let openConnection: boolean;
  let remoteEnabled: boolean;
  let now: number;
  let launch: string;
  let launchBuilds: number;
  let inputs: string[];
  let passkeyWindowMs: number;

  function makeService() {
    return new RemoteControlHostAccessService({
      statePath: join(dir, 'remote-host-access.json'),
      hosts: { list: () => [host], get: (id) => (id === host.id ? host : undefined) },
      devices: {
        list: () => devices,
        onChange: (listener) => {
          deviceListeners.push(() => listener(devices));
          return () => {};
        },
      },
      isRemoteControlEnabled: () => remoteEnabled,
      passkeyWindowMs: () => passkeyWindowMs,
      installationId: (hostId) => `/Users/me/.komla\0${hostId}`,
      resolveBasePath: async () => '/home/me/.komla',
      ensureCompanion: async () => '/home/me/.komla/helpers/komla',
      runWithInput: async (_host, script, input) => {
        scripts.push(script);
        inputs.push(input);
        return outputs.shift() ?? '';
      },
      launchFile: async (_host, basePath) => {
        launchBuilds += 1;
        if (!launch) throw new Error('a preset is malformed');
        return launch.replace('BASE', basePath);
      },
      hasOpenConnection: async () => openConnection,
      now: () => now,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-host-access-'));
    scripts = [];
    outputs = [];
    devices = [device()];
    deviceListeners = [];
    openConnection = true;
    remoteEnabled = true;
    now = 1_000_000;
    launch = JSON.stringify({ version: 1, hostId: 'host-1', base: 'BASE', projects: [] });
    launchBuilds = 0;
    inputs = [];
    passkeyWindowMs = 15 * 60_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets a host up, publishes it with Tailscale Serve and offers it to phones', async () => {
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    const service = makeService();

    const status = await service.setEnabled('host-1', true);

    const port = phoneServerPort(phoneServerKey('/Users/me/.komla\0host-1'));
    expect(status).toMatchObject({
      enabled: true,
      state: 'ready',
      url: `wss://devbox.tail1.ts.net:${port}/remote/ws`,
    });
    expect(scripts[1]).toContain(`serve --bg --https=${port} http://127.0.0.1:${port}`);
    expect(makeService().phoneHosts()).toEqual([
      {
        id: 'host-1',
        name: 'devbox',
        url: `wss://devbox.tail1.ts.net:${port}/remote/ws`,
        fingerprint: 'f'.repeat(64),
      },
    ]);
    remoteEnabled = false;
    expect(makeService().phoneHosts()).toEqual([]);
  });

  it('sends what phones may start there with the trust, and again when it changes', async () => {
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    const service = makeService();
    await service.setEnabled('host-1', true);

    const [trust, launchFile] = inputs[0]!.split('\n');
    expect(JSON.parse(trust!).devices).toHaveLength(1);
    expect(JSON.parse(launchFile!)).toMatchObject({ hostId: 'host-1', base: '/home/me/.komla' });

    const synced = scripts.length;
    service.hostConnected('host-1');
    await vi.waitFor(() => expect(service.list()[0]?.state).toBe('ready'));
    await new Promise((done) => setTimeout(done, 0));
    expect(scripts).toHaveLength(synced);

    launch = JSON.stringify({ version: 1, hostId: 'host-1', projects: [{ id: 'new' }] });
    outputs = [syncOutput({ AllowFunnel: {} }), '__KOMLA_PHONE__served'];
    launchBuilds = 0;
    service.hostConnected('host-1');
    await vi.waitFor(() => expect(inputs.some((input) => input.includes('"id":"new"'))).toBe(true));
    expect(launchBuilds).toBe(1);
  });

  it('still renews trust when the launch options cannot be built', async () => {
    launch = '';
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    const service = makeService();

    const status = await service.setEnabled('host-1', true);

    expect(status).toMatchObject({ state: 'ready' });
    const [trust, launchFile] = inputs[0]!.split('\n');
    expect(JSON.parse(trust!).devices).toHaveLength(1);
    expect(launchFile).toBe('');
  });

  it('keeps an existing Serve route and refuses to run while Funnel is on', async () => {
    const port = phoneServerPort(phoneServerKey('/Users/me/.komla\0host-1'));
    outputs = [
      syncOutput({
        TCP: { [port]: { HTTPS: true } },
        Web: { [`devbox:${port}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
      }),
    ];
    const service = makeService();
    expect((await service.setEnabled('host-1', true)).state).toBe('ready');
    expect(scripts).toHaveLength(1);

    outputs = [syncOutput({ AllowFunnel: { [`devbox.tail1.ts.net:${port}`]: true } }), ''];
    devices = [device({ label: 'Renamed' })];
    service.start();
    for (const notify of deviceListeners) notify();
    await vi.waitFor(() => expect(service.list()[0]?.state).toBe('needs-attention'));

    expect(service.list()[0]?.message).toMatch(/Funnel is on/);
    expect(scripts.at(-1)).toContain('kill-server');
    expect(service.phoneHosts()).toEqual([]);
  });

  it('explains what a host is missing', async () => {
    const service = makeService();

    outputs = ['__KOMLA_PHONE__init\n{}'];
    expect((await service.setEnabled('host-1', true)).message).toMatch(/identity/);
    outputs = [syncOutput().replace(TAILSCALE_STATUS, 'missing')];
    expect((await service.setEnabled('host-1', true)).message).toMatch(/not installed/);
    outputs = [syncOutput(), '__KOMLA_PHONE__refused\nAccess denied: serve config denied'];
    expect((await service.setEnabled('host-1', true)).message).toMatch(/--operator=\$USER/);
    outputs = [syncOutput({}, '__KOMLA_PHONE__exited\nAddress already in use')];
    expect((await service.setEnabled('host-1', true)).message).toMatch(/already in use/);
  });

  it('never opens a connection just to follow a phone list change', async () => {
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    const service = makeService();
    service.start();
    await service.setEnabled('host-1', true);
    openConnection = false;

    devices = [];
    for (const notify of deviceListeners) notify();
    await vi.waitFor(() => expect(service.list()[0]?.state).toBe('pending'));
    expect(scripts).toHaveLength(2);
    expect(service.phoneHosts()).toHaveLength(1);

    outputs = [syncOutput({ AllowFunnel: {} }), '__KOMLA_PHONE__served'];
    service.hostConnected('host-1');
    await vi.waitFor(() => expect(service.list()[0]?.state).toBe('ready'));
    const trust = scripts.length;
    service.hostConnected('host-1');
    await Promise.resolve();
    expect(scripts).toHaveLength(trust);
    now += 25 * 60 * 60 * 1000;
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    service.hostConnected('host-1');
    await vi.waitFor(() => expect(scripts.length).toBeGreaterThan(trust));
  });

  it('leaves hosts alone when a phone only signs in', async () => {
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    const service = makeService();
    service.start();
    await service.setEnabled('host-1', true);
    const synced = scripts.length;

    devices = [{ ...devices[0]!, signCounter: 9, lastUsedAt: '2026-04-30T00:00:00.000Z' }];
    for (const notify of deviceListeners) notify();
    openConnection = false;
    for (const notify of deviceListeners) notify();
    await new Promise((done) => setTimeout(done, 0));

    expect(scripts).toHaveLength(synced);
    expect(service.list()[0]).toMatchObject({ state: 'ready' });
  });

  it('sends a changed passkey window to hosts now or when Komla next connects', async () => {
    // Serve script runs take no input; sync runs send the trust file first.
    const lastWindow = () =>
      JSON.parse(
        inputs
          .filter((input) => input.startsWith('{'))
          .at(-1)!
          .split('\n')[0]
      ).resumeWindowMs;
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    const service = makeService();
    await service.setEnabled('host-1', true);
    expect(lastWindow()).toBe(15 * 60_000);

    passkeyWindowMs = 60 * 60_000;
    outputs = [syncOutput({ AllowFunnel: {} }), '__KOMLA_PHONE__served'];
    service.passkeyWindowChanged();
    await vi.waitFor(() => expect(lastWindow()).toBe(60 * 60_000));

    openConnection = false;
    passkeyWindowMs = 5 * 60_000;
    service.passkeyWindowChanged();
    await vi.waitFor(() => expect(service.list()[0]?.state).toBe('pending'));
    expect(service.list()[0]?.message).toMatch(/passkey setting/);
    expect(lastWindow()).toBe(60 * 60_000);
    outputs = [syncOutput({ AllowFunnel: {} }), '__KOMLA_PHONE__served'];
    service.hostConnected('host-1');
    await vi.waitFor(() => expect(lastWindow()).toBe(5 * 60_000));
  });

  it('stops host servers when remote control or phone access is turned off', async () => {
    outputs = [syncOutput(), '__KOMLA_PHONE__served'];
    const service = makeService();
    await service.setEnabled('host-1', true);

    openConnection = false;
    remoteEnabled = false;
    await service.remoteControlTurnedOff();
    expect(scripts).toHaveLength(2);
    service.hostConnected('host-1');
    await vi.waitFor(() => expect(scripts.at(-1)).toContain('kill-server'));

    remoteEnabled = true;
    const status = await service.setEnabled('host-1', false);
    expect(status).toMatchObject({ enabled: false, state: 'off' });
    expect(scripts.at(-1)).toContain('serve --https=');
  });
});

describe.skipIf(process.platform === 'win32' || !hasTmux)('phone server sync script', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      spawnSync('tmux', ['-L', 'komla-phone-script-test', 'kill-server']);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes trust and config, starts the server once and reports Tailscale', () => {
    execFileSync('cargo', ['build', '--quiet', '--manifest-path', join(COMPANION, 'Cargo.toml')], {
      stdio: 'inherit',
    });
    root = mkdtempSync(join(tmpdir(), 'komla-phone-script-'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(
      join(root, 'bin/tailscale'),
      `#!/bin/sh\ncase "$1" in status) echo '${TAILSCALE_STATUS}';; serve) echo '{}';; esac\n`
    );
    chmodSync(join(root, 'bin/tailscale'), 0o755);
    const stateDir = join(root, 'base/helpers/companion/phone-test');
    const config = JSON.stringify({
      version: 1,
      port: 48899,
      basePath: join(root, 'base'),
      tmuxSocket: 'komla-v1-unused',
      hostName: 'devbox',
    });
    const script = buildSyncScript({
      stateDir,
      socket: 'komla-phone-script-test',
      port: 48899,
      binary: BINARY,
      config,
      signature: 'sig-1',
    });
    const launch = JSON.stringify({ version: 1, hostId: 'host-1', projects: [], presets: [] });
    const run = (launchFile = launch) =>
      execFileSync('sh', ['-c', script], {
        input: `${buildTrustFile([device()], Date.now() + 60_000, 15 * 60_000)}\n${launchFile}`,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TMUX: '' },
      });

    const output = run();

    expect(output).toMatch(/__KOMLA_PHONE__init\n\{"fingerprint":"[0-9a-f]{64}"/);
    expect(output).not.toContain('__KOMLA_PHONE__exited');
    expect(output).toContain('"DNSName":"devbox.tail1.ts.net."');
    expect(JSON.parse(readFileSync(join(stateDir, 'trust.json'), 'utf8')).devices).toHaveLength(1);
    expect(readFileSync(join(stateDir, 'launch.json'), 'utf8')).toBe(launch);
    expect(readFileSync(join(stateDir, 'config.json'), 'utf8')).toBe(config);
    const pane = () =>
      execFileSync(
        'tmux',
        ['-L', 'komla-phone-script-test', 'list-panes', '-a', '-F', '#{pane_pid}'],
        {
          encoding: 'utf8',
        }
      ).trim();
    const firstPid = pane();
    // No launch file this time (it couldn't be built): the host keeps the one it has.
    run('');
    expect(pane()).toBe(firstPid);
    expect(readFileSync(join(stateDir, 'launch.json'), 'utf8')).toBe(launch);

    // Funnel turned on for the port: the server stops, and doesn't start again.
    writeFileSync(
      join(root, 'bin/tailscale'),
      `#!/bin/sh\ncase "$1" in status) echo '${TAILSCALE_STATUS}';; serve) printf '{\\n  "AllowFunnel": {\\n    "devbox.tail1.ts.net:48899": true\\n  }\\n}\\n';; esac\n`
    );
    for (let i = 0; i < 2; i += 1) {
      const funnelOutput = run();
      expect(funnelOutput).toContain('__KOMLA_PHONE__funnel');
      expect(funnelOutput).toContain('"devbox.tail1.ts.net:48899": true');
      expect(
        spawnSync('tmux', ['-L', 'komla-phone-script-test', 'has-session']).status
      ).not.toBe(0);
    }
  });
});
