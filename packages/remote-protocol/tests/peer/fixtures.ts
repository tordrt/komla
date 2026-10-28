// Shared test fixture: an in-memory ECDSA-P256 install identity with a sign
// callback shaped exactly like what the desktop's install-identity service
// gives the Peer.

import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';

import { fingerprintFromPublicKey } from '../../src/crypto/fingerprint';

export interface FakeInstallIdentity {
  publicKey: Uint8Array; // SPKI-DER
  fingerprint: string; // hex sha256(publicKey)
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** Underlying private KeyObject — exposed only for tests that need to
   *  produce a wrong/forged signature. */
  _privateKey: KeyObject;
}

export async function createFakeInstallIdentity(): Promise<FakeInstallIdentity> {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
  const fingerprint = await fingerprintFromPublicKey(spki);
  return {
    publicKey: spki,
    fingerprint,
    _privateKey: privateKey,
    async sign(data) {
      return new Uint8Array(
        nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })
      );
    },
  };
}
