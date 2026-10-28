// Minimal WebAuthn authenticator simulator for tests.
//
// Produces `RegistrationResponseJSON` shapes that
// `@simplewebauthn/server.verifyRegistrationResponse` accepts. Single-purpose:
// drives our pair-ceremony tests without spinning up a real browser. Uses
// `attestationFormat: 'none'` (no x5c, no signature over attestation), so the
// authenticator only needs to:
//
//   1. Generate a P-256 keypair (ES256, COSE alg = -7).
//   2. Produce `clientDataJSON` matching the desktop's expected challenge/origin/type.
//   3. Build `authenticatorData` with the rpIdHash, flags, signCount, and
//      attestedCredentialData (containing the COSE-encoded public key).
//   4. CBOR-encode `{fmt: 'none', attStmt: {}, authData}` as the attestationObject.
//
// We reuse SimpleWebAuthn's own `isoCBOR` helper to make sure our CBOR
// encoding stays bit-identical to what the verifier decodes — tiny-cbor
// is very particular about Map-vs-Object and small-integer encoding.

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  type KeyObject,
} from 'crypto';

import { isoCBOR } from '@simplewebauthn/server/helpers';

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export interface FakeAuthenticatorOptions {
  /** RP-ID the desktop pinned. Hashed into authenticatorData. */
  rpId: string;
  /** Origin embedded in clientDataJSON. */
  origin: string;
  /** base64url challenge produced by the desktop. */
  challenge: string;
  /** Optional signCount. Defaults to 0 for fresh credentials. */
  signCount?: number;
  /** Optional AAGUID (16 bytes). Defaults to all zeros (no claim). */
  aaguid?: Uint8Array;
  /** Optional credential id (random 32 bytes if omitted). */
  credentialId?: Uint8Array;
  /** Whether the authenticator verified the user. Defaults to true. */
  userVerified?: boolean;
}

export interface FakeAuthenticatorResult {
  response: RegistrationResponseJSON;
  /** Plain credentialId bytes (caller may want to assert against the registry record). */
  credentialIdBytes: Uint8Array;
  /** P-256 private key — kept around so future tests can produce assertions. */
  privateKey: KeyObject;
}

/**
 * Build a `RegistrationResponseJSON` for the given expected challenge/origin/RP-ID.
 * Each call produces a fresh keypair and credential id.
 */
export function fakeRegister(opts: FakeAuthenticatorOptions): FakeAuthenticatorResult {
  const credentialIdBytes = opts.credentialId ?? randomBytes(32);
  const aaguid = opts.aaguid ?? new Uint8Array(16);
  const signCount = opts.signCount ?? 0;

  // 1. Keypair + COSE-encoded public key.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cosePublicKey = encodeCoseEcPublicKey(extractRawXY(publicKey));

  // 2. clientDataJSON. WebAuthn requires the exact field order produced by
  //    Chrome's serializer; in practice any valid JSON is accepted because
  //    SimpleWebAuthn re-parses it. We match the canonical Chrome output.
  const clientData = JSON.stringify({
    type: 'webauthn.create',
    challenge: opts.challenge,
    origin: opts.origin,
    crossOrigin: false,
  });
  const clientDataBytes = new TextEncoder().encode(clientData);

  // 3. authenticatorData. Layout (fixed-size prefix + variable attested cred data):
  //
  //    [0..32)   rpIdHash         SHA-256(rpId)
  //    [32]     flags             0x41 = AT(0x40) | UP(0x01)
  //    [33..37) signCount         BE uint32
  //    [37..53) aaguid            16 bytes
  //    [53..55) credentialIdLen   BE uint16
  //    [55..)   credentialId
  //              ...
  //              credentialPublicKey (CBOR)
  const rpIdHash = createHash('sha256').update(opts.rpId).digest();
  const flags = 0x40 | 0x01 | (opts.userVerified === false ? 0 : 0x04); // AT | UP | UV
  const fixed = new Uint8Array(37);
  fixed.set(rpIdHash, 0);
  fixed[32] = flags;
  fixed[33] = (signCount >>> 24) & 0xff;
  fixed[34] = (signCount >>> 16) & 0xff;
  fixed[35] = (signCount >>> 8) & 0xff;
  fixed[36] = signCount & 0xff;

  const credIdLen = new Uint8Array(2);
  credIdLen[0] = (credentialIdBytes.length >>> 8) & 0xff;
  credIdLen[1] = credentialIdBytes.length & 0xff;

  const authData = concatBytes(fixed, aaguid, credIdLen, credentialIdBytes, cosePublicKey);

  // 4. attestationObject — `fmt: 'none'` means an empty attStmt and no signature.
  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ])
  );

  return {
    response: {
      id: base64url(credentialIdBytes),
      rawId: base64url(credentialIdBytes),
      type: 'public-key',
      response: {
        clientDataJSON: base64url(clientDataBytes),
        attestationObject: base64url(attestationObject),
        transports: ['internal'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    },
    credentialIdBytes,
    privateKey,
  };
}

// COSE_Key for EC2 / P-256 / ES256:
//   1 (kty)  = 2  (EC2)
//   3 (alg)  = -7 (ES256)
//  -1 (crv)  = 1  (P-256)
//  -2 (x)    = 32 bytes
//  -3 (y)    = 32 bytes
function encodeCoseEcPublicKey(xy: { x: Uint8Array; y: Uint8Array }): Uint8Array {
  return isoCBOR.encode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, xy.x],
      [-3, xy.y],
    ])
  );
}

// SPKI-DER for P-256 ends with a 0x04 || X || Y uncompressed point in the
// last 65 bytes — that's the simplest stable extraction across Node versions.
function extractRawXY(publicKey: KeyObject): { x: Uint8Array; y: Uint8Array } {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  if (spki.length < 65) {
    throw new Error(`SPKI too short: ${spki.length}`);
  }
  const tail = spki.subarray(spki.length - 65);
  if (tail[0] !== 0x04) {
    throw new Error(`expected uncompressed EC point (0x04), got 0x${tail[0]?.toString(16)}`);
  }
  return {
    x: new Uint8Array(tail.subarray(1, 33)),
    y: new Uint8Array(tail.subarray(33, 65)),
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ────────────────────────────────────────────────────────────────────────
// Authentication assertions (for the auth ceremony — returning paired client)
// ────────────────────────────────────────────────────────────────────────

export interface FakeAuthenticationOptions {
  /** RP-ID the desktop pinned. Hashed into authenticatorData. */
  rpId: string;
  /** Origin embedded in clientDataJSON. */
  origin: string;
  /** base64url challenge produced by the desktop. */
  challenge: string;
  /** Counter to embed in authenticatorData (must advance past the stored one). */
  signCount: number;
  /** Credential id from the prior `fakeRegister` call. */
  credentialId: Uint8Array;
  /** Private key from the prior `fakeRegister` call. */
  privateKey: KeyObject;
  /** base64url userHandle to attach to the assertion (the install fingerprint). */
  userHandle?: string;
  /** Whether the authenticator verified the user. Defaults to true. */
  userVerified?: boolean;
}

/**
 * Build an `AuthenticationResponseJSON` that
 * `verifyAuthenticationResponse({ ..., credential: <stored> })` will accept,
 * given a prior `fakeRegister` result.
 *
 * Layout of the signed material follows W3C WebAuthn §6.3.3:
 *   sig = ECDSA(privateKey, authenticatorData ‖ SHA-256(clientDataJSON))
 */
export function fakeAuthenticate(opts: FakeAuthenticationOptions): {
  response: AuthenticationResponseJSON;
} {
  // 1. clientDataJSON for `webauthn.get`.
  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge: opts.challenge,
    origin: opts.origin,
    crossOrigin: false,
  });
  const clientDataBytes = new TextEncoder().encode(clientData);

  // 2. authenticatorData with NO attestedCredentialData (UP + UV, no AT bit).
  const rpIdHash = createHash('sha256').update(opts.rpId).digest();
  const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04); // UP | UV
  const fixed = new Uint8Array(37);
  fixed.set(rpIdHash, 0);
  fixed[32] = flags;
  fixed[33] = (opts.signCount >>> 24) & 0xff;
  fixed[34] = (opts.signCount >>> 16) & 0xff;
  fixed[35] = (opts.signCount >>> 8) & 0xff;
  fixed[36] = opts.signCount & 0xff;
  const authData = fixed;

  // 3. signature over `authenticatorData ‖ SHA-256(clientDataJSON)`. The
  //    browser surface produces a DER-encoded ECDSA signature here (not
  //    P1363) — that's what `verifyAuthenticationResponse` expects.
  const clientDataHash = createHash('sha256').update(clientDataBytes).digest();
  const signed = concatBytes(authData, new Uint8Array(clientDataHash));
  const signature = nodeSign('sha256', Buffer.from(signed), {
    key: opts.privateKey,
    dsaEncoding: 'der',
  });

  return {
    response: {
      id: base64url(opts.credentialId),
      rawId: base64url(opts.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: base64url(clientDataBytes),
        authenticatorData: base64url(authData),
        signature: base64url(new Uint8Array(signature)),
        userHandle: opts.userHandle,
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    },
  };
}
