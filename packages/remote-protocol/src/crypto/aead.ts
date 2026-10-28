// AES-GCM-256 authenticated encryption.
//
// Nonce convention: 12 bytes laid out as `[ direction(1) | seq(4 BE) | random(7) ]`.
//
//   - `direction` distinguishes the two send paths (`0x01` for desktop→client,
//     `0x02` for client→desktop) so the same key can be used for both
//     directions without nonce-reuse risk if both sides happen to land on the
//     same seq value.
//   - `seq` is the strict-monotonic 32-bit per-direction counter (also carried
//     in the wire envelope so the receiver can reject out-of-order frames
//     before attempting decryption).
//   - `random(7)` provides 56 bits of additional entropy. Even with seq + dir
//     fixed, this makes nonce collision under the same key vanishingly unlikely.
//     Belt-and-suspenders: a buggy seq increment can't cause nonce reuse in
//     isolation.
//
// AES-GCM with the same (key, nonce) pair on different plaintexts is a
// catastrophic failure (key recovery), so this layout deliberately makes
// reuse impossible barring a 1-in-2^56 random collision per direction per
// session.

export const NONCE_BYTES = 12;
export const DIRECTION_DESKTOP_TO_CLIENT = 0x01;
export const DIRECTION_CLIENT_TO_DESKTOP = 0x02;

export type Direction = typeof DIRECTION_DESKTOP_TO_CLIENT | typeof DIRECTION_CLIENT_TO_DESKTOP;

export interface EncryptResult {
  /** 12-byte nonce that the receiver will need to decrypt. */
  nonce: Uint8Array;
  /** AES-GCM ciphertext including the 16-byte auth tag. */
  ciphertext: Uint8Array;
}

/** Build a 12-byte nonce: `[ direction | seq BE | random(7) ]`. */
export function buildNonce(direction: Direction, seq: number): Uint8Array {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new RangeError(`seq must be a 32-bit unsigned integer, got ${seq}`);
  }
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce[0] = direction;
  nonce[1] = (seq >>> 24) & 0xff;
  nonce[2] = (seq >>> 16) & 0xff;
  nonce[3] = (seq >>> 8) & 0xff;
  nonce[4] = seq & 0xff;
  globalThis.crypto.getRandomValues(nonce.subarray(5));
  return nonce;
}

export async function encrypt(
  key: CryptoKey,
  direction: Direction,
  seq: number,
  plaintext: Uint8Array
): Promise<EncryptResult> {
  const nonce = buildNonce(direction, seq);
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      key,
      plaintext as BufferSource
    )
  );
  return { nonce, ciphertext };
}

/**
 * Decrypt + authenticate. Throws on tag-mismatch or any AES-GCM error — the
 * caller (Peer) translates that into a session-fatal close, not a recoverable
 * parse error, because a tag-mismatch in an established session means the
 * network tampered with a frame.
 */
export async function decrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  if (nonce.length !== NONCE_BYTES) {
    throw new RangeError(`nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new Uint8Array(plaintext);
}
