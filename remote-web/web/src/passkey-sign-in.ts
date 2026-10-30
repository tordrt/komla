// Signing in with a passkey: when the page may ask for it on its own, and what to tell the person
// when it fails. Kept apart from main.ts so it can be tested without a browser.

export interface PromptEnvironment {
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
  /** `navigator.userActivation.isActive`; undefined where the browser doesn't say. */
  userActivationActive: boolean | undefined;
}

/**
 * Safari shows no passkey sheet for a request that doesn't closely follow a tap, and a hidden or
 * unfocused page can't show one at all. So the page asks on its own only right after a tap, and
 * otherwise waits for the Unlock button.
 */
export function mayPromptWithoutTap(env: PromptEnvironment): boolean {
  return env.visibilityState === 'visible' && env.hasFocus && env.userActivationActive === true;
}

/** What went wrong with `navigator.credentials.get()`, for the person rather than a developer. */
export function passkeyErrorMessage(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : null;
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return 'The passkey request was cancelled or timed out.';
    case 'SecurityError':
      return "This address isn't the one this device paired on. Open Komla from the link you paired with.";
    case 'InvalidStateError':
    case 'NotSupportedError':
      return "This device couldn't use the passkey it paired with.";
    default:
      return err instanceof Error && err.message ? err.message : 'The passkey request failed.';
  }
}

export interface SignInFailure {
  message: string;
  /** Signing in again may work; false when the device must pair again first. */
  retry: boolean;
}

/**
 * A `pair:rejected` during sign-in, for the person. `hostName` when an SSH host sent it, which may
 * run an older companion than the desktop that served this page.
 */
export function signInRejection(
  reason: string,
  message: string,
  hostName?: string
): SignInFailure {
  if (hostName && (reason === 'signature-failed' || message === 'malformed pair:hello')) {
    return {
      message: `Komla couldn't verify this sign-in. If ${hostName} hasn't been updated yet, open Komla on your computer to update it.`,
      retry: true,
    };
  }
  switch (reason) {
    case 'unknown-device':
    case 'not-paired':
      return { message: capitalize(message), retry: false };
    case 'internal':
      return message === 'ceremony timeout'
        ? { message: 'Komla stopped waiting for your passkey.', retry: true }
        : { message: capitalize(message), retry: true };
    case 'signature-failed':
    case 'device-signature-failed':
      return { message: "Komla couldn't verify this sign-in.", retry: true };
    case 'unknown-credential':
      return { message: "Komla doesn't trust that passkey.", retry: true };
    case 'counter-regression':
      return {
        message:
          'Komla saw this passkey used out of order. If this keeps happening, pair this device again.',
        retry: true,
      };
    default:
      return { message: capitalize(message), retry: true };
  }
}

function capitalize(text: string): string {
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
