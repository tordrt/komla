import { describe, expect, it, vi } from 'vitest';

import {
  pushSupport,
  sameApplicationServerKey,
  subscribeBrowser,
  toPushFrameSubscription,
  type PushEnvironment,
} from '../push-notifications';

const capable: PushEnvironment = {
  isSecureContext: true,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile',
  maxTouchPoints: 5,
  standalone: false,
};
const iphoneSafariTab: PushEnvironment = {
  ...capable,
  hasPushManager: false,
  hasNotification: false,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
};

describe('pushSupport', () => {
  it('needs a secure origin first', () => {
    expect(pushSupport({ ...capable, isSecureContext: false })).toBe('insecure');
  });

  it('works anywhere the browser has a push manager', () => {
    expect(pushSupport(capable)).toBe('supported');
    expect(
      pushSupport({ ...capable, userAgent: iphoneSafariTab.userAgent, standalone: true })
    ).toBe('supported');
  });

  it('asks iPhone and iPad Safari tabs to add the app to the Home Screen', () => {
    expect(pushSupport(iphoneSafariTab)).toBe('needs-home-screen');
    expect(
      pushSupport({
        ...iphoneSafariTab,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
      })
    ).toBe('needs-home-screen');
  });

  it('reports other browsers without push as unsupported', () => {
    expect(pushSupport({ ...iphoneSafariTab, standalone: true })).toBe('unsupported');
    expect(
      pushSupport({
        ...capable,
        hasPushManager: false,
        userAgent: 'Mozilla/5.0 (X11; Linux) Firefox/140',
      })
    ).toBe('unsupported');
  });
});

describe('browser subscriptions', () => {
  const key = new Uint8Array([4, 1, 2, 3]);

  it('compares application server keys byte for byte', () => {
    expect(sameApplicationServerKey(new Uint8Array([4, 1, 2, 3]).buffer, key)).toBe(true);
    expect(sameApplicationServerKey(new Uint8Array([4, 1, 2, 9]).buffer, key)).toBe(false);
    expect(sameApplicationServerKey(null, key)).toBe(false);
  });

  it('turns a browser subscription into the frame shape and refuses an incomplete one', () => {
    expect(
      toPushFrameSubscription({
        endpoint: 'https://fcm.googleapis.com/fcm/send/x',
        keys: { p256dh: 'BKey==', auth: 'secret=' },
      })
    ).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: 'BKey', auth: 'secret' },
    });
    expect(toPushFrameSubscription({ endpoint: 'https://x', keys: { p256dh: 'B' } })).toBeNull();
  });

  function registration(existingKey: Uint8Array | null) {
    const existing = existingKey
      ? {
          options: { applicationServerKey: existingKey.buffer },
          unsubscribe: vi.fn(async () => true),
          toJSON: () => ({ endpoint: 'https://push/old', keys: { p256dh: 'BOld', auth: 'a' } }),
        }
      : null;
    const subscribe = vi.fn(async () => ({
      toJSON: () => ({ endpoint: 'https://push/new', keys: { p256dh: 'BNew', auth: 'b' } }),
    }));
    return {
      existing,
      subscribe,
      value: { pushManager: { getSubscription: async () => existing, subscribe } } as never,
    };
  }

  it('reuses a subscription made for the same desktop key', async () => {
    const reg = registration(key);

    expect(await subscribeBrowser(reg.value, key)).toMatchObject({ endpoint: 'https://push/old' });
    expect(reg.subscribe).not.toHaveBeenCalled();
  });

  it('replaces a subscription made for another key', async () => {
    const reg = registration(new Uint8Array([4, 9, 9, 9]));

    expect(await subscribeBrowser(reg.value, key)).toMatchObject({ endpoint: 'https://push/new' });
    expect(reg.existing?.unsubscribe).toHaveBeenCalled();
    expect(reg.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  });
});
