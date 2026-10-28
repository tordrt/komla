// Pure WebAuthn authentication verification.
//
// Wraps `@simplewebauthn/server.verifyAuthenticationResponse` with our own
// input/output types so callers don't have to import library internals.
// No I/O, no Electron — safe to import from a unit test or a non-Electron
// Node context.
//
// Counter regression: WebAuthn says authenticators that report a non-zero
// counter must monotonically increase it. Some authenticators always report
// 0 (counter not in use). We accept the "both stored and new are 0" case and
// treat any other non-monotonic transition as a hard failure — that's the
// signal that the credential has been cloned.
//
// We pass `counter: 0` to the underlying verifier so its built-in regression
// check is suppressed. The library would otherwise throw on regression and
// that throw lands in our generic catch as `signature-failed`, hiding the
// distinct `counter-regression` reason the protocol advertises. Owning the
// check here keeps the wire-format contract honest, and is a strict superset
// of the library's check (we also catch the firmware-reset case where the
// authenticator regresses from non-zero back to zero).

import { verifyAuthenticationResponse } from '@simplewebauthn/server';

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export interface VerifyAuthenticationOptions {
  /** Pass-through of the JSON the browser produced from `navigator.credentials.get()`. */
  authenticationResponse: unknown;
  /** Base64url challenge that the desktop sent in `pair:auth-challenge`. */
  expectedChallenge: string;
  /** Exact origin the desktop expects in `clientDataJSON.origin`. */
  expectedOrigin: string;
  /** RP-ID the desktop pinned for the ceremony. */
  expectedRPID: string;
  /** The registry record matching the credential id the browser asserted with. */
  storedCredential: {
    /** base64url credential id. */
    credentialId: string;
    /** base64url COSE-encoded public key (as persisted by the registration flow). */
    publicKey: string;
    /** Counter value last seen in a successful assertion. */
    signCounter: number;
    /** Transports the authenticator reported at registration, if any. */
    transports: string[] | null;
  };
}

export type VerifyAuthenticationResult =
  | { ok: true; credentialId: string; newCounter: number }
  | {
      ok: false;
      reason: 'signature-failed' | 'counter-regression';
      message: string;
    };

/**
 * Verify a WebAuthn authentication assertion against a stored credential and
 * return the new counter value the caller should persist. Failure paths:
 *
 *   - signature-failed   challenge / origin / RP-ID / signature mismatch, or
 *                        any malformed input — the deep checks live in
 *                        `verifyAuthenticationResponse` and the caller maps
 *                        this single token onto a `pair:rejected` frame.
 *   - counter-regression authenticator reported a counter that did not
 *                        strictly advance past the stored value (and at
 *                        least one of the two was non-zero). RFC 5.4.5 says
 *                        this is the cloned-authenticator signal.
 */
export async function verifyAuthentication(
  opts: VerifyAuthenticationOptions
): Promise<VerifyAuthenticationResult> {
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: opts.authenticationResponse as AuthenticationResponseJSON,
      expectedChallenge: opts.expectedChallenge,
      expectedOrigin: opts.expectedOrigin,
      expectedRPID: opts.expectedRPID,
      credential: {
        id: opts.storedCredential.credentialId,
        publicKey: decodeBase64Url(opts.storedCredential.publicKey),
        // Suppress the library's regression check; we run our own below
        // against the real stored counter so we control the failure dispatch.
        counter: 0,
        // SimpleWebAuthn typings narrow this to a literal-string union; we
        // store transports as plain strings, so cast through `unknown`. The
        // verifier only uses `transports` for diagnostic logging anyway.
        transports: opts.storedCredential.transports as unknown as undefined,
      },
      // Remote authentication grants terminal input and workspace control, so
      // possession/user-presence alone is insufficient. Require the
      // authenticator to verify the user with its configured PIN or biometric.
      requireUserVerification: true,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'signature-failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.verified) {
    return {
      ok: false,
      reason: 'signature-failed',
      message: 'authentication did not verify',
    };
  }

  const { newCounter } = result.authenticationInfo;
  const stored = opts.storedCredential.signCounter;
  if ((stored !== 0 || newCounter !== 0) && newCounter <= stored) {
    return {
      ok: false,
      reason: 'counter-regression',
      message: `sign counter ${newCounter} did not advance past ${stored}`,
    };
  }

  return { ok: true, credentialId: opts.storedCredential.credentialId, newCounter };
}

function decodeBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return new Uint8Array(Buffer.from(std, 'base64'));
}
