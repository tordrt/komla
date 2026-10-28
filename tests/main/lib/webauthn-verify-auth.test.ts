// Unit tests for the auth-side WebAuthn wrapper. We exercise the happy path
// and the two failure tokens we surface to the protocol layer
// (`signature-failed`, `counter-regression`) using a real registration +
// assertion produced by the fake authenticator — same primitive the ceremony
// integration test uses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyRegistration } from '../../../src/main/lib/webauthn-verify';
import { verifyAuthentication } from '../../../src/main/lib/webauthn-verify-auth';
import { fakeAuthenticate, fakeRegister } from '../../helpers/fake-authenticator';

import type { KeyObject } from 'crypto';

const RP_ID = 'relay.example';
const ORIGIN = 'https://relay.example';

interface RegisteredFixture {
  storedCredential: {
    credentialId: string;
    publicKey: string;
    signCounter: number;
    transports: string[] | null;
  };
  privateKey: KeyObject;
  credentialIdBytes: Uint8Array;
}

async function registerFixture(): Promise<RegisteredFixture> {
  const reg = fakeRegister({
    rpId: RP_ID,
    origin: ORIGIN,
    challenge: 'reg-challenge',
    signCount: 0,
  });
  const verified = await verifyRegistration({
    attestationResponse: reg.response,
    expectedChallenge: 'reg-challenge',
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  if (!verified.ok) throw new Error('registration fixture failed');
  return {
    storedCredential: {
      credentialId: verified.credential.credentialId,
      publicKey: verified.credential.publicKey,
      signCounter: verified.credential.signCounter,
      transports: verified.credential.transports,
    },
    privateKey: reg.privateKey,
    credentialIdBytes: reg.credentialIdBytes,
  };
}

describe('verifyAuthentication', () => {
  let fx: RegisteredFixture;

  beforeEach(async () => {
    fx = await registerFixture();
  });

  afterEach(() => {
    // Nothing to clean — the fake authenticator is stateless.
  });

  it('accepts a fresh assertion and returns the new counter', async () => {
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: 'auth-challenge',
      signCount: 1,
      credentialId: fx.credentialIdBytes,
      privateKey: fx.privateKey,
    });
    const result = await verifyAuthentication({
      authenticationResponse: auth.response,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      storedCredential: fx.storedCredential,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newCounter).toBe(1);
      expect(result.credentialId).toBe(fx.storedCredential.credentialId);
    }
  });

  it('rejects an assertion without user verification', async () => {
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: 'auth-challenge',
      signCount: 1,
      credentialId: fx.credentialIdBytes,
      privateKey: fx.privateKey,
      userVerified: false,
    });
    const result = await verifyAuthentication({
      authenticationResponse: auth.response,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      storedCredential: fx.storedCredential,
    });

    expect(result.ok).toBe(false);
  });

  it('accepts the all-zero counter case (authenticator does not increment)', async () => {
    // Stored=0, new=0 must not be treated as regression.
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: 'auth-challenge',
      signCount: 0,
      credentialId: fx.credentialIdBytes,
      privateKey: fx.privateKey,
    });
    const result = await verifyAuthentication({
      authenticationResponse: auth.response,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      storedCredential: { ...fx.storedCredential, signCounter: 0 },
    });
    expect(result.ok).toBe(true);
  });

  it('flags counter regression when the new counter does not advance', async () => {
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: 'auth-challenge',
      signCount: 5,
      credentialId: fx.credentialIdBytes,
      privateKey: fx.privateKey,
    });
    // Stored=5; new=5 — non-monotonic. The wrapper suppresses the library's
    // own regression check and runs its own so the protocol-level
    // `counter-regression` reason actually surfaces.
    const result = await verifyAuthentication({
      authenticationResponse: auth.response,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      storedCredential: { ...fx.storedCredential, signCounter: 5 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('counter-regression');
    }
  });

  it('flags counter regression when an authenticator resets to zero', async () => {
    // Stored=5; new=0 — the firmware-reset edge case. The library's check
    // would catch this too (counter > 0 && newCounter <= counter), but we
    // care that our wrapper emits the right reason token regardless.
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: 'auth-challenge',
      signCount: 0,
      credentialId: fx.credentialIdBytes,
      privateKey: fx.privateKey,
    });
    const result = await verifyAuthentication({
      authenticationResponse: auth.response,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      storedCredential: { ...fx.storedCredential, signCounter: 5 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('counter-regression');
    }
  });

  it('rejects an assertion bound to a different challenge', async () => {
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: 'wrong',
      signCount: 1,
      credentialId: fx.credentialIdBytes,
      privateKey: fx.privateKey,
    });
    const result = await verifyAuthentication({
      authenticationResponse: auth.response,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      storedCredential: fx.storedCredential,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-failed');
  });

  it('rejects an assertion against a different stored credential', async () => {
    const otherFx = await registerFixture();
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: 'auth-challenge',
      signCount: 1,
      credentialId: fx.credentialIdBytes,
      privateKey: fx.privateKey,
    });
    // Verifying with the *wrong* stored public key — signature won't verify.
    const result = await verifyAuthentication({
      authenticationResponse: auth.response,
      expectedChallenge: 'auth-challenge',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      storedCredential: otherFx.storedCredential,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-failed');
  });
});
