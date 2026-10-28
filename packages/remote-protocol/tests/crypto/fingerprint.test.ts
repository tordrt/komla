import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';

import {
  FINGERPRINT_HEX_LENGTH,
  fingerprintFromPublicKey,
  isValidFingerprint,
} from '../../src/crypto/fingerprint';

describe('fingerprint', () => {
  it('FINGERPRINT_HEX_LENGTH is 64 chars (SHA-256 → 32 bytes → 64 hex)', () => {
    expect(FINGERPRINT_HEX_LENGTH).toBe(64);
  });

  describe('isValidFingerprint', () => {
    it('accepts canonical lowercase 64-char hex', () => {
      expect(isValidFingerprint('a'.repeat(64))).toBe(true);
      expect(isValidFingerprint('0123456789abcdef'.repeat(4))).toBe(true);
    });

    it('rejects uppercase hex', () => {
      expect(isValidFingerprint('A'.repeat(64))).toBe(false);
    });

    it('rejects wrong length', () => {
      expect(isValidFingerprint('a'.repeat(63))).toBe(false);
      expect(isValidFingerprint('a'.repeat(65))).toBe(false);
      expect(isValidFingerprint('')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isValidFingerprint('g'.repeat(64))).toBe(false);
      expect(isValidFingerprint(`a${'a'.repeat(62)}!`)).toBe(false);
    });
  });

  describe('fingerprintFromPublicKey', () => {
    it('matches Node createHash sha256 over the SPKI bytes', async () => {
      // Ground truth: derive the same fingerprint two ways and assert they
      // agree. The desktop's install-identity service uses the Node path; this
      // package uses WebCrypto. They MUST produce identical output for every
      // key — that's the whole point of consolidating into one source of truth.
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const spki = publicKey.export({ format: 'der', type: 'spki' });
      const expected = createHash('sha256').update(spki).digest('hex');

      const got = await fingerprintFromPublicKey(spki);
      expect(got).toBe(expected);
      expect(got).toMatch(/^[0-9a-f]{64}$/);
    });

    it('accepts both ArrayBuffer and Uint8Array input', async () => {
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const spkiBuf = publicKey.export({ format: 'der', type: 'spki' });
      const spkiU8 = new Uint8Array(spkiBuf);
      const spkiAB = spkiU8.slice().buffer;

      const fromU8 = await fingerprintFromPublicKey(spkiU8);
      const fromAB = await fingerprintFromPublicKey(spkiAB);
      expect(fromU8).toBe(fromAB);
    });

    it('produces different fingerprints for different keys', async () => {
      const a = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
        format: 'der',
        type: 'spki',
      });
      const b = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
        format: 'der',
        type: 'spki',
      });
      expect(await fingerprintFromPublicKey(a)).not.toBe(await fingerprintFromPublicKey(b));
    });
  });
});
