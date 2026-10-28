import { fingerprintFromPublicKey } from './fingerprint';
import { verifySignature } from './signature';
import { concatLengthPrefixed } from './transcript';

const DEVICE_KEY_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const DEVICE_PROOF_CONTEXT = new TextEncoder().encode('komla/trusted-remote-device/v2');

export type DeviceProofPurpose = 'register' | 'authenticate' | 'resume';

export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(DEVICE_KEY_PARAMS, false, ['sign', 'verify']);
}

export async function exportDevicePublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.exportKey('spki', publicKey));
}

export function deviceIdFromPublicKey(publicKey: Uint8Array): Promise<string> {
  return fingerprintFromPublicKey(publicKey);
}

export function buildDeviceProof(
  purpose: DeviceProofPurpose,
  challenge: string,
  channelBinding: Uint8Array
): Uint8Array {
  if (channelBinding.length !== 32) {
    throw new RangeError(`channel binding must be 32 bytes, got ${channelBinding.length}`);
  }
  return concatLengthPrefixed([
    DEVICE_PROOF_CONTEXT,
    new TextEncoder().encode(purpose),
    new TextEncoder().encode(challenge),
    channelBinding,
  ]);
}

export async function signDeviceProof(
  privateKey: CryptoKey,
  proof: Uint8Array
): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      proof as BufferSource
    )
  );
}

export function verifyDeviceProof(
  publicKey: Uint8Array,
  proof: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  return verifySignature(proof, signature, publicKey);
}
