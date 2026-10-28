import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

import { verifySignature } from '../../src/crypto/signature';

function signP256(
  data: Uint8Array,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
) {
  return new Uint8Array(nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}

function freshKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function spkiOf(pub: ReturnType<typeof generateKeyPairSync>['publicKey']): Uint8Array {
  return new Uint8Array(pub.export({ format: 'der', type: 'spki' }));
}

describe('verifySignature', () => {
  it('accepts a valid signature from the matching key', async () => {
    const { publicKey, privateKey } = freshKeyPair();
    const data = new TextEncoder().encode('the data');
    const sig = signP256(data, privateKey);
    expect(await verifySignature(data, sig, spkiOf(publicKey))).toBe(true);
  });

  it('rejects a signature from a different keypair', async () => {
    const { privateKey } = freshKeyPair();
    const { publicKey: other } = freshKeyPair();
    const data = new TextEncoder().encode('the data');
    const sig = signP256(data, privateKey);
    expect(await verifySignature(data, sig, spkiOf(other))).toBe(false);
  });

  it('rejects when data has been tampered', async () => {
    const { publicKey, privateKey } = freshKeyPair();
    const data = new TextEncoder().encode('the data');
    const sig = signP256(data, privateKey);
    const tampered = new TextEncoder().encode('the dat!');
    expect(await verifySignature(tampered, sig, spkiOf(publicKey))).toBe(false);
  });

  it('rejects when signature has been tampered', async () => {
    const { publicKey, privateKey } = freshKeyPair();
    const data = new TextEncoder().encode('the data');
    const sig = signP256(data, privateKey);
    sig[0] ^= 0xff;
    expect(await verifySignature(data, sig, spkiOf(publicKey))).toBe(false);
  });

  it('rejects malformed SPKI without throwing', async () => {
    const data = new TextEncoder().encode('x');
    const garbage = new Uint8Array(64);
    expect(await verifySignature(data, new Uint8Array(64), garbage)).toBe(false);
  });

  it('rejects a non-P256 (P-384) public key without throwing', async () => {
    // Algorithm pinning: even if a caller supplies a perfectly valid SPKI for
    // a different curve, importKey rejects it under our pinned params and we
    // return false.
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const data = new TextEncoder().encode('x');
    expect(await verifySignature(data, new Uint8Array(64), spkiOf(publicKey))).toBe(false);
  });
});
