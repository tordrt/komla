// Unit tests for the browser pair page's WebAuthn conversion helpers.
//
// These shape the JSON the desktop's `verifyRegistrationResponse` consumes.
// The desktop ceremony tests (in the root `tests/` tree) bypass this code
// entirely by using a synthetic authenticator, so a regression here would
// silently break real-browser pairing while every desktop test still passed.

import { describe, expect, it } from 'vitest';

import {
  assertionToJSON,
  attestationToJSON,
  base64UrlToBytes,
  bytesToBase64Url,
  userHandleToFingerprint,
} from '../webauthn';

describe('base64UrlToBytes', () => {
  it('decodes the empty string to a zero-length buffer', () => {
    const out = base64UrlToBytes('');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(0);
  });

  it('decodes RFC 4648 §5 base64url, including the URL-safe alphabet', () => {
    // Bytes 0xfb 0xff produce '+/' in standard base64 and '-_' in base64url.
    const out = base64UrlToBytes('-_8');
    expect(Array.from(out)).toEqual([0xfb, 0xff]);
  });

  it('decodes inputs that need 1 padding char', () => {
    // 'AAA' (3 chars) decodes to 2 bytes when padded to 'AAA='.
    const out = base64UrlToBytes('AAA');
    expect(Array.from(out)).toEqual([0x00, 0x00]);
  });

  it('decodes inputs that need 2 padding chars', () => {
    // 'AQ' (2 chars) → 'AQ==' → 0x01.
    const out = base64UrlToBytes('AQ');
    expect(Array.from(out)).toEqual([0x01]);
  });

  it('returns a buffer typed to plain ArrayBuffer (not SharedArrayBuffer)', () => {
    // Compile-time guarantee that the result satisfies WebAuthn's
    // BufferSource. At runtime this is enough to verify the buffer backs a
    // standard ArrayBuffer.
    const out = base64UrlToBytes('AA');
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
  });
});

describe('bytesToBase64Url', () => {
  it('encodes the empty buffer to the empty string', () => {
    expect(bytesToBase64Url(new Uint8Array(0))).toBe('');
  });

  it('emits the URL-safe alphabet without padding', () => {
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('strips trailing = padding from short inputs', () => {
    expect(bytesToBase64Url(new Uint8Array([0x01]))).toBe('AQ');
    expect(bytesToBase64Url(new Uint8Array([0x00, 0x00]))).toBe('AAA');
  });

  it('accepts a raw ArrayBuffer', () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03]).buffer;
    expect(bytesToBase64Url(buf)).toBe('AQID');
  });
});

describe('base64Url round-trip', () => {
  it('survives every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const encoded = bytesToBase64Url(all);
    const decoded = base64UrlToBytes(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(all));
  });

  it('survives at every length 0..32 (covers each padding case)', () => {
    for (let len = 0; len <= 32; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const decoded = base64UrlToBytes(bytesToBase64Url(bytes));
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    }
  });
});

describe('attestationToJSON', () => {
  // Minimal stand-in for `PublicKeyCredential`; the helper only touches the
  // fields enumerated here. Constructing one without a DOM keeps the test in
  // a Node environment.
  function fakeCredential(opts: {
    id: string;
    rawId: number[];
    clientDataJSON: number[];
    attestationObject: number[];
    transports?: string[];
    authenticatorAttachment?: string | null;
    extensions?: Record<string, unknown>;
  }): PublicKeyCredential {
    return {
      id: opts.id,
      rawId: new Uint8Array(opts.rawId).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array(opts.clientDataJSON).buffer,
        attestationObject: new Uint8Array(opts.attestationObject).buffer,
        getTransports: opts.transports ? () => opts.transports! : undefined,
      },
      authenticatorAttachment: opts.authenticatorAttachment ?? null,
      getClientExtensionResults: () => opts.extensions ?? {},
    } as unknown as PublicKeyCredential;
  }

  it('emits the canonical RegistrationResponseJSON shape', () => {
    const out = attestationToJSON(
      fakeCredential({
        id: 'cred-id',
        rawId: [0xab, 0xcd, 0xef],
        clientDataJSON: [0x01, 0x02],
        attestationObject: [0x10, 0x20, 0x30],
        transports: ['usb', 'nfc'],
        authenticatorAttachment: 'platform',
        extensions: { credProps: { rk: true } },
      })
    );

    expect(out).toEqual({
      id: 'cred-id',
      rawId: 'q83v',
      type: 'public-key',
      response: {
        clientDataJSON: 'AQI',
        attestationObject: 'ECAw',
        transports: ['usb', 'nfc'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
    });
  });

  it('falls back to an empty transports array when getTransports is missing', () => {
    const out = attestationToJSON(
      fakeCredential({
        id: 'no-transports',
        rawId: [1],
        clientDataJSON: [2],
        attestationObject: [3],
      })
    );
    expect((out.response as { transports: string[] }).transports).toEqual([]);
  });

  it('drops a null authenticatorAttachment to undefined (not present in JSON)', () => {
    const out = attestationToJSON(
      fakeCredential({
        id: 'no-attachment',
        rawId: [1],
        clientDataJSON: [2],
        attestationObject: [3],
        authenticatorAttachment: null,
      })
    );
    expect(out.authenticatorAttachment).toBeUndefined();
  });
});

describe('assertionToJSON', () => {
  function fakeAssertion(opts: {
    id: string;
    rawId: number[];
    clientDataJSON: number[];
    authenticatorData: number[];
    signature: number[];
    userHandle?: number[];
  }): PublicKeyCredential {
    return {
      id: opts.id,
      rawId: new Uint8Array(opts.rawId).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array(opts.clientDataJSON).buffer,
        authenticatorData: new Uint8Array(opts.authenticatorData).buffer,
        signature: new Uint8Array(opts.signature).buffer,
        userHandle: opts.userHandle ? new Uint8Array(opts.userHandle).buffer : null,
      },
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential;
  }

  it('emits the canonical AuthenticationResponseJSON shape with userHandle', () => {
    const out = assertionToJSON(
      fakeAssertion({
        id: 'cred',
        rawId: [0xab, 0xcd],
        clientDataJSON: [0x01],
        authenticatorData: [0x02],
        signature: [0x03],
        userHandle: [0xde, 0xad, 0xbe, 0xef],
      })
    );
    expect(out).toEqual({
      id: 'cred',
      rawId: 'q80',
      type: 'public-key',
      response: {
        clientDataJSON: 'AQ',
        authenticatorData: 'Ag',
        signature: 'Aw',
        userHandle: '3q2-7w',
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    });
  });

  it('drops userHandle to undefined when the authenticator did not provide one', () => {
    const out = assertionToJSON(
      fakeAssertion({
        id: 'cred',
        rawId: [1],
        clientDataJSON: [1],
        authenticatorData: [1],
        signature: [1],
      })
    );
    expect((out.response as { userHandle?: unknown }).userHandle).toBeUndefined();
  });
});

describe('userHandleToFingerprint', () => {
  it('decodes a 32-byte userHandle into the 64-hex install fingerprint', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    expect(userHandleToFingerprint(bytes)).toBe(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    );
  });

  it('rejects a userHandle of the wrong length', () => {
    expect(userHandleToFingerprint(new Uint8Array(0))).toBeNull();
    expect(userHandleToFingerprint(new Uint8Array(31))).toBeNull();
    expect(userHandleToFingerprint(new Uint8Array(33))).toBeNull();
  });

  it('accepts an ArrayBuffer or a Uint8Array', () => {
    const buf = new ArrayBuffer(32);
    const view = new Uint8Array(buf);
    view.fill(0xff);
    expect(userHandleToFingerprint(buf)).toBe('f'.repeat(64));
    expect(userHandleToFingerprint(view)).toBe('f'.repeat(64));
  });
});
