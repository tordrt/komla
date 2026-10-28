import { describe, it, expect } from 'vitest';

import { encodeBase64 } from '../../src/wire/encoding';
import { MAX_FRAME_CHARS, parseFrame } from '../../src/wire/messages';

const validBase64 = encodeBase64(new Uint8Array([1, 2, 3, 4]));

describe('parseFrame', () => {
  it('parses a well-formed e2e:offer', () => {
    const raw = JSON.stringify({ type: 'e2e:offer', ephemeralPubkey: validBase64 });
    const frame = parseFrame(raw);
    expect(frame?.type).toBe('e2e:offer');
    if (frame?.type === 'e2e:offer') expect(frame.ephemeralPubkey).toBe(validBase64);
  });

  it('parses a well-formed e2e:answer', () => {
    const raw = JSON.stringify({
      type: 'e2e:answer',
      ephemeralPubkey: validBase64,
      installPubkey: validBase64,
      signature: validBase64,
    });
    expect(parseFrame(raw)?.type).toBe('e2e:answer');
  });

  it('parses a well-formed e2e:enc', () => {
    const raw = JSON.stringify({
      type: 'e2e:enc',
      seq: 42,
      nonce: validBase64,
      ciphertext: validBase64,
    });
    const frame = parseFrame(raw);
    expect(frame?.type).toBe('e2e:enc');
    if (frame?.type === 'e2e:enc') expect(frame.seq).toBe(42);
  });

  describe('rejects malformed input', () => {
    it('non-JSON', () => {
      expect(parseFrame('not json')).toBeNull();
    });

    it('JSON but not an object', () => {
      expect(parseFrame('null')).toBeNull();
      expect(parseFrame('[]')).toBeNull();
      expect(parseFrame('"string"')).toBeNull();
    });

    it('unknown type discriminant', () => {
      expect(parseFrame(JSON.stringify({ type: 'e2e:unknown' }))).toBeNull();
    });

    it('missing required field', () => {
      expect(parseFrame(JSON.stringify({ type: 'e2e:offer' }))).toBeNull();
      expect(
        parseFrame(JSON.stringify({ type: 'e2e:answer', ephemeralPubkey: validBase64 }))
      ).toBeNull();
    });

    it('wrong-typed field', () => {
      expect(parseFrame(JSON.stringify({ type: 'e2e:offer', ephemeralPubkey: 123 }))).toBeNull();
      expect(
        parseFrame(
          JSON.stringify({
            type: 'e2e:enc',
            seq: 'one',
            nonce: validBase64,
            ciphertext: validBase64,
          })
        )
      ).toBeNull();
    });

    it('seq out of 32-bit unsigned range', () => {
      expect(
        parseFrame(
          JSON.stringify({
            type: 'e2e:enc',
            seq: -1,
            nonce: validBase64,
            ciphertext: validBase64,
          })
        )
      ).toBeNull();
      expect(
        parseFrame(
          JSON.stringify({
            type: 'e2e:enc',
            seq: 2 ** 32,
            nonce: validBase64,
            ciphertext: validBase64,
          })
        )
      ).toBeNull();
      expect(
        parseFrame(
          JSON.stringify({
            type: 'e2e:enc',
            seq: 1.5,
            nonce: validBase64,
            ciphertext: validBase64,
          })
        )
      ).toBeNull();
    });

    it('invalid base64 in a binary field', () => {
      expect(
        parseFrame(JSON.stringify({ type: 'e2e:offer', ephemeralPubkey: 'not-b64!' }))
      ).toBeNull();
    });

    it('oversized frame', () => {
      const big = 'x'.repeat(MAX_FRAME_CHARS + 1);
      expect(parseFrame(big)).toBeNull();
    });

    // The schemas are .strict() so unknown keys are rejected outright. This
    // keeps the door closed on downgrade ambiguity if a future protocol
    // revision adds a field — older peers must reject it, not silently drop
    // it.
    it('extra field on e2e:offer', () => {
      expect(
        parseFrame(
          JSON.stringify({ type: 'e2e:offer', ephemeralPubkey: validBase64, extra: 'nope' })
        )
      ).toBeNull();
    });

    it('extra field on e2e:answer', () => {
      expect(
        parseFrame(
          JSON.stringify({
            type: 'e2e:answer',
            ephemeralPubkey: validBase64,
            installPubkey: validBase64,
            signature: validBase64,
            extra: 'nope',
          })
        )
      ).toBeNull();
    });

    it('extra field on e2e:enc', () => {
      expect(
        parseFrame(
          JSON.stringify({
            type: 'e2e:enc',
            seq: 0,
            nonce: validBase64,
            ciphertext: validBase64,
            extra: 'nope',
          })
        )
      ).toBeNull();
    });
  });
});
