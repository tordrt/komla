import { generateKeyPairSync, randomBytes, sign as nodeSign } from 'crypto';
import { request } from 'http';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Socket } from 'net';

import {
  Peer,
  buildDeviceProof,
  classifyRelayFrame,
  deviceIdFromPublicKey,
  encodeBase64,
  exportDevicePublicKey,
  fingerprintFromPublicKey,
  generateDeviceKeyPair,
  signDeviceProof,
} from '@komla/remote-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({}) },
}));
vi.mock('../../../src/main/services/install-identity.service', () => ({
  installIdentityService: {
    getPublicKey: vi.fn(),
    getFingerprint: vi.fn(),
    sign: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/paired-device-registry.service', () => ({
  pairedDeviceRegistryService: {
    list: vi.fn(() => []),
    getByDeviceId: vi.fn(() => null),
    getByCredentialId: vi.fn(() => null),
    add: vi.fn(),
    recordAuthSuccess: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/remote-control-session.service', () => ({
  remoteControlSessionService: {
    attachPeer: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

vi.mock('../../../src/main/services/window.service', () => ({
  windowService: {
    broadcastWhenReady: vi.fn(),
  },
}));

import { RemoteControlDirectService } from '../../../src/main/services/remote-control-direct.service';
import { RemoteSessionResumptionStore } from '../../../src/main/lib/remote-session-resumption';

import type { PairedDeviceRecord } from '../../../src/shared/types/paired-device';

const FINGERPRINT = '0123456789abcdef'.repeat(4);

interface TestRegistry {
  list: ReturnType<typeof vi.fn>;
  getByDeviceId: ReturnType<typeof vi.fn>;
  getByCredentialId: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  recordAuthSuccess: ReturnType<typeof vi.fn>;
}

function makeService(
  webAssetDir: string,
  options: {
    getFingerprint?: () => Promise<string>;
    peerHandshakeTimeoutMs?: number;
    pairingOfferTimeoutMs?: number;
    heartbeatPingMs?: number;
    heartbeatTimeoutMs?: number;
  } = {}
): {
  service: RemoteControlDirectService;
  registry: TestRegistry;
  emitStateChange: ReturnType<typeof vi.fn>;
  terminalPresentationTracking: {
    enable: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
  };
} {
  const emitStateChange = vi.fn();
  const registry: TestRegistry = {
    list: vi.fn(() => []),
    getByDeviceId: vi.fn(() => null),
    getByCredentialId: vi.fn(() => null),
    add: vi.fn(),
    recordAuthSuccess: vi.fn(),
  };
  const terminalPresentationTracking = {
    enable: vi.fn(),
    disable: vi.fn(),
  };
  const service = new RemoteControlDirectService({
    installIdentity: {
      getPublicKey: async () => new Uint8Array(91).fill(0xab),
      getFingerprint: options.getFingerprint ?? (async () => FINGERPRINT),
      sign: async () => new Uint8Array(64).fill(0xcd),
    },
    pairedDeviceRegistry: registry,
    createAppSession: vi.fn(() => ({ dispose: vi.fn() })),
    rng: {
      challenge: () => new Uint8Array(32).fill(0xef),
      pairingSecret: () => 'A'.repeat(43),
    },
    peerHandshakeTimeoutMs: options.peerHandshakeTimeoutMs ?? 250,
    pairingOfferTimeoutMs: options.pairingOfferTimeoutMs,
    heartbeatPingMs: options.heartbeatPingMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    webAssetDir,
    emitStateChange,
    terminalPresentationTracking,
  });
  return { service, registry, emitStateChange, terminalPresentationTracking };
}

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGetWithHeaders(url: string): Promise<{
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function expectedPortChange(
  info: ReturnType<RemoteControlDirectService['getInfo']>
): { oldPort: number; newPort: number } | null {
  if (!info || info.port === info.preferredPort) return null;
  return { oldPort: info.preferredPort, newPort: info.port };
}

function upgrade(url: string, origin?: string): Promise<{ statusCode: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from('komla-test-key').toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('upgrade', (res, socket) => {
      resolve({ statusCode: res.statusCode ?? 0, socket });
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A trusted phone that already holds a resume grant: the desktop runs a real
 * install key so the browser Peer can verify it, and the phone resumes over a
 * WebSocket without a passkey.
 */
async function startResumablePhone(webAssetDir: string) {
  const install = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const installPubkey = new Uint8Array(install.publicKey.export({ format: 'der', type: 'spki' }));
  const fingerprint = await fingerprintFromPublicKey(installPubkey);
  const makeDevice = async (credentialId: string, label: string) => {
    const keys = await generateDeviceKeyPair();
    const publicKey = await exportDevicePublicKey(keys.publicKey);
    return {
      keys,
      publicKey,
      deviceId: await deviceIdFromPublicKey(publicKey),
      credentialId,
      label,
    };
  };
  const phone = await makeDevice('credential-1', 'Phone');
  const tablet = await makeDevice('credential-2', 'Tablet');
  const { deviceId } = phone;
  const records: PairedDeviceRecord[] = [];
  const registry = {
    list: () => [...records],
    getByDeviceId: (id: string) => records.find((record) => record.deviceId === id) ?? null,
    getByCredentialId: (id: string) => records.find((record) => record.credentialId === id) ?? null,
    add: (record: PairedDeviceRecord) => records.push(record),
    recordAuthSuccess: vi.fn((id: string, signCounter: number, lastUsedAt: string) => {
      const index = records.findIndex((record) => record.credentialId === id);
      if (index < 0) throw new Error('credential not found');
      records[index] = { ...records[index]!, signCounter, lastUsedAt };
      return records[index]!;
    }),
  };
  let clockOffset = 0;
  const resumption = new RemoteSessionResumptionStore({
    generateToken: () => randomBytes(32),
    now: () => Date.now() + clockOffset,
    ttlMs: () => 120_000,
    maxAgeMs: 8 * 60 * 60_000,
  });
  const createAppSession = vi.fn(() => ({ dispose: vi.fn() }));
  const service = new RemoteControlDirectService({
    installIdentity: {
      getPublicKey: async () => installPubkey,
      getFingerprint: async () => fingerprint,
      sign: async (data) =>
        new Uint8Array(
          nodeSign('sha256', Buffer.from(data), {
            key: install.privateKey,
            dsaEncoding: 'ieee-p1363',
          })
        ),
    },
    pairedDeviceRegistry: registry,
    createAppSession,
    resumption,
    webAssetDir,
    emitStateChange: vi.fn(),
    terminalPresentationTracking: { enable: vi.fn(), disable: vi.fn() },
  });
  const info = await service.start();
  const credentialId = phone.credentialId;
  for (const device of [phone, tablet]) {
    records.push({
      deviceId: device.deviceId,
      devicePublicKey: encodeBase64(device.publicKey),
      credentialId: device.credentialId,
      publicKey: 'unused-by-resume',
      signCounter: 1,
      aaguid: null,
      label: device.label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      transports: ['internal'],
      rpId: new URL(info.httpOrigin).hostname,
      origin: info.httpOrigin,
    });
  }

  /**
   * Resumes with `token`, or with a grant from an earlier connection that just
   * ended, and resolves with the token from the desktop's pair:authenticated.
   */
  async function resume(
    token?: string,
    device = phone
  ): Promise<{ resumeToken: string; close: () => void; closed: Promise<number> }> {
    const attempt = await hello(token, device);
    const challenge = attempt.reply;
    const proof = await signDeviceProof(
      device.keys.privateKey,
      buildDeviceProof('resume', String(challenge.challenge), attempt.peer.getChannelBinding())
    );
    await attempt.peer.sendEncryptedJson({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(proof),
    });
    const authenticated = await attempt.nextFrame();
    expect(authenticated).toMatchObject({ type: 'pair:authenticated', deviceId: device.deviceId });
    return {
      resumeToken: String(authenticated.resumeToken),
      close: attempt.close,
      closed: attempt.closed,
    };
  }

  /** Connects and says hello in resume mode, resolving with the desktop's first reply. */
  async function hello(token: string | undefined, device = phone, capabilities?: string[]) {
    let resumeToken = token;
    if (!resumeToken) {
      resumeToken = resumption.issue(device.deviceId).token;
      resumption.release(resumeToken);
    }
    // Browsers send Origin themselves; Node's WebSocket takes it as a header.
    const NodeWebSocket = WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> }
    ) => WebSocket;
    const ws = new NodeWebSocket(info.wsUrl, { headers: { Origin: info.httpOrigin } });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
    });
    ws.binaryType = 'arraybuffer';
    const binaryFrames: number[] = [];
    const peer = new Peer({
      role: 'client',
      transport: {
        send: (data) => ws.send(data),
        sendBinary: (data) => ws.send(data),
        close: () => ws.close(),
      },
      expectedFingerprint: fingerprint,
    });
    const frames: unknown[] = [];
    const waiters: Array<() => void> = [];
    peer.onMessage((message) => {
      if (message.kind !== 'json') return;
      frames.push(message.data);
      waiters.splice(0).forEach((wake) => wake());
    });
    const nextFrame = async (): Promise<{ type: string; [key: string]: unknown }> => {
      while (frames.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      return frames.shift() as { type: string; [key: string]: unknown };
    };
    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        binaryFrames.push(event.data.byteLength);
        peer.handleBinaryMessage(new Uint8Array(event.data));
        return;
      }
      const data = String(event.data);
      if (classifyRelayFrame(data) === null) peer.handleMessage(data);
    });
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener('close', (event) => resolve(event.code), { once: true })
    );
    const established = new Promise<void>((resolve) => peer.onEstablished(resolve));
    void peer.connect();
    await established;

    await peer.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'resume',
      deviceId: device.deviceId,
      resumeToken,
      ...(capabilities ? { capabilities } : {}),
    });
    return {
      peer,
      nextFrame,
      binaryFrames,
      reply: await nextFrame(),
      close: () => ws.close(),
      closed,
    };
  }

  return {
    service,
    registry,
    records,
    resumption,
    createAppSession,
    deviceId,
    credentialId,
    resume,
    hello,
    tablet,
    deviceKeys: phone.keys,
    advanceClock: (ms: number) => {
      clockOffset += ms;
    },
  };
}

describe('RemoteControlDirectService', () => {
  let service: RemoteControlDirectService;
  let webAssetDir: string;

  beforeEach(async () => {
    webAssetDir = await mkdtemp(join(tmpdir(), 'komla-remote-web-'));
    await writeFile(
      join(webAssetDir, 'index.html'),
      '<!doctype html><html><head><title>Komla Remote</title></head><body><script src="./assets/app.js"></script></body></html>'
    );
    service = makeService(webAssetDir).service;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.stop();
    await rm(webAssetDir, { recursive: true, force: true });
  });

  it('starts on localhost by default and exposes a pair URL', async () => {
    const offer = await service.startPairing();
    const info = service.getInfo();

    expect(info?.host).toBe('127.0.0.1');
    expect(info?.preferredPort).toBe(52864);
    expect(info?.localOrigin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(info?.httpOrigin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(info?.wsUrl).toBe(
      `${info!.httpOrigin.replace(/^http:/, 'ws:')}/remote/ws?fp=${FINGERPRINT}`
    );
    expect(offer).toEqual({
      pairUrl: `${info!.httpOrigin}/remote/pair#fp=${FINGERPRINT}&secret=${'A'.repeat(43)}`,
      fingerprint: FINGERPRINT,
      pairingSecret: 'A'.repeat(43),
    });
    expect(service.getState()).toEqual({
      server: info,
      pairingOffer: offer,
      portChange: expectedPortChange(info),
    });
  });

  it('tracks terminal presentations only while the server is running', async () => {
    const { service: localService, terminalPresentationTracking } = makeService(webAssetDir);

    await localService.start();
    await localService.start();
    expect(terminalPresentationTracking.enable).toHaveBeenCalledTimes(1);
    expect(terminalPresentationTracking.disable).not.toHaveBeenCalled();

    await localService.stop();
    expect(terminalPresentationTracking.disable).toHaveBeenCalledTimes(1);
  });

  it('uses a Tailscale HTTPS origin for browser URLs and WebAuthn endpoint data', async () => {
    const info = await service.start({ publicOrigin: 'https://mac.tailnet.ts.net' });
    const offer = await service.startPairing();

    expect(info.localOrigin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(info.httpOrigin).toBe('https://mac.tailnet.ts.net');
    expect(info.wsUrl).toBe(`wss://mac.tailnet.ts.net/remote/ws?fp=${FINGERPRINT}`);
    expect(offer.pairUrl).toBe(
      `https://mac.tailnet.ts.net/remote/pair#fp=${FINGERPRINT}&secret=${'A'.repeat(43)}`
    );

    const response = await httpGet(`${info.localOrigin}/remote/config`);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      fingerprint: FINGERPRINT,
      wsUrl: `wss://mac.tailnet.ts.net/remote/ws?fp=${FINGERPRINT}`,
    });
  });

  it('updates an already-running server origin before creating a pairing offer', async () => {
    const localInfo = await service.start();
    const offer = await service.startPairing({ publicOrigin: 'https://mac.tailnet.ts.net' });
    const info = service.getInfo();

    expect(localInfo.httpOrigin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(info?.httpOrigin).toBe('https://mac.tailnet.ts.net');
    expect(info?.wsUrl).toBe(`wss://mac.tailnet.ts.net/remote/ws?fp=${FINGERPRINT}`);
    expect(offer.pairUrl).toBe(
      `https://mac.tailnet.ts.net/remote/pair#fp=${FINGERPRINT}&secret=${'A'.repeat(43)}`
    );
  });

  it('moves an open pairing offer to the origin the server now serves', async () => {
    await service.startPairing();
    service.setPublicOrigin('https://mac.tailnet.ts.net');

    expect(service.getState().pairingOffer?.pairUrl).toBe(
      `https://mac.tailnet.ts.net/remote/pair#fp=${FINGERPRINT}&secret=${'A'.repeat(43)}`
    );
  });

  it('rejects non-HTTPS public origins', async () => {
    await expect(service.start({ publicOrigin: 'http://mac.local' })).rejects.toThrow(/https:\/\//);
    expect(service.getInfo()).toBeNull();

    const info = await service.start();
    expect(info.port).toBe(info.preferredPort);
  });

  it('serializes concurrent starts and enables terminal tracking once', async () => {
    const { service: localService, terminalPresentationTracking } = makeService(webAssetDir);

    const [first, second] = await Promise.all([localService.start(), localService.start()]);

    expect(second).toEqual(first);
    expect(terminalPresentationTracking.enable).toHaveBeenCalledOnce();
    await localService.stop();
  });

  it('waits for an in-flight start before stopping the server', async () => {
    let releaseFingerprint!: () => void;
    const fingerprintReady = new Promise<void>((resolve) => {
      releaseFingerprint = resolve;
    });
    const { service: localService, terminalPresentationTracking } = makeService(webAssetDir, {
      getFingerprint: async () => {
        await fingerprintReady;
        return FINGERPRINT;
      },
    });

    const starting = localService.start();
    await Promise.resolve();
    const stopping = localService.stop();
    releaseFingerprint();

    await starting;
    await stopping;
    expect(localService.getInfo()).toBeNull();
    expect(terminalPresentationTracking.enable).toHaveBeenCalledOnce();
    expect(terminalPresentationTracking.disable).toHaveBeenCalledOnce();
  });

  it('reports and clears direct pairing state', async () => {
    expect(service.getState()).toEqual({ server: null, pairingOffer: null, portChange: null });

    await service.startPairing();
    expect(service.getState().pairingOffer?.pairingSecret).toBe('A'.repeat(43));

    service.cancelPairing();
    expect(service.getState().pairingOffer).toBeNull();

    await service.stop();
    expect(service.getState()).toEqual({ server: null, pairingOffer: null, portChange: null });
  });

  it('expires direct pairing offers without stopping the server', async () => {
    vi.useFakeTimers();
    const { service: localService, emitStateChange } = makeService(webAssetDir, {
      pairingOfferTimeoutMs: 1_000,
    });
    await localService.startPairing();
    const info = localService.getInfo();
    expect(localService.getState().pairingOffer?.pairingSecret).toBe('A'.repeat(43));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(localService.getState()).toEqual({
      server: info,
      pairingOffer: null,
      portChange: expectedPortChange(info),
    });
    expect(emitStateChange).toHaveBeenLastCalledWith({
      server: info,
      pairingOffer: null,
      portChange: expectedPortChange(info),
    });
    await localService.stop();
  });

  it('emits state updates when direct pairing state changes', async () => {
    const { service: localService, emitStateChange } = makeService(webAssetDir);
    const offer = await localService.startPairing();

    expect(emitStateChange).toHaveBeenLastCalledWith({
      server: localService.getInfo(),
      pairingOffer: offer,
      portChange: expectedPortChange(localService.getInfo()),
    });

    const listener = vi.fn();
    const unsubscribe = localService.onStateChange(listener);
    localService.cancelPairing();

    expect(emitStateChange).toHaveBeenLastCalledWith({
      server: localService.getInfo(),
      pairingOffer: null,
      portChange: expectedPortChange(localService.getInfo()),
    });
    expect(listener).toHaveBeenCalledWith(localService.getState());

    unsubscribe();
    await localService.startPairing();
    expect(listener).toHaveBeenCalledOnce();

    await localService.stop();
  });

  it('rejects wildcard bind hosts', async () => {
    await expect(service.start({ host: '0.0.0.0' })).rejects.toThrow(/wildcard/);
  });

  it('rejects non-localhost hosts until HTTPS origins are available', async () => {
    await expect(service.start({ host: '100.64.0.1' })).rejects.toThrow(/HTTPS origins/);
  });

  it('serves the direct remote app shell at the dedicated pair URL path', async () => {
    const offer = await service.startPairing();
    const pageUrl = offer.pairUrl.replace(/#.*$/, '');

    const response = await httpGetWithHeaders(pageUrl);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>Komla Remote</title>');
    expect(response.body).not.toContain(FINGERPRINT);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).not.toContain(
      "script-src 'self' 'unsafe-inline'"
    );
  });

  it('serves direct connection config separately without caching it', async () => {
    const info = await service.start({ publicOrigin: 'https://mac.tailnet.ts.net' });

    const response = await httpGetWithHeaders(`${info.localOrigin}/remote/config`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({
      fingerprint: FINGERPRINT,
      wsUrl: `wss://mac.tailnet.ts.net/remote/ws?fp=${FINGERPRINT}`,
    });
  });

  it('redirects root and extensionless remote URLs to asset-safe paths', async () => {
    const info = await service.start();

    const root = await httpGetWithHeaders(`${info.httpOrigin}/`);
    const remote = await httpGetWithHeaders(`${info.httpOrigin}/remote`);
    const pair = await httpGetWithHeaders(`${info.httpOrigin}/remote/pair/`);

    expect(root.statusCode).toBe(308);
    expect(root.headers.location).toBe('/remote/');
    expect(remote.statusCode).toBe(308);
    expect(remote.headers.location).toBe('/remote/');
    expect(pair.statusCode).toBe(308);
    expect(pair.headers.location).toBe('/remote/pair');
  });

  it('serves the installable app files with their types and a policy that allows them', async () => {
    await mkdir(join(webAssetDir, 'icons'));
    await writeFile(join(webAssetDir, 'manifest.webmanifest'), '{"name":"Komla Remote"}');
    await writeFile(join(webAssetDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
    await writeFile(join(webAssetDir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50]));
    const info = await service.start();

    const manifest = await httpGetWithHeaders(`${info.httpOrigin}/remote/manifest.webmanifest`);
    const worker = await httpGetWithHeaders(`${info.httpOrigin}/remote/sw.js`);
    const icon = await httpGetWithHeaders(`${info.httpOrigin}/remote/icons/icon-192.png`);
    const page = await httpGetWithHeaders(`${info.httpOrigin}/remote/`);

    expect(manifest.headers['content-type']).toBe('application/manifest+json');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    expect(worker.headers['content-type']).toBe('text/javascript; charset=utf-8');
    // A stale worker would keep serving an old client after Komla updates.
    expect(worker.headers['cache-control']).toBe('no-cache');
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.headers['cache-control']).toBe('public, max-age=3600');
    const policy = page.headers['content-security-policy'];
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("default-src 'none'");
  });

  it('serves a local health endpoint', async () => {
    const info = await service.start();

    const response = await httpGet(`${info.httpOrigin}/remote/health`);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it('rejects websocket upgrades with a mismatched fingerprint', async () => {
    const info = await service.start();

    const response = await upgrade(`${info.httpOrigin}/remote/ws?fp=${'f'.repeat(64)}`);

    expect(response.statusCode).toBe(403);
  });

  it('accepts websocket upgrades for the current install fingerprint', async () => {
    const info = await service.start();

    const response = await upgrade(info.wsUrl.replace(/^ws:/, 'http:'), info.httpOrigin);

    expect(response.statusCode).toBe(101);
    response.socket?.destroy();
  });

  it('accepts websocket upgrades from the Tailscale origin it serves', async () => {
    const info = await service.start({ publicOrigin: 'https://mac.tailnet.ts.net' });

    const response = await upgrade(
      `${info.localOrigin}/remote/ws?fp=${FINGERPRINT}`,
      'https://mac.tailnet.ts.net'
    );

    expect(response.statusCode).toBe(101);
    response.socket?.destroy();
  });

  it('rejects websocket upgrades from other web origins', async () => {
    const info = await service.start();
    const url = info.wsUrl.replace(/^ws:/, 'http:');

    // Any page open in a browser on this machine can reach localhost.
    expect((await upgrade(url, 'https://evil.example')).statusCode).toBe(403);
    expect(
      (await upgrade(url, info.localOrigin.replace('localhost', '127.0.0.1'))).statusCode
    ).toBe(403);
    expect((await upgrade(url)).statusCode).toBe(403);
  });

  it('emits state when a direct websocket closes', async () => {
    const { service: localService, emitStateChange } = makeService(webAssetDir);
    const info = await localService.start();
    const response = await upgrade(info.wsUrl.replace(/^ws:/, 'http:'), info.httpOrigin);
    expect(response.statusCode).toBe(101);
    emitStateChange.mockClear();

    response.socket?.destroy();

    await vi.waitFor(() => expect(emitStateChange).toHaveBeenCalledOnce());
    expect(emitStateChange).toHaveBeenLastCalledWith({
      server: info,
      pairingOffer: null,
      portChange: expectedPortChange(info),
    });
    await localService.stop();
  });

  it('keeps a phone that is still logging in when another connection arrives', async () => {
    const info = await service.start();
    const url = info.wsUrl.replace(/^ws:/, 'http:');

    const first = await upgrade(url, info.httpOrigin);
    expect(first.statusCode).toBe(101);
    const firstEnded = vi.fn();
    first.socket?.on('end', firstEnded).resume();

    const second = await upgrade(url, info.httpOrigin);
    expect(second.statusCode).toBe(101);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(firstEnded).not.toHaveBeenCalled();
    first.socket?.destroy();
    second.socket?.destroy();
  });

  it('replaces the oldest unauthenticated websocket once four are waiting', async () => {
    const info = await service.start();
    const url = info.wsUrl.replace(/^ws:/, 'http:');
    const connections: Array<{ socket?: Socket; ended: ReturnType<typeof vi.fn> }> = [];

    for (let i = 0; i < 5; i++) {
      const response = await upgrade(url, info.httpOrigin);
      expect(response.statusCode).toBe(101);
      const ended = vi.fn();
      response.socket?.on('end', ended).resume();
      connections.push({ socket: response.socket, ended });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(connections.map(({ ended }) => ended.mock.calls.length > 0)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    for (const { socket } of connections) socket?.destroy();
  });

  it('revokes the resume grant when the desktop disconnects the phone', async () => {
    const phone = await startResumablePhone(webAssetDir);
    const { resumeToken } = await phone.resume();
    await vi.waitFor(() => expect(phone.service.getState().connectedDevice).toBeDefined());

    expect(phone.service.disconnectActiveClient()).toBe(true);

    // A reload would otherwise reconnect silently, without the passkey.
    expect(phone.resumption.consume(phone.deviceId, resumeToken)).toBeNull();
    await phone.service.stop();
  });

  it('resumes silently after a long connection drops', async () => {
    const phone = await startResumablePhone(webAssetDir);
    const first = await phone.resume();
    await vi.waitFor(() => expect(phone.service.getState().connectedDevice).toBeDefined());

    // The phone stays connected well past two minutes, then loses its network.
    phone.advanceClock(45 * 60_000);
    first.close();
    await vi.waitFor(() => expect(phone.service.getState().connectedDevice).toBeUndefined());

    await phone.resume(first.resumeToken);
    await vi.waitFor(() => expect(phone.service.getState().connectedDevice).toBeDefined());
    await phone.service.stop();
  });

  it('lets a phone sign in again while its old connection has not noticed it dropped', async () => {
    const phone = await startResumablePhone(webAssetDir);
    // The phone's network dropped without a close, so the desktop still holds this connection.
    const stale = await phone.resume();
    await vi.waitFor(() => expect(phone.createAppSession).toHaveBeenCalledTimes(1));
    const staleSession = phone.createAppSession.mock.results[0]!.value as {
      dispose: ReturnType<typeof vi.fn>;
    };

    await phone.resume(stale.resumeToken);

    await vi.waitFor(() => expect(phone.createAppSession).toHaveBeenCalledTimes(2));
    expect(staleSession.dispose).toHaveBeenCalled();
    expect(await stale.closed).toBe(4409);
    expect(phone.service.getState().connectedDevice).toMatchObject({ label: 'Phone' });
    await phone.service.stop();
  });

  it('lets another device sign in and closes the connected one for good', async () => {
    const phone = await startResumablePhone(webAssetDir);
    const first = await phone.resume();
    await vi.waitFor(() => expect(phone.service.getState().connectedDevice).toBeDefined());
    const phoneSession = phone.createAppSession.mock.results[0]!.value as {
      dispose: ReturnType<typeof vi.fn>;
    };

    await phone.resume(undefined, phone.tablet);

    await vi.waitFor(() => expect(phone.createAppSession).toHaveBeenCalledTimes(2));
    // The replaced phone must not reconnect, and its size leases go at once.
    expect(await first.closed).toBe(4409);
    expect(phoneSession.dispose).toHaveBeenCalledWith({ connectionDropped: false });
    expect(phone.service.getState().connectedDevice).toMatchObject({ label: 'Tablet' });
    await phone.service.stop();
  });

  it('agrees on binary frames with a phone that asks, and names the app build it serves', async () => {
    await writeFile(join(webAssetDir, 'build.json'), JSON.stringify({ build: 'build-42' }));
    const phone = await startResumablePhone(webAssetDir);
    const attempt = await phone.hello(undefined, undefined, ['binary-frames', 'from-the-future']);
    const proof = await signDeviceProof(
      phone.deviceKeys.privateKey,
      buildDeviceProof('resume', String(attempt.reply.challenge), attempt.peer.getChannelBinding())
    );
    await attempt.peer.sendEncryptedJson({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(proof),
    });

    const authenticated = await attempt.nextFrame();
    expect(authenticated).toMatchObject({ capabilities: ['binary-frames'], build: 'build-42' });
    expect(attempt.binaryFrames).toEqual([]);
    await phone.service.stop();
  });

  it("agrees on projects' icons and workspaces' tags and tells the app session", async () => {
    const phone = await startResumablePhone(webAssetDir);
    const attempt = await phone.hello(undefined, undefined, ['project-icons', 'workspace-tags']);
    const proof = await signDeviceProof(
      phone.deviceKeys.privateKey,
      buildDeviceProof('resume', String(attempt.reply.challenge), attempt.peer.getChannelBinding())
    );
    await attempt.peer.sendEncryptedJson({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(proof),
    });

    expect(await attempt.nextFrame()).toMatchObject({
      capabilities: ['project-icons', 'workspace-tags'],
    });
    await vi.waitFor(() =>
      expect(phone.createAppSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ capabilities: ['project-icons', 'workspace-tags'] })
      )
    );
    await phone.service.stop();
  });

  it('names no capabilities to a phone that asks for none', async () => {
    const phone = await startResumablePhone(webAssetDir);
    const attempt = await phone.hello(undefined);
    const proof = await signDeviceProof(
      phone.deviceKeys.privateKey,
      buildDeviceProof('resume', String(attempt.reply.challenge), attempt.peer.getChannelBinding())
    );
    await attempt.peer.sendEncryptedJson({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(proof),
    });

    const authenticated = await attempt.nextFrame();
    expect(authenticated.type).toBe('pair:authenticated');
    expect(authenticated).not.toHaveProperty('capabilities');
    expect(authenticated).not.toHaveProperty('build');
    await phone.service.stop();
  });

  it('revokes outstanding resume grants when the server stops', async () => {
    const phone = await startResumablePhone(webAssetDir);
    const { resumeToken } = await phone.resume();

    await phone.service.stop();

    expect(phone.resumption.consume(phone.deviceId, resumeToken)).toBeNull();
  });

  it('does not admit a device that was removed while its reconnect was finishing', async () => {
    const phone = await startResumablePhone(webAssetDir);
    phone.registry.recordAuthSuccess.mockImplementationOnce((id: string) => {
      const record = phone.records.find((candidate) => candidate.credentialId === id)!;
      // The user removes the device after its proofs verified but before the
      // desktop promotes the connection.
      phone.service.disconnectCredential(id);
      phone.records.length = 0;
      return record;
    });

    await phone.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(phone.service.getState().connectedDevice).toBeUndefined();
    expect(phone.createAppSession).not.toHaveBeenCalled();
    await phone.service.stop();
  });

  it('pings a silent phone again before giving up on it', async () => {
    const { service: localService } = makeService(webAssetDir, {
      peerHandshakeTimeoutMs: 5_000,
      heartbeatPingMs: 20,
      // Room for three pings even when a loaded host runs the timers late.
      heartbeatTimeoutMs: 200,
    });
    const info = await localService.start();
    const response = await upgrade(info.wsUrl.replace(/^ws:/, 'http:'), info.httpOrigin);
    let received = '';
    response.socket?.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
    await new Promise((resolve) => response.socket?.on('close', resolve));

    // One late pong on a phone's radio isn't a dead link (Orca Mobile #12790).
    expect(received.split('relay:ping').length - 1).toBeGreaterThanOrEqual(3);
    await localService.stop();
  });

  it('evicts an unresponsive direct websocket so a reload can reconnect', async () => {
    const { service: localService } = makeService(webAssetDir, {
      peerHandshakeTimeoutMs: 1_000,
      heartbeatPingMs: 10,
      heartbeatTimeoutMs: 30,
    });
    const info = await localService.start();

    const first = await upgrade(info.wsUrl.replace(/^ws:/, 'http:'), info.httpOrigin);
    expect(first.statusCode).toBe(101);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await upgrade(info.wsUrl.replace(/^ws:/, 'http:'), info.httpOrigin);
    expect(second.statusCode).toBe(101);

    first.socket?.destroy();
    second.socket?.destroy();
    await localService.stop();
  });
});
