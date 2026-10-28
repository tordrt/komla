// Single source of truth for the install fingerprint convention.
//
// The desktop's per-install identity is an ECDSA-P256 keypair; the fingerprint
// is `SHA-256(SPKI-DER(publicKey))` rendered as lowercase hex. This file is
// imported by:
//
//   - the desktop's install-identity service (Electron main, Node 20+)
//   - the browser client (and a future RN client)
//
// These runtimes have `globalThis.crypto.subtle` natively (or via a
// polyfill on RN); none of them need Node `crypto`.

/** Length in hex chars of a canonical install fingerprint (SHA-256 → 32 bytes → 64 hex chars). */
export const FINGERPRINT_HEX_LENGTH = 64;

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** True iff `s` is the canonical lowercase-hex SHA-256 fingerprint shape. */
export function isValidFingerprint(s: string): boolean {
  return FINGERPRINT_PATTERN.test(s);
}

/** SHA-256 over the SPKI-DER public key, lowercase hex. */
export async function fingerprintFromPublicKey(spkiDer: ArrayBuffer | Uint8Array): Promise<string> {
  // BufferSource cast: TS 5.x narrows `BufferSource` to `Uint8Array<ArrayBuffer>`
  // and refuses `Uint8Array<ArrayBufferLike>`. Runtime is fine in every
  // WebCrypto-bearing runtime; this is purely the compiler's SharedArrayBuffer
  // guard. Same cast pattern repeats anywhere we cross the WebCrypto boundary.
  const hash = await globalThis.crypto.subtle.digest('SHA-256', spkiDer as BufferSource);
  return bytesToHex(new Uint8Array(hash));
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}
