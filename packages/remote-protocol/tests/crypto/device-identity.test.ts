import { describe, expect, it } from 'vitest';

import {
  buildDeviceProof,
  deviceIdFromPublicKey,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  signDeviceProof,
  verifyDeviceProof,
} from '../../src/crypto/device-identity';

describe('trusted remote device identity', () => {
  it('generates a non-exportable private key with a stable public-key id', async () => {
    const pair = await generateDeviceKeyPair();
    const publicKey = await exportDevicePublicKey(pair.publicKey);

    expect(pair.privateKey.extractable).toBe(false);
    expect(await deviceIdFromPublicKey(publicKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(await deviceIdFromPublicKey(publicKey)).toBe(await deviceIdFromPublicKey(publicKey));
  });

  it('signs a proof bound to purpose, challenge, and encrypted channel', async () => {
    const pair = await generateDeviceKeyPair();
    const publicKey = await exportDevicePublicKey(pair.publicKey);
    const binding = new Uint8Array(32).fill(7);
    const proof = buildDeviceProof('authenticate', 'challenge', binding);
    const signature = await signDeviceProof(pair.privateKey, proof);

    await expect(verifyDeviceProof(publicKey, proof, signature)).resolves.toBe(true);
    await expect(
      verifyDeviceProof(publicKey, buildDeviceProof('register', 'challenge', binding), signature)
    ).resolves.toBe(false);
    await expect(
      verifyDeviceProof(
        publicKey,
        buildDeviceProof('authenticate', 'challenge', new Uint8Array(32)),
        signature
      )
    ).resolves.toBe(false);
  });
});
