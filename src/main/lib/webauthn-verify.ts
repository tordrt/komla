// Pure WebAuthn registration verification.
//
// Wraps `@simplewebauthn/server.verifyRegistrationResponse` with our own
// input/output types so callers don't have to import library internals.
// No I/O, no Electron — safe to import from a unit test or a non-Electron
// Node context.

import { verifyRegistrationResponse } from '@simplewebauthn/server';

import type { RegistrationResponseJSON } from '@simplewebauthn/server';

export interface VerifyRegistrationOptions {
  /** Pass-through of the JSON the browser produced from `navigator.credentials.create()`. */
  attestationResponse: unknown;
  /** Base64url challenge that the desktop sent in `pair:registration-challenge`. */
  expectedChallenge: string;
  /** Exact origin the desktop expects in `clientDataJSON.origin`. */
  expectedOrigin: string;
  /** RP-ID the desktop pinned for the ceremony. */
  expectedRPID: string;
}

export interface VerifiedCredential {
  /** base64url credential id reported by the authenticator. */
  credentialId: string;
  /** base64url COSE-encoded public key bytes. */
  publicKey: string;
  /** Initial signature counter (typically 0 or 1 for fresh credentials). */
  signCounter: number;
  /** AAGUID in WebAuthn UUID form, or null if the authenticator omitted it. */
  aaguid: string | null;
  /** Transports list reported by the authenticator, or null. */
  transports: string[] | null;
}

export type VerifyRegistrationResult =
  | { ok: true; credential: VerifiedCredential }
  | { ok: false; reason: 'attestation-invalid'; message: string };

/**
 * Verify a WebAuthn registration response and return the credential record
 * we want to persist. On any verification failure (challenge mismatch,
 * origin mismatch, RP-ID mismatch, signature failure, malformed input)
 * returns `{ ok: false }` with a diagnostic message — the caller maps that
 * to a `pair:rejected` frame with a stable `reason` token.
 *
 * The `aaguid` returned by `@simplewebauthn/server` is a UUID string with
 * dashes (e.g. `00000000-0000-0000-0000-000000000000` for unknown/none).
 * We treat the all-zero AAGUID as "no claim" and store null.
 */
export async function verifyRegistration(
  opts: VerifyRegistrationOptions
): Promise<VerifyRegistrationResult> {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: opts.attestationResponse as RegistrationResponseJSON,
      expectedChallenge: opts.expectedChallenge,
      expectedOrigin: opts.expectedOrigin,
      expectedRPID: opts.expectedRPID,
      // Enrollment creates a credential that can later authorize local-user
      // shell execution. Require a PIN or biometric even though enrollment
      // itself never opens an app session.
      requireUserVerification: true,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'attestation-invalid',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.verified || !result.registrationInfo) {
    return {
      ok: false,
      reason: 'attestation-invalid',
      message: 'attestation did not verify',
    };
  }

  const { credential, aaguid } = result.registrationInfo;
  return {
    ok: true,
    credential: {
      credentialId: credential.id,
      publicKey: encodeBase64Url(credential.publicKey),
      signCounter: credential.counter,
      aaguid: aaguid && aaguid !== '00000000-0000-0000-0000-000000000000' ? aaguid : null,
      transports: credential.transports ? [...credential.transports] : null,
    },
  };
}

/**
 * RFC 4648 §5 base64url (no padding). Used for the public-key field stored
 * in the registry — keeps every credential field in a uniform encoding.
 */
function encodeBase64Url(bytes: Uint8Array): string {
  // Buffer.from(...).toString('base64') emits standard base64; convert to
  // base64url alphabet and strip trailing `=` padding. Node's `'base64url'`
  // encoding is also available but only on Node 16+; using the explicit
  // transform keeps the code obvious in review.
  const std = Buffer.from(bytes).toString('base64');
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
