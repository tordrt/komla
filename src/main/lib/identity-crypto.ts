import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'crypto';

// IEEE-P1363 (r||s, fixed 64 bytes for P-256). Chosen for WebCrypto / most
// relay-server interop. The Node crypto default is DER, which is lumpier and
// not what most non-Node verifiers expect.
export const IDENTITY_SIGNATURE_ENCODING = 'ieee-p1363' as const;

// OpenSSL's name for NIST P-256 (a.k.a. secp256r1, prime256v1). This is what
// Node reports via `asymmetricKeyDetails.namedCurve` for a P-256 key.
const P256_CURVE_NAME = 'prime256v1';

/**
 * True iff `key` is an EC key on the P-256 curve. Works for both private and
 * public KeyObjects — the asymmetric type and curve fields are present on both.
 *
 * Single source of truth for "is this our primitive?", used both by the load
 * path (to reject a wrong-curve PKCS8 on disk) and by {@link verifySignature}
 * (to reject a wrong-curve or wrong-algorithm public key from a caller).
 */
export function isP256Key(key: KeyObject): boolean {
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === P256_CURVE_NAME;
}

/**
 * Verify an ECDSA-P256 / SHA-256 signature against the supplied SPKI public key.
 *
 * Pure: no filesystem, no Electron, no module-level side effects. This file
 * deliberately imports nothing from `electron`, so it is safe to import from a
 * non-Electron Node context (e.g. a future relay verifier running in plain
 * Node). `signature` must be IEEE-P1363 (r||s, 64 bytes for P-256).
 *
 * Algorithm-pinned: a non-P256 public key (RSA, Ed25519, P-384, etc.) returns
 * `false` rather than transparently verifying with a different primitive. This
 * is defense in depth — well-behaved callers pin the expected key, but the
 * primitive should still refuse to silently change algorithm under them.
 *
 * Returns false rather than throwing on malformed inputs so callers can use it
 * as a yes/no admission gate without try/catch boilerplate.
 */
export function verifySignature(data: Buffer, signature: Buffer, publicKey: Buffer): boolean {
  try {
    const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    if (!isP256Key(key)) {
      return false;
    }
    return cryptoVerify(
      'sha256',
      data,
      { key, dsaEncoding: IDENTITY_SIGNATURE_ENCODING },
      signature
    );
  } catch {
    return false;
  }
}
