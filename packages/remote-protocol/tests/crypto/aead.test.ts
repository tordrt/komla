import { describe, it, expect } from 'vitest';

import {
  buildNonce,
  decrypt,
  DIRECTION_CLIENT_TO_DESKTOP,
  DIRECTION_DESKTOP_TO_CLIENT,
  encrypt,
  NONCE_BYTES,
} from '../../src/crypto/aead';
import {
  deriveSessionKey,
  generateEphemeralKeyPair,
  importPeerPublicKey,
} from '../../src/crypto/ecdh';

async function newSessionKey(): Promise<CryptoKey> {
  const a = await generateEphemeralKeyPair();
  const b = await generateEphemeralKeyPair();
  return deriveSessionKey({
    myPrivateKey: a.privateKey,
    peerPublicKey: await importPeerPublicKey(b.publicKey),
    clientEphemPubKey: a.publicKey,
    desktopEphemPubKey: b.publicKey,
  });
}

describe('AES-GCM AEAD', () => {
  it('round-trips a plaintext', async () => {
    const key = await newSessionKey();
    const plaintext = new TextEncoder().encode('the quick brown fox');
    const { nonce, ciphertext } = await encrypt(key, DIRECTION_DESKTOP_TO_CLIENT, 0, plaintext);
    const decrypted = await decrypt(key, nonce, ciphertext);
    expect(new TextDecoder().decode(decrypted)).toBe('the quick brown fox');
  });

  it('rejects a tampered ciphertext', async () => {
    const key = await newSessionKey();
    const { nonce, ciphertext } = await encrypt(
      key,
      DIRECTION_DESKTOP_TO_CLIENT,
      0,
      new TextEncoder().encode('hello')
    );
    ciphertext[0] ^= 0xff;
    await expect(decrypt(key, nonce, ciphertext)).rejects.toThrow();
  });

  it('rejects a tampered nonce', async () => {
    const key = await newSessionKey();
    const { nonce, ciphertext } = await encrypt(
      key,
      DIRECTION_DESKTOP_TO_CLIENT,
      0,
      new TextEncoder().encode('hello')
    );
    nonce[0] ^= 0xff;
    await expect(decrypt(key, nonce, ciphertext)).rejects.toThrow();
  });

  it('rejects a wrong-length nonce', async () => {
    const key = await newSessionKey();
    await expect(decrypt(key, new Uint8Array(11), new Uint8Array(16))).rejects.toThrow(RangeError);
  });

  describe('buildNonce', () => {
    it('is 12 bytes', () => {
      expect(buildNonce(DIRECTION_DESKTOP_TO_CLIENT, 0).length).toBe(NONCE_BYTES);
    });

    it('encodes direction in byte 0 and seq big-endian in bytes 1..4', () => {
      const n = buildNonce(DIRECTION_CLIENT_TO_DESKTOP, 0x01020304);
      expect(n[0]).toBe(DIRECTION_CLIENT_TO_DESKTOP);
      expect(n[1]).toBe(0x01);
      expect(n[2]).toBe(0x02);
      expect(n[3]).toBe(0x03);
      expect(n[4]).toBe(0x04);
    });

    it('randomizes bytes 5..11 on each call', () => {
      // Statistical: random suffix should differ across calls. With 56 bits
      // of entropy a collision in two calls is ~2^-56.
      const a = buildNonce(DIRECTION_DESKTOP_TO_CLIENT, 0);
      const b = buildNonce(DIRECTION_DESKTOP_TO_CLIENT, 0);
      const sameSuffix = a.slice(5).every((v, i) => v === b[5 + i]);
      expect(sameSuffix).toBe(false);
    });

    it('rejects out-of-range seq', () => {
      expect(() => buildNonce(DIRECTION_DESKTOP_TO_CLIENT, -1)).toThrow(RangeError);
      expect(() => buildNonce(DIRECTION_DESKTOP_TO_CLIENT, 2 ** 32)).toThrow(RangeError);
      expect(() => buildNonce(DIRECTION_DESKTOP_TO_CLIENT, 1.5)).toThrow(RangeError);
    });
  });
});
