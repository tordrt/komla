// ECDH-P256 ephemeral key agreement + HKDF-SHA256 derivation of an AES-256
// session key.
//
// Each handshake generates a fresh ephemeral keypair on each side; the keys
// are not extractable (private) so they never leave this module. The shared
// secret is fed into HKDF with a fixed `info` label and a salt that combines
// both peers' public keys, so a relay-reflection attack (relay swaps both
// halves of the offer/answer to make the two sides derive different keys
// from the same secret) yields different keys on each side.

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' } as const;
const HKDF_INFO = new TextEncoder().encode('komla-remote-protocol/v1/session-key');

export interface EphemeralKeyPair {
  /** SPKI-DER bytes — safe to send over the wire. */
  publicKey: Uint8Array;
  /** Non-extractable CryptoKey — stays in this process. */
  privateKey: CryptoKey;
}

/**
 * Generate an ephemeral ECDH-P256 keypair for one handshake. The returned
 * private key is non-extractable; the public key is exported as SPKI-DER for
 * sending on the wire (P-256 SPKI is a fixed 91 bytes).
 */
export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveBits']);
  const publicKey = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('spki', pair.publicKey)
  );
  return { publicKey, privateKey: pair.privateKey };
}

/**
 * Import a peer's ephemeral SPKI public key for ECDH. `usages` is empty
 * because importKey on an ECDH public is only used as the `public` arg to
 * deriveBits, which doesn't need a key usage.
 */
export async function importPeerPublicKey(spkiDer: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'spki',
    spkiDer as BufferSource,
    ECDH_PARAMS,
    false,
    []
  );
}

/**
 * Derive a 256-bit AES-GCM session key from this side's private key + the
 * peer's public key + a salt that includes both ephemeral pubkeys. Including
 * both pubkeys in the HKDF salt provides key separation: even if a relay
 * could re-use a captured ECDH secret across sessions, the salt would differ
 * and the derived key would not match.
 *
 * Salt convention: `clientEphemSPKI ‖ desktopEphemSPKI` — the same byte order
 * the desktop signs in `e2e:answer`. Both sides MUST produce identical bytes
 * here; otherwise their derived keys differ and the first encrypted frame
 * fails to decrypt.
 */
export async function deriveSessionKey(args: {
  myPrivateKey: CryptoKey;
  peerPublicKey: CryptoKey;
  clientEphemPubKey: Uint8Array;
  desktopEphemPubKey: Uint8Array;
  /** SHA-256 of the authenticated, domain-separated handshake transcript. */
  transcriptHash?: Uint8Array;
}): Promise<CryptoKey> {
  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: 'ECDH', public: args.peerPublicKey },
    args.myPrivateKey,
    256
  );
  const hkdfKey = await globalThis.crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveKey',
  ]);
  const salt = args.transcriptHash ?? concat(args.clientEphemPubKey, args.desktopEphemPubKey);
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: HKDF_INFO as BufferSource,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
