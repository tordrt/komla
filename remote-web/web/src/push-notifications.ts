import type { RemotePushSubscription } from '@komla/remote-protocol';

// Browser half of Web Push: whether this browser can receive pushes at all, and turning its
// PushManager subscription into the frame the desktop stores.

export type PushSupport = 'supported' | 'needs-home-screen' | 'unsupported' | 'insecure';

export interface PushEnvironment {
  isSecureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
}

export function currentPushEnvironment(): PushEnvironment {
  return {
    isSecureContext: window.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

/** iPhone or iPad. iPadOS reports a Mac user agent, so touch support tells. */
export function isAppleTouchDevice(env: Pick<PushEnvironment, 'userAgent' | 'maxTouchPoints'>) {
  return (
    /iPhone|iPad|iPod/.test(env.userAgent) ||
    (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)
  );
}

/**
 * iOS and iPadOS only offer Web Push to a web app opened from the Home Screen (16.4+); in a
 * Safari tab PushManager is missing.
 */
export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.isSecureContext) return 'insecure';
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'supported';
  return isAppleTouchDevice(env) && !env.standalone ? 'needs-home-screen' : 'unsupported';
}

export function sameApplicationServerKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, index) => byte === wanted[index]);
}

export function toPushFrameSubscription(json: PushSubscriptionJSON): RemotePushSubscription | null {
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  // Browsers emit unpadded base64url; strip padding if one doesn't.
  return {
    endpoint: json.endpoint,
    keys: { p256dh: p256dh.replace(/=+$/, ''), auth: auth.replace(/=+$/, '') },
  };
}

/**
 * Subscribes this browser to pushes signed by `vapidPublicKey`. A subscription made for another
 * key (the desktop replaced its key) is dropped first, since the push service would refuse it.
 */
export async function subscribeBrowser(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: Uint8Array
): Promise<RemotePushSubscription | null> {
  const existing = await registration.pushManager.getSubscription();
  if (
    existing &&
    !sameApplicationServerKey(existing.options.applicationServerKey, vapidPublicKey)
  ) {
    await existing.unsubscribe();
  }
  const subscription =
    existing && sameApplicationServerKey(existing.options.applicationServerKey, vapidPublicKey)
      ? existing
      : await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidPublicKey as BufferSource,
        });
  return toPushFrameSubscription(subscription.toJSON());
}

export async function unsubscribeBrowser(registration: ServiceWorkerRegistration): Promise<void> {
  await (await registration.pushManager.getSubscription())?.unsubscribe();
}
