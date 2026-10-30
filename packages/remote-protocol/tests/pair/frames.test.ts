// Schema-level coverage for the pair / remote-control frames. The desktop
// service trusts `parsePairFrame` to reject anything off-shape, so the
// thoroughness of these checks is part of the trust boundary.

import { describe, expect, it } from 'vitest';

import { PAIR_PROTOCOL_VERSION, parsePairFrame } from '../../src/pair/frames';

describe('parsePairFrame — pair:hello', () => {
  it('accepts a register hello with a high-entropy secret and device key', () => {
    const f = parsePairFrame({
      type: 'pair:hello',
      protocolVersion: PAIR_PROTOCOL_VERSION,
      mode: 'register',
      pairingSecret: 'A'.repeat(43),
      proposedLabel: 'Chrome on macOS',
      devicePublicKey: 'QUFBQQ==',
    });
    expect(f).toEqual({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'register',
      pairingSecret: 'A'.repeat(43),
      proposedLabel: 'Chrome on macOS',
      devicePublicKey: 'QUFBQQ==',
    });
  });

  it('accepts an authenticate hello with a trusted device id', () => {
    const f = parsePairFrame({
      type: 'pair:hello',
      protocolVersion: PAIR_PROTOCOL_VERSION,
      mode: 'authenticate',
      deviceId: 'a'.repeat(64),
    });
    expect(f?.type).toBe('pair:hello');
    if (f?.type === 'pair:hello') {
      expect(f.mode).toBe('authenticate');
    }
  });

  it('accepts a resume hello only with a full-length rotating token', () => {
    expect(
      parsePairFrame({
        type: 'pair:hello',
        protocolVersion: PAIR_PROTOCOL_VERSION,
        mode: 'resume',
        deviceId: 'a'.repeat(64),
        resumeToken: 'B'.repeat(43),
      })
    ).toMatchObject({ mode: 'resume' });
    expect(
      parsePairFrame({
        type: 'pair:hello',
        protocolVersion: PAIR_PROTOCOL_VERSION,
        mode: 'resume',
        deviceId: 'a'.repeat(64),
        resumeToken: 'short',
      })
    ).toBeNull();
  });

  it("accepts a passkey hello only with the browser's sign-in key and no device id", () => {
    const hello = {
      type: 'pair:hello',
      protocolVersion: PAIR_PROTOCOL_VERSION,
      mode: 'passkey',
      devicePublicKey: 'AAAA',
      capabilities: ['binary-frames'],
    };
    expect(parsePairFrame(hello)).toMatchObject({ mode: 'passkey' });
    expect(parsePairFrame({ ...hello, devicePublicKey: undefined })).toBeNull();
    expect(parsePairFrame({ ...hello, deviceId: 'a'.repeat(64) })).toBeNull();
  });

  it('accepts an auth challenge that names no passkey, for a passkey sign-in', () => {
    expect(
      parsePairFrame({
        type: 'pair:auth-challenge',
        challenge: 'c',
        rpId: 'mac.tail1.ts.net',
        origin: 'https://mac.tail1.ts.net',
      })
    ).toMatchObject({ type: 'pair:auth-challenge' });
  });

  it('rejects a register hello missing pairingSecret', () => {
    expect(
      parsePairFrame({
        type: 'pair:hello',
        protocolVersion: PAIR_PROTOCOL_VERSION,
        mode: 'register',
        proposedLabel: 'no secret',
        devicePublicKey: 'QUFBQQ==',
      })
    ).toBeNull();
  });

  it('rejects an authenticate hello with stray fields', () => {
    // strict() on the variant rejects extra keys — protects against a
    // confused browser smuggling fields the desktop didn't expect.
    expect(
      parsePairFrame({
        type: 'pair:hello',
        protocolVersion: PAIR_PROTOCOL_VERSION,
        mode: 'authenticate',
        deviceId: 'a'.repeat(64),
        pairingSecret: 'A'.repeat(43),
      })
    ).toBeNull();
  });

  it('carries capabilities in the hello and the reply, and the build in the reply', () => {
    const hello = {
      type: 'pair:hello',
      protocolVersion: PAIR_PROTOCOL_VERSION,
      mode: 'authenticate',
      deviceId: 'a'.repeat(64),
      capabilities: ['binary-frames', 'from-the-future'],
    };
    expect(parsePairFrame(hello)).toEqual(hello);
    expect(parsePairFrame({ ...hello, capabilities: ['x'.repeat(65)] })).toBeNull();
    expect(parsePairFrame({ ...hello, capabilities: Array(33).fill('x') })).toBeNull();

    const authenticated = {
      type: 'pair:authenticated',
      deviceId: 'a'.repeat(64),
      credentialId: 'cred',
      label: 'iPhone',
      capabilities: ['binary-frames'],
      build: '0f3c9a2e-5c4b-4d1e-9a8f-2b7c6d5e4f3a',
    };
    expect(parsePairFrame(authenticated)).toEqual(authenticated);
  });

  it('rejects an unsupported mode discriminator', () => {
    expect(
      parsePairFrame({
        type: 'pair:hello',
        protocolVersion: PAIR_PROTOCOL_VERSION,
        mode: 'something-else',
      })
    ).toBeNull();
  });

  it('rejects a wrong protocolVersion literal', () => {
    expect(
      parsePairFrame({
        type: 'pair:hello',
        protocolVersion: 1,
        mode: 'authenticate',
        deviceId: 'a'.repeat(64),
      })
    ).toBeNull();
  });
});

describe('parsePairFrame — auth challenge / response / authenticated', () => {
  it('accepts a well-formed auth challenge', () => {
    const f = parsePairFrame({
      type: 'pair:auth-challenge',
      challenge: 'AAAA',
      rpId: 'relay.example',
      origin: 'https://relay.example',
      credentialId: 'cred',
    });
    expect(f?.type).toBe('pair:auth-challenge');
  });

  it('accepts a well-formed auth response', () => {
    const f = parsePairFrame({
      type: 'pair:auth-response',
      authenticationResponse: {
        id: 'cred',
        rawId: 'cred',
        type: 'public-key',
        response: {
          clientDataJSON: 'cdj',
          authenticatorData: 'ad',
          signature: 'sig',
          userHandle: 'uh',
        },
      },
      deviceSignature: 'QUFBQQ==',
    });
    expect(f?.type).toBe('pair:auth-response');
  });

  it('rejects an auth response missing required response fields', () => {
    expect(
      parsePairFrame({
        type: 'pair:auth-response',
        authenticationResponse: {
          id: 'cred',
          rawId: 'cred',
          type: 'public-key',
          response: { clientDataJSON: 'cdj' },
        },
      })
    ).toBeNull();
  });

  it('accepts pair:authenticated', () => {
    const f = parsePairFrame({
      type: 'pair:authenticated',
      deviceId: 'a'.repeat(64),
      credentialId: 'cred',
      label: 'Chrome on macOS',
    });
    expect(f?.type).toBe('pair:authenticated');
  });

  it('accepts resume challenge, response, and rotated grant', () => {
    expect(parsePairFrame({ type: 'pair:resume-challenge', challenge: 'AAAA' })).toMatchObject({
      type: 'pair:resume-challenge',
    });
    expect(
      parsePairFrame({ type: 'pair:resume-response', deviceSignature: 'QUFBQQ==' })
    ).toMatchObject({ type: 'pair:resume-response' });
    expect(
      parsePairFrame({
        type: 'pair:authenticated',
        deviceId: 'a'.repeat(64),
        credentialId: 'cred',
        label: 'Phone',
        resumeToken: 'B'.repeat(43),
        resumeExpiresAt: Date.now() + 60_000,
      })
    ).toMatchObject({ type: 'pair:authenticated', resumeToken: 'B'.repeat(43) });
  });
});

describe('parsePairFrame — pair:rejected', () => {
  it.each([
    'pairing-secret-invalid',
    'unsupported-mode',
    'attestation-invalid',
    'duplicate-credential',
    'protocol-version-mismatch',
    'unknown-credential',
    'unknown-device',
    'device-signature-failed',
    'signature-failed',
    'counter-regression',
    'not-paired',
    'resume-invalid',
    'internal',
  ])('accepts reason=%s', (reason) => {
    const f = parsePairFrame({
      type: 'pair:rejected',
      reason,
      message: 'because',
    });
    expect(f?.type).toBe('pair:rejected');
  });

  it('rejects an unknown reason', () => {
    expect(
      parsePairFrame({
        type: 'pair:rejected',
        reason: 'some-future-reason',
        message: 'because',
      })
    ).toBeNull();
  });
});
