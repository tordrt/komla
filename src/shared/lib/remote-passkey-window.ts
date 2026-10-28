/**
 * Settings → Remote → "Ask for passkey again after": how many minutes a device that left stays
 * signed in, so it comes back without its passkey. Never past eight hours since the last passkey.
 */
export const REMOTE_PASSKEY_WINDOW_MINUTES = [5, 15, 60, 480] as const;

export type RemotePasskeyWindowMinutes = (typeof REMOTE_PASSKEY_WINDOW_MINUTES)[number];

export const DEFAULT_REMOTE_PASSKEY_WINDOW_MINUTES: RemotePasskeyWindowMinutes = 15;

export function normalizeRemotePasskeyWindow(value: unknown): RemotePasskeyWindowMinutes {
  return (
    REMOTE_PASSKEY_WINDOW_MINUTES.find((minutes) => minutes === value) ??
    DEFAULT_REMOTE_PASSKEY_WINDOW_MINUTES
  );
}

export function remotePasskeyWindowMs(config: {
  directRemotePasskeyWindowMinutes?: number;
}): number {
  return normalizeRemotePasskeyWindow(config.directRemotePasskeyWindowMinutes) * 60_000;
}
