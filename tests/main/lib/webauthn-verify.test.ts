// Unit tests for the WebAuthn registration verifier. Drives the real
// @simplewebauthn/server through a synthetic authenticator, then exercises
// each negative path the desktop pair-ceremony handler branches on.

import { describe, expect, it } from 'vitest';

import { verifyRegistration } from '../../../src/main/lib/webauthn-verify';
import { fakeRegister } from '../../helpers/fake-authenticator';

const RP_ID = 'remote.example.com';
const ORIGIN = 'https://remote.example.com';

function challenge(): string {
  // Base64url 32 random bytes, like generateRegistrationOptions would emit.
  return Buffer.from(Array.from({ length: 32 }, (_, i) => (i + 13) & 0xff))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('verifyRegistration', () => {
  it('accepts a fresh registration and returns the credential record', async () => {
    const c = challenge();
    const { response } = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: c });

    const result = await verifyRegistration({
      attestationResponse: response,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.credentialId).toBe(response.id);
      expect(result.credential.publicKey.length).toBeGreaterThan(0);
      expect(result.credential.signCounter).toBe(0);
      expect(result.credential.transports).toEqual(['internal']);
      // All-zero AAGUID maps to null (no manufacturer claim).
      expect(result.credential.aaguid).toBeNull();
    }
  });

  it('reports a non-zero AAGUID', async () => {
    const c = challenge();
    const aaguid = new Uint8Array(16);
    aaguid[0] = 0xab; // any non-zero byte triggers the "real" AAGUID path
    const { response } = fakeRegister({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: c,
      aaguid,
    });

    const result = await verifyRegistration({
      attestationResponse: response,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.aaguid).not.toBeNull();
    }
  });

  it('rejects when the challenge does not match', async () => {
    const c = challenge();
    const { response } = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: c });

    const result = await verifyRegistration({
      attestationResponse: response,
      expectedChallenge: 'different-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attestation-invalid');
      expect(result.message.toLowerCase()).toContain('challenge');
    }
  });

  it('rejects when the origin does not match', async () => {
    const c = challenge();
    const { response } = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: c });

    const result = await verifyRegistration({
      attestationResponse: response,
      expectedChallenge: c,
      expectedOrigin: 'https://wrong.example.com',
      expectedRPID: RP_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attestation-invalid');
    }
  });

  it('rejects when the RP-ID does not match', async () => {
    const c = challenge();
    const { response } = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: c });

    const result = await verifyRegistration({
      attestationResponse: response,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      expectedRPID: 'other.example.com',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attestation-invalid');
    }
  });

  it('rejects registration without user verification', async () => {
    const c = challenge();
    const { response } = fakeRegister({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: c,
      userVerified: false,
    });

    const result = await verifyRegistration({
      attestationResponse: response,
      expectedChallenge: c,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a malformed attestation response object', async () => {
    const result = await verifyRegistration({
      attestationResponse: { not: 'a real attestation' },
      expectedChallenge: challenge(),
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attestation-invalid');
    }
  });
});
