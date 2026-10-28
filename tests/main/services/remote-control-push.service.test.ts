import { createECDH } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

import { RemoteControlPushService } from '../../../src/main/services/remote-control-push.service';

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/services/paired-device-registry.service', () => ({
  pairedDeviceRegistryService: { list: vi.fn(() => []), onChange: vi.fn(() => () => {}) },
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: vi.fn(() => ({ directRemoteEnabled: true })) },
}));

import type { WebPushRequest } from '../../../src/main/lib/web-push';
import type { WorkspaceAttentionEvent } from '../../../src/shared/types/workspace';

function browserSubscription(endpoint = 'https://web.push.apple.com/abc') {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 3).toString('base64url'),
    },
  };
}

function attention(
  kind: WorkspaceAttentionEvent['attention']['kind'],
  extra: Partial<WorkspaceAttentionEvent['attention']> = {}
): WorkspaceAttentionEvent {
  const raised = { kind, source: 'claude-code', updatedAt: 1, terminalId: 't-1', ...extra };
  return { workspaceId: 'ws-1', attention: raised, workspaceAttention: raised };
}

describe('RemoteControlPushService', () => {
  let dir: string;
  let devices: Array<{ credentialId: string }>;
  let deviceListeners: Array<() => void>;
  let away: boolean;
  let now: number;
  let sent: WebPushRequest[];
  let status: number;
  let secureStorageAvailable: boolean;
  let keychainLocked: boolean;

  function makeService() {
    return new RemoteControlPushService({
      keyPath: join(dir, 'remote-push-key.json'),
      subscriptionsPath: join(dir, 'remote-push-subscriptions.json'),
      secureStorage: {
        available: () => secureStorageAvailable,
        encrypt: (text) => Buffer.from(`enc:${text}`),
        decrypt: (data) => {
          if (keychainLocked) throw new Error('user denied keychain access');
          return data.toString().replace(/^enc:/, '');
        },
      },
      devices: {
        list: () => devices,
        onChange: (listener) => {
          deviceListeners.push(() => listener(devices));
          return () => {};
        },
      },
      isUserAway: () => away,
      isEnabled: () => true,
      send: async (request) => {
        sent.push(request);
        return {
          outcome: status === 201 ? 'delivered' : status === 410 ? 'gone' : 'failed',
          status,
        };
      },
      now: () => now,
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'komla-remote-push-'));
    devices = [{ credentialId: 'phone' }, { credentialId: 'tablet' }];
    deviceListeners = [];
    away = true;
    now = 100_000;
    sent = [];
    status = 201;
    secureStorageAvailable = true;
    keychainLocked = false;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates one VAPID key, keeps it encrypted at rest and reuses it after a restart', async () => {
    const first = makeService().config('phone');

    const stored = JSON.parse(await readFile(join(dir, 'remote-push-key.json'), 'utf8'));
    expect(first).toMatchObject({ available: true, subscribed: false, notifyWhen: 'away' });
    expect(first.vapidPublicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(Buffer.from(stored.encryptedKeys, 'base64').toString()).toMatch(/^enc:/);
    expect(makeService().config('phone').vapidPublicKey).toBe(first.vapidPublicKey);
  });

  it('offers no notifications when the key cannot be kept encrypted', () => {
    secureStorageAvailable = false;
    const service = makeService();

    expect(service.config('phone')).toEqual({
      available: false,
      subscribed: false,
      notifyWhen: 'away',
    });
    expect(() => service.subscribe('phone', browserSubscription(), 'away')).toThrow(/keychain/);
  });

  it('only accepts a subscription from a trusted device with browser-shaped keys', () => {
    const service = makeService();

    expect(() => service.subscribe('stranger', browserSubscription(), 'away')).toThrow(/trusted/);
    expect(() =>
      service.subscribe('phone', browserSubscription('http://push.example/x'), 'away')
    ).toThrow(/https/);
    service.subscribe('phone', browserSubscription(), 'always');
    expect(service.config('phone')).toMatchObject({ subscribed: true, notifyWhen: 'always' });
    service.unsubscribe('phone');
    expect(service.config('phone').subscribed).toBe(false);
  });

  it('notifies away-only devices when the user is away and always-devices regardless', async () => {
    const service = makeService();
    service.subscribe('phone', browserSubscription('https://web.push.apple.com/phone'), 'away');
    service.subscribe('tablet', browserSubscription('https://fcm.googleapis.com/tablet'), 'always');
    away = false;

    await service.attentionRaised(
      attention('input-required', { message: 'Allow npm test?' }),
      'SSH fix'
    );

    expect(sent.map((request) => request.url)).toEqual(['https://fcm.googleapis.com/tablet']);
    expect(sent[0]?.headers).toMatchObject({ Urgency: 'high', TTL: String(6 * 60 * 60) });
    expect(sent[0]?.headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it('still notifies when the workspace title is too long to fit a push', async () => {
    const service = makeService();
    service.subscribe('phone', browserSubscription(), 'always');

    // An agent-set title can be any length; the push payload holds about 4 KB.
    await service.attentionRaised(attention('turn-complete'), 'Fix the login flow '.repeat(300));

    expect(sent).toHaveLength(1);
  });

  it('skips attention kinds that would repeat or are not worth a buzz', async () => {
    const service = makeService();
    service.subscribe('phone', browserSubscription(), 'always');

    await service.attentionRaised(attention('idle'));
    await service.attentionRaised(attention('generic'));

    expect(sent).toHaveLength(0);
  });

  it('does not push what a visible phone is already looking at', async () => {
    const service = makeService();
    service.subscribe('phone', browserSubscription(), 'always');
    let visible = true;
    const unregister = service.registerViewer('phone', () => ({
      visible,
      attachedTerminals: new Map([['t-1', 'ws-1']]),
    }));

    await service.attentionRaised(attention('turn-complete'));
    await service.attentionRaised(attention('error', { terminalId: undefined }));
    expect(sent).toHaveLength(0);

    visible = false;
    await service.attentionRaised(attention('turn-complete'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.Urgency).toBe('normal');

    unregister();
    now += 10_000;
    visible = true;
    await service.attentionRaised(attention('turn-complete'));
    expect(sent).toHaveLength(2);
  });

  it('limits one workspace to one push per kind every few seconds', async () => {
    const service = makeService();
    service.subscribe('phone', browserSubscription(), 'always');

    await service.attentionRaised(attention('turn-complete'));
    now += 2_000;
    await service.attentionRaised(attention('turn-complete'));
    await service.attentionRaised(attention('input-required'));
    now += 5_000;
    await service.attentionRaised(attention('turn-complete'));

    expect(sent).toHaveLength(3);
  });

  it('drops a subscription the push service reports gone', async () => {
    const service = makeService();
    service.subscribe('phone', browserSubscription(), 'always');
    status = 410;

    expect(await service.sendTest('phone')).toBe('gone');
    expect(service.config('phone').subscribed).toBe(false);
    expect(await service.sendTest('phone')).toBe('not-subscribed');
  });

  it('forgets the subscription of a device that is removed', () => {
    const service = makeService();
    service.start();
    service.subscribe('phone', browserSubscription(), 'always');
    service.subscribe('tablet', browserSubscription(), 'always');

    devices = [{ credentialId: 'tablet' }];
    for (const notify of deviceListeners) notify();

    expect(makeService().config('phone').subscribed).toBe(false);
    expect(makeService().config('tablet').subscribed).toBe(true);
  });

  it('ignores stored subscriptions for devices that are no longer trusted', async () => {
    makeService().subscribe('phone', browserSubscription(), 'always');
    devices = [];

    await makeService().attentionRaised(attention('turn-complete'));

    expect(sent).toHaveLength(0);
  });

  it('starts over with no subscriptions when the stored key is unreadable', async () => {
    const service = makeService();
    service.subscribe('phone', browserSubscription(), 'always');
    await writeFile(join(dir, 'remote-push-key.json'), '{"version":1,"encryptedKeys":"!!"}');

    const restarted = makeService();

    expect(restarted.config('phone')).toMatchObject({ available: true, subscribed: false });
  });

  it('keeps the key and every subscription while the keychain refuses to decrypt it', async () => {
    makeService().subscribe('phone', browserSubscription(), 'always');
    keychainLocked = true;
    const restarted = makeService();

    await restarted.attentionRaised(attention('turn-complete'));
    expect(restarted.config('phone')).toMatchObject({ available: false, subscribed: true });

    keychainLocked = false;
    await restarted.attentionRaised(attention('input-required'));
    expect(sent).toHaveLength(1);
  });
});
