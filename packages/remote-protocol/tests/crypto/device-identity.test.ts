import { describe, expect, it } from 'vitest';

import {
  buildDeviceProof,
  buildPasskeyChallenge,
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

  it('makes a passkey challenge bound to the challenge and encrypted channel', async () => {
    const binding = new Uint8Array(32).fill(7);
    const signed = await buildPasskeyChallenge('challenge', binding);

    expect(signed).toHaveLength(32);
    expect(signed).toEqual(await buildPasskeyChallenge('challenge', binding));
    expect(signed).not.toEqual(await buildPasskeyChallenge('other', binding));
    expect(signed).not.toEqual(await buildPasskeyChallenge('challenge', new Uint8Array(32)));
    await expect(buildPasskeyChallenge('challenge', new Uint8Array(31))).rejects.toThrow(RangeError);
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
